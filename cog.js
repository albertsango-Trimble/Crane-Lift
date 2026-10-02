// Centre-of-gravity maths – no viewer dependencies, so it can be unit-tested in Node.
// Property units per Workspace API PropertyType: LengthMeasure(0)=mm, VolumeMeasure(2)=m3, MassMeasure(3)=kg.
(function (root) {
  const PT = { Length: 0, Volume: 2, Mass: 3 };

  const num = (v) => {
    const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };

  // Flatten property sets into [{set, name, value, type}]
  function flatten(obj) {
    const out = [];
    for (const set of obj?.properties || []) {
      for (const p of set.properties || []) out.push({ set: set.name, name: p.name, value: p.value, type: p.type });
    }
    return out;
  }

  // Lifting should use the heaviest credible figure, so gross beats plain beats net.
  const rank = (name) => (/gross/i.test(name) ? 3 : /net/i.test(name) ? 1 : 2);

  function best(candidates) {
    candidates.sort((a, b) => rank(b.name) - rank(a.name) || b.value - a.value);
    return candidates[0] || null;
  }

  /** Mass in kg: weight/mass property first, else volume × density. */
  function findMass(obj, densityKgM3) {
    const props = flatten(obj);
    const massProps = props
      .filter((p) => /(weight|mass)/i.test(p.name) && !/(per|\/)/i.test(p.name)) // skip "weight per metre"
      .map((p) => ({ ...p, value: num(p.value) }))
      .filter((p) => p.value !== null && p.value > 0 && (p.type === PT.Mass || p.type === undefined));
    const m = best(massProps);
    if (m) {
      return { kg: m.value, source: `${m.set} › ${m.name}` + (m.type === undefined ? " (assumed kg)" : "") };
    }
    const volProps = props
      .filter((p) => /volume/i.test(p.name) && p.type === PT.Volume)
      .map((p) => ({ ...p, value: num(p.value) }))
      .filter((p) => p.value !== null && p.value > 0);
    const v = best(volProps);
    if (v && densityKgM3 > 0) {
      return { kg: v.value * densityKgM3, source: `${v.set} › ${v.name} × ${densityKgM3} kg/m³` };
    }
    return { kg: null, source: "No weight or volume found" };
  }

  /** COG from model properties (e.g. Tekla COG_X/Y/Z), LengthMeasure in mm → metres. */
  function findCogProperty(obj) {
    const props = flatten(obj).filter((p) => p.type === PT.Length);
    const axis = {};
    for (const p of props) {
      const m = /(?:^|[^a-z])(?:cog|cent(?:er|re)[ _-]?of[ _-]?gravity)[ _-]?([xyz])$/i.exec(p.name);
      const val = num(p.value);
      if (m && val !== null) axis[m[1].toLowerCase()] = val / 1000;
    }
    return "x" in axis && "y" in axis && "z" in axis ? { x: axis.x, y: axis.y, z: axis.z } : null;
  }

  function scaleBox(box, s) {
    return {
      min: { x: box.min.x * s, y: box.min.y * s, z: box.min.z * s },
      max: { x: box.max.x * s, y: box.max.y * s, z: box.max.z * s },
    };
  }

  const boxCentre = (b) => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 });

  function inside(p, b, tol) {
    return ["x", "y", "z"].every((k) => p[k] >= b.min[k] - tol && p[k] <= b.max[k] + tol);
  }

  /** Per-object centroid: model COG property if it sits inside the object's box, else box centre. */
  function findCentre(obj, box) {
    const prop = findCogProperty(obj);
    if (prop && box) {
      if (inside(prop, box, 0.05)) return { point: prop, source: "COG property", approximate: false };
      return { point: boxCentre(box), source: "Box centre (COG property outside object – ignored)", approximate: true };
    }
    if (prop && !box) return { point: prop, source: "COG property", approximate: false };
    if (box) return { point: boxCentre(box), source: "Box centre", approximate: true };
    return { point: null, source: "No geometry", approximate: true };
  }

  /** items: [{kg, point}] → { totalKg, cog, used, excluded } */
  function combine(items) {
    let M = 0, x = 0, y = 0, z = 0, used = 0, excluded = 0;
    for (const it of items) {
      if (!(it.kg > 0) || !it.point) { excluded++; continue; }
      M += it.kg; x += it.kg * it.point.x; y += it.kg * it.point.y; z += it.kg * it.point.z; used++;
    }
    return { totalKg: M, cog: M > 0 ? { x: x / M, y: y / M, z: z / M } : null, used, excluded };
  }

  function unionBox(boxes) {
    const bs = boxes.filter(Boolean);
    if (!bs.length) return null;
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const b of bs) for (const k of ["x", "y", "z"]) {
      min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]);
    }
    return { min, max };
  }

  // ======================= Lifting points =======================
  // All coordinates in metres. Plan = X/Y, Z up. Layout is aligned to the longer plan
  // axis of the selection's (axis-aligned) bounding box.

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const inPlan = (p, b, tol) => p.x >= b.min.x - tol && p.x <= b.max.x + tol && p.y >= b.min.y - tol && p.y <= b.max.y + tol;
  const planDist = (p, b) => Math.hypot(Math.max(b.min.x - p.x, 0, p.x - b.max.x), Math.max(b.min.y - p.y, 0, p.y - b.max.y));

  // Evenly spaced offsets symmetric about 0. For 2 points use the 0.207L-from-ends rule
  // (minimises bending in a uniform beam); otherwise one bay per point with half-bay overhangs.
  function rowOffsets(count, length, room) {
    if (count === 1) return [0];
    const half = count === 2 ? (0.5 - 0.2071) * length : (length / count) * (count - 1) / 2;
    const h = Math.max(0, Math.min(half, room));
    return Array.from({ length: count }, (_, i) => -h + (2 * h * i) / (count - 1));
  }

  /**
   * Proposes N lifting points arranged symmetrically about the COG (equal loads on a rigid body),
   * then drops each one onto the top of the element underneath it.
   * opts: { cog, boxes: Box[], n, layout: "auto"|"line"|"area" }
   */
  function planLiftPoints({ cog, boxes, n, layout = "auto" }) {
    const bs = boxes.filter(Boolean);
    const ub = unionBox(bs);
    if (!ub || !cog || !(n >= 1)) return null;

    const Lx = ub.max.x - ub.min.x, Ly = ub.max.y - ub.min.y;
    const U = Lx >= Ly ? "x" : "y", V = U === "x" ? "y" : "x";
    const Lu = ub.max[U] - ub.min[U], Lv = ub.max[V] - ub.min[V];
    const uc = cog[U], vc = cog[V];
    const mu = Math.max(0.05, 0.02 * Lu), mv = Math.max(0.05, 0.05 * Lv); // keep clear of edges
    const roomU = Math.max(0, Math.min(uc - ub.min[U], ub.max[U] - uc) - mu);
    const roomV = Math.max(0, Math.min(vc - ub.min[V], ub.max[V] - vc) - mv);

    let used = n === 1 ? "single" : n === 2 ? "line" : layout === "auto" ? (Lv >= 0.25 * Lu && roomV > 0.1 ? "area" : "line") : layout;
    const notes = [];
    if (used === "area" && roomV <= 0.05) { used = "line"; notes.push("Selection is too narrow to spread points across its width – placed in a line instead."); }

    let uv = [];
    if (used === "single") uv = [[0, 0]];
    else if (used === "line") uv = rowOffsets(n, Lu, roomU).map((du) => [du, 0]);
    else if (n === 3) {
      // Isosceles triangle with its centroid on the COG: two points behind, apex in front (more room side).
      const s = ub.max[U] - uc >= uc - ub.min[U] ? 1 : -1;
      const back = s > 0 ? uc - ub.min[U] - mu : ub.max[U] - uc - mu;
      const front = s > 0 ? ub.max[U] - uc - mu : uc - ub.min[U] - mu;
      const p = Math.max(0, Math.min(0.25 * Lu, back, front / 2));
      const q = Math.min(0.2929 * Lv, roomV);
      uv = [[-s * p, -q], [-s * p, q], [2 * s * p, 0]];
    } else {
      // Two rows either side of the COG (4 → 2×2, 6 → 2×3, 8 → 2×4).
      const cols = rowOffsets(Math.ceil(n / 2), Lu, roomU);
      const dv = Math.min(0.2929 * Lv, roomV);
      for (const du of cols) uv.push([du, -dv], [du, dv]);
    }

    const points = uv.map(([du, dv], i) => {
      let p = { [U]: uc + du, [V]: vc + dv };
      let snapped = false;
      let hits = bs.filter((b) => inPlan(p, b, 0.001));
      if (!hits.length) {
        // Gap between elements – move the point onto the nearest element.
        const near = bs.reduce((a, b) => (planDist(p, b) < planDist(p, a) ? b : a));
        p = { x: clamp(p.x, near.min.x, near.max.x), y: clamp(p.y, near.min.y, near.max.y) };
        hits = [near]; snapped = true;
      }
      const z = Math.max(...hits.map((b) => b.max.z)); // top surface
      return { label: `P${i + 1}`, x: p.x, y: p.y, z, snapped };
    });
    if (points.some((p) => p.snapped)) notes.push("Some points fell in a gap between elements and were moved onto the nearest element – loads recalculated.");
    return { points, layout: used, axis: U, notes };
  }

  // Solve small dense system (Gaussian elimination, partial pivoting). Returns null if singular.
  function solve(M, b) {
    const n = b.length, A = M.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < n; r++) if (r !== c) {
        const k = A[r][c] / A[c][c];
        for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j];
      }
    }
    return A.map((r, i) => r[n] / r[i]);
  }

  /**
   * Vertical load at each point for a rigid load hanging with the hook over the COG.
   * Uses the minimum-norm (most even) solution of the equilibrium equations, which is exact
   * for 1, 2 and 3 non-collinear points and an even-sharing assumption beyond that.
   */
  function loadShares(points, cog, W) {
    const n = points.length, tol = 0.005; // 5 mm
    const res = { kg: [], stable: true, determinate: true, offset: 0 };
    if (!n || !(W > 0)) return res;
    const dx = points.map((p) => p.x - cog.x), dy = points.map((p) => p.y - cog.y);

    if (n === 1) {
      res.offset = Math.hypot(dx[0], dy[0]);
      res.stable = res.offset <= Math.max(tol, 0.01);
      res.kg = [W];
      return res;
    }

    // Are the points (nearly) on one line? Principal axis of the plan positions.
    const mx = dx.reduce((a, b) => a + b) / n, my = dy.reduce((a, b) => a + b) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const a = dx[i] - mx, b = dy[i] - my; sxx += a * a; syy += b * b; sxy += a * b; }
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det)), l2 = tr - l1;
    const collinear = l2 <= 1e-6 * Math.max(l1, 1e-12) || n === 2;

    let rows;
    if (collinear) {
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const ux = Math.cos(ang), uy = Math.sin(ang);
      res.offset = Math.abs(-mx * uy + my * ux); // COG distance from the line of points
      if (res.offset > tol) res.stable = false;
      rows = [points.map(() => 1), dx.map((x, i) => x * ux + dy[i] * uy)];
      if (n > 2) res.determinate = false;
    } else {
      rows = [points.map(() => 1), dx, dy];
      if (n > 3) res.determinate = false;
    }
    const b = [W, ...rows.slice(1).map(() => 0)];
    const M = rows.map((r) => rows.map((s) => r.reduce((acc, v, i) => acc + v * s[i], 0)));
    const lam = solve(M, b);
    if (!lam) { res.stable = false; res.kg = points.map(() => W / n); return res; }
    res.kg = points.map((_, i) => rows.reduce((acc, r, k) => acc + r[i] * lam[k], 0));
    if (res.kg.some((v) => v < -1e-6 * W)) res.stable = false; // COG outside the lifting points
    return res;
  }

  /** Sling geometry for a single hook directly above the COG, `height` metres above the highest point. */
  function slings(points, cog, height, kgShares) {
    if (!(height > 0) || !points.length) return null;
    const hook = { x: cog.x, y: cog.y, z: Math.max(...points.map((p) => p.z)) + height };
    const legs = points.map((p, i) => {
      const h = Math.hypot(hook.x - p.x, hook.y - p.y), v = hook.z - p.z;
      const len = Math.hypot(h, v);
      const fromHorizontal = (Math.atan2(v, h) * 180) / Math.PI;
      return { length: len, angleFromHorizontal: fromHorizontal, tensionKg: v > 0 ? (kgShares[i] * len) / v : Infinity };
    });
    return { hook, legs };
  }

  const api = { PT, findMass, findCogProperty, findCentre, combine, scaleBox, boxCentre, unionBox, planLiftPoints, loadShares, slings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.COG = api;
})(this);
