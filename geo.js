// True-geometry support for Lift COG.
// Reads the model's IFC with web-ifc, then gives each selected element its real mesh so the
// extension can use the true centre of gravity and the real top surface (not bounding boxes).
// Everything runs in the user's browser – the model never leaves their machine.
// Works in the browser (window.GEO) and in Node (module.exports) for testing.
(function (root) {
  // ---------------- IFC GUIDs ----------------
  const CH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  /** 22-character IFC GlobalId from a 32-hex / 36-char GUID; passes 22-char ids through. */
  function ifcGuid(id) {
    const s = String(id || "").trim();
    if (/^[0-9A-Za-z_$]{22}$/.test(s)) return s;
    const hex = s.replace(/[{}-]/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) return null;
    const b = hex.match(/../g).map((h) => parseInt(h, 16));
    const enc = (v, len) => { let o = ""; for (let i = 0; i < len; i++) { o = CH[v % 64] + o; v = Math.floor(v / 64); } return o; };
    let out = enc(b[0], 2);
    for (let i = 1; i < 16; i += 3) out += enc((b[i] << 16) + (b[i + 1] << 8) + b[i + 2], 4);
    return out;
  }

  // ---------------- Model ----------------
  /**
   * Wraps an IFC opened in web-ifc. Meshes come back in model coordinates, metres, Z up
   * (web-ifc works Y-up internally: model X = x, Y = −z, Z = y).
   */
  class GeoModel {
    constructor(WebIFC, api, modelID) {
      this.WebIFC = WebIFC; this.api = api; this.mid = modelID;
      this.meshCache = new Map(); this.children = null;
    }

    static async open(WebIFC, api, bytes) {
      const mid = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 24 });
      if (mid < 0) throw new Error("This file couldn't be read as IFC.");
      return new GeoModel(WebIFC, api, mid);
    }

    expressIdFor(guid) {
      const g = ifcGuid(guid);
      if (!g) return null;
      const id = this.api.GetExpressIdFromGuid(this.mid, g);
      return id == null || id === "" ? null : Number(id);
    }

    // Assemblies have no geometry of their own – their parts do (IfcRelAggregates / IfcRelNests).
    partsOf(id) {
      if (!this.children) {
        this.children = new Map();
        for (const relType of [this.WebIFC.IFCRELAGGREGATES, this.WebIFC.IFCRELNESTS].filter(Boolean)) {
          const ids = this.api.GetLineIDsWithType(this.mid, relType);
          for (let i = 0; i < ids.size(); i++) {
            const rel = this.api.GetLine(this.mid, ids.get(i));
            const parent = rel.RelatingObject?.value;
            const kids = (rel.RelatedObjects || []).map((o) => o.value);
            if (parent != null) this.children.set(parent, (this.children.get(parent) || []).concat(kids));
          }
        }
      }
      return this.children.get(id) || [];
    }

    /** { pos: Float64Array [x,y,z,…] (world, metres, Z up), idx: Uint32Array } or null. */
    mesh(id, depth = 0) {
      if (this.meshCache.has(id)) return this.meshCache.get(id);
      const pos = [], idx = [];
      const fm = this.api.GetFlatMesh(this.mid, id);
      for (let g = 0; g < fm.geometries.size(); g++) {
        const pg = fm.geometries.get(g);
        const geom = this.api.GetGeometry(this.mid, pg.geometryExpressID);
        const v = this.api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const ix = this.api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const m = pg.flatTransformation, base = pos.length / 3;
        for (let i = 0; i < v.length; i += 6) {
          const x = v[i], y = v[i + 1], z = v[i + 2];
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          pos.push(wx, -wz, wy); // Y-up → Z-up
        }
        for (let i = 0; i < ix.length; i++) idx.push(base + ix[i]);
        geom.delete?.();
      }
      let out = pos.length ? { pos: Float64Array.from(pos), idx: Uint32Array.from(idx) } : null;
      if (!out && depth < 4) {
        const parts = this.partsOf(id).map((k) => this.mesh(k, depth + 1)).filter(Boolean);
        if (parts.length) out = mergeMeshes(parts);
      }
      this.meshCache.set(id, out);
      return out;
    }

    close() { try { this.api.CloseModel(this.mid); } catch (e) { /* ignore */ } }
  }

  function mergeMeshes(list) {
    const nv = list.reduce((a, m) => a + m.pos.length, 0), ni = list.reduce((a, m) => a + m.idx.length, 0);
    const pos = new Float64Array(nv), idx = new Uint32Array(ni);
    let pv = 0, pi = 0;
    for (const m of list) {
      pos.set(m.pos, pv);
      for (let i = 0; i < m.idx.length; i++) idx[pi + i] = m.idx[i] + pv / 3;
      pv += m.pos.length; pi += m.idx.length;
    }
    return { pos, idx };
  }

  // ---------------- Per-element measurements ----------------
  /** Bounding box, enclosed volume and volume centroid (true centre of gravity for uniform material). */
  function meshStats(mesh) {
    const P = mesh.pos, I = mesh.idx;
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let i = 0; i < P.length; i += 3) {
      if (P[i] < min.x) min.x = P[i]; if (P[i] > max.x) max.x = P[i];
      if (P[i + 1] < min.y) min.y = P[i + 1]; if (P[i + 1] > max.y) max.y = P[i + 1];
      if (P[i + 2] < min.z) min.z = P[i + 2]; if (P[i + 2] > max.z) max.z = P[i + 2];
    }
    // Signed tetrahedra about a nearby origin (keeps precision with site coordinates like 330 000 m).
    const ox = P[0], oy = P[1], oz = P[2];
    let V = 0, cx = 0, cy = 0, cz = 0;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ax = P[a] - ox, ay = P[a + 1] - oy, az = P[a + 2] - oz;
      const bx = P[b] - ox, by = P[b + 1] - oy, bz = P[b + 2] - oz;
      const qx = P[c] - ox, qy = P[c + 1] - oy, qz = P[c + 2] - oz;
      const v = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
      V += v; cx += v * (ax + bx + qx) / 4; cy += v * (ay + by + qy) / 4; cz += v * (az + bz + qz) / 4;
    }
    const volume = Math.abs(V);
    const centroid = Math.abs(V) > 1e-9 ? { x: ox + cx / V, y: oy + cy / V, z: oz + cz / V } : null;
    const inBox = centroid && ["x", "y", "z"].every((k) => centroid[k] >= min[k] - 0.01 && centroid[k] <= max[k] + 0.01);
    return { min, max, volume, centroid: inBox ? centroid : null };
  }

  // ---------------- Top-surface height map ----------------
  /**
   * Highest steel at each plan position over the given meshes. Cells are a few cm; thin parts
   * (plates on edge) are caught by also sampling triangle edges.
   */
  function buildHeightmap(meshes, opts = {}) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const m of meshes) for (let i = 0; i < m.pos.length; i += 3) {
      const x = m.pos[i], y = m.pos[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const span = Math.max(maxX - minX, maxY - minY, 0.1);
    let cell = opts.cell || Math.min(0.1, Math.max(0.01, span / 600));
    while (((maxX - minX) / cell + 3) * ((maxY - minY) / cell + 3) > 4e6) cell *= 1.25;
    const ox = minX - cell, oy = minY - cell;
    const nx = Math.ceil((maxX - minX) / cell) + 3, ny = Math.ceil((maxY - minY) / cell) + 3;
    const Z = new Float32Array(nx * ny).fill(-Infinity);
    // Heights stored relative to a base so float32 keeps mm precision at any elevation.
    let zBase = Infinity;
    for (const m of meshes) for (let i = 2; i < m.pos.length; i += 3) if (m.pos[i] < zBase) zBase = m.pos[i];
    const put = (x, y, z) => {
      const i = Math.floor((x - ox) / cell), j = Math.floor((y - oy) / cell);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return;
      const k = j * nx + i, zz = z - zBase;
      if (zz > Z[k]) Z[k] = zz;
    };
    for (const m of meshes) {
      const P = m.pos, I = m.idx;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const x1 = P[a], y1 = P[a + 1], z1 = P[a + 2], x2 = P[b], y2 = P[b + 1], z2 = P[b + 2], x3 = P[c], y3 = P[c + 1], z3 = P[c + 2];
        // Edges and corners (catches parts thinner than a cell).
        for (const [xa, ya, za, xb, yb, zb] of [[x1, y1, z1, x2, y2, z2], [x2, y2, z2, x3, y3, z3], [x3, y3, z3, x1, y1, z1]]) {
          const steps = Math.ceil(Math.hypot(xb - xa, yb - ya) / (cell * 0.5)) + 1;
          for (let s = 0; s <= steps; s++) { const u = s / steps; put(xa + (xb - xa) * u, ya + (yb - ya) * u, za + (zb - za) * u); }
        }
        // Interior: every cell centre inside the triangle in plan.
        const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
        if (Math.abs(d) < 1e-12) continue; // vertical face
        const i0 = Math.max(0, Math.floor((Math.min(x1, x2, x3) - ox) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(x1, x2, x3) - ox) / cell));
        const j0 = Math.max(0, Math.floor((Math.min(y1, y2, y3) - oy) / cell)), j1 = Math.min(ny - 1, Math.floor((Math.max(y1, y2, y3) - oy) / cell));
        for (let j = j0; j <= j1; j++) {
          const y = oy + (j + 0.5) * cell;
          for (let i = i0; i <= i1; i++) {
            const x = ox + (i + 0.5) * cell;
            const l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d;
            const l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
            const k = j * nx + i, zz = l1 * z1 + l2 * z2 + l3 * z3 - zBase;
            if (zz > Z[k]) Z[k] = zz;
          }
        }
      }
    }
    const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? -Infinity : Z[j * nx + i]);
    return {
      cell, ox, oy, nx, ny,
      /** Highest steel at (x, y), or null over empty space. */
      top(x, y) {
        const v = at(Math.floor((x - ox) / cell), Math.floor((y - oy) / cell));
        return v === -Infinity ? null : v + zBase;
      },
      /** Nearest plan position with steel, within maxR metres: { x, y, z, moved } or null. */
      nearest(x, y, maxR) {
        const ci = Math.floor((x - ox) / cell), cj = Math.floor((y - oy) / cell);
        const here = at(ci, cj);
        if (here !== -Infinity) return { x, y, z: here + zBase, moved: 0 };
        const R = Math.ceil(maxR / cell);
        let best = null;
        for (let r = 1; r <= R; r++) {
          for (let di = -r; di <= r; di++) for (const dj of di === -r || di === r ? range(-r, r) : [-r, r]) {
            const v = at(ci + di, cj + dj);
            if (v === -Infinity) continue;
            const px = ox + (ci + di + 0.5) * cell, py = oy + (cj + dj + 0.5) * cell, dist = Math.hypot(px - x, py - y);
            if (!best || dist < best.moved) best = { x: px, y: py, z: v + zBase, moved: dist };
          }
          if (best && best.moved <= r * cell) break; // nothing closer can appear in later rings
        }
        return best && best.moved <= maxR ? best : null;
      },
      /** Plan centres of all cells with steel (for the load's main direction). */
      filled() {
        const out = [];
        const step = Math.max(1, Math.round(Math.sqrt((nx * ny) / 40000)));
        for (let j = 0; j < ny; j += step) for (let i = 0; i < nx; i += step) if (Z[j * nx + i] !== -Infinity) out.push([ox + (i + 0.5) * cell, oy + (j + 0.5) * cell]);
        return out;
      },
    };
  }
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  // ---------------- Lifting points on the real geometry ----------------
  /**
   * Lays points out with the usual rules (symmetric about the COG, on members where the centre is
   * open), aligned to the load's main direction in plan, then moves every point onto real steel
   * using the height map. If moving breaks the balance, tighter patterns are tried and the best
   * balanced, stable one is kept.
   * elems: [{ mesh }]  (meshes of the selected elements)
   */
  function planWithGeometry({ C, cog, elems, hm, n, layout = "auto", totalKg }) {
    // Main direction: principal axis of the steel in plan.
    const cells = hm.filled();
    let mx = 0, my = 0;
    for (const [x, y] of cells) { mx += x; my += y; }
    mx /= cells.length || 1; my /= cells.length || 1;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of cells) { const a = x - mx, b = y - my; sxx += a * a; syy += b * b; sxy += a * b; }
    let ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    // Most loads are modelled square to the grid; if the steel's main direction is within 12° of
    // the X or Y axis, use that axis so patterns come out square rather than slightly skewed.
    const q = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(ang - q) <= (12 * Math.PI) / 180) ang = q;
    const h = { x: Math.cos(ang), y: Math.sin(ang) }, nrm = { x: -h.y, y: h.x };
    const toLocal = (x, y) => ({ x: (x - cog.x) * h.x + (y - cog.y) * h.y, y: (x - cog.x) * nrm.x + (y - cog.y) * nrm.y });
    const toWorld = (s, v) => ({ x: cog.x + s * h.x + v * nrm.x, y: cog.y + s * h.y + v * nrm.y });

    // Each element's extent in that frame, from its vertices (tight, unlike the viewer's boxes).
    const boxes = elems.filter((e) => e.mesh).map((e) => {
      const P = e.mesh.pos;
      const b = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
      for (let i = 0; i < P.length; i += 3) {
        const q = toLocal(P[i], P[i + 1]);
        if (q.x < b.min.x) b.min.x = q.x; if (q.x > b.max.x) b.max.x = q.x;
        if (q.y < b.min.y) b.min.y = q.y; if (q.y > b.max.y) b.max.y = q.y;
        if (P[i + 2] < b.min.z) b.min.z = P[i + 2]; if (P[i + 2] > b.max.z) b.max.z = P[i + 2];
      }
      b.kg = e.kg; // lets the planner prefer heavy members over light bracing
      return b;
    });
    const base = C.planLiftPoints({ cog: { x: 0, y: 0, z: cog.z }, boxes, n, layout });
    if (!base) return null;
    const ub = C.unionBox(boxes);
    const size = Math.max(ub.max.x - ub.min.x, ub.max.y - ub.min.y);
    const maxR = Math.max(0.3, 0.25 * size);

    const tryScale = (f) => {
      const pts = base.points.map((p, i) => {
        const w = toWorld(p.x * f, p.y * f);
        const hit = hm.nearest(w.x, w.y, maxR);
        return hit ? { label: `P${i + 1}`, x: hit.x, y: hit.y, z: hit.z, moved: hit.moved } : null;
      });
      if (pts.some((p) => !p)) return null;
      const shares = C.loadShares(pts, cog, totalKg);
      const mean = totalKg / pts.length;
      const imbalance = pts.length > 1 ? (Math.max(...shares.kg) - Math.min(...shares.kg)) / mean : 0;
      const movedAvg = pts.reduce((a, p) => a + p.moved, 0) / pts.length;
      const score = (shares.stable ? 0 : 1e6) + imbalance + (0.5 * movedAvg) / size + 0.1 * (1 - f);
      return { pts, shares, score, f, movedMax: Math.max(...pts.map((p) => p.moved)) };
    };
    let best = null;
    for (const f of [1, 0.85, 0.7, 0.55, 0.4]) {
      const r = tryScale(f);
      if (r && (!best || r.score < best.score)) best = r;
    }
    if (!best) return { error: "Couldn't find steel close enough to place the lifting points. Use \"Pick lifting points\" to click them on the element." };

    const notes = [...base.notes];
    if (best.movedMax > 0.02) notes.push(`Points were moved onto the steel where the ideal spot was empty (up to ${best.movedMax.toFixed(2)} m)${best.f < 1 ? ", with the pattern drawn in closer to keep the load balanced" : ""}.`);
    return {
      points: best.pts.map(({ moved, ...p }) => ({ ...p, snapped: moved > 0.02, onElement: true })),
      layout: base.layout, axis: "geometry", notes, mainDirection: (ang * 180) / Math.PI,
    };
  }

  const api = { ifcGuid, GeoModel, mergeMeshes, meshStats, buildHeightmap, planWithGeometry };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GEO = api;
})(this);
