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
   * Offsets [du, dv] of the lifting points relative to the COG, in the layout's own axes:
   * u = along the load, v = across it. back/front = usable room behind/in front of the COG along u.
   */
  function makeUV(n, used, Lu, Lv, back, front, roomV) {
    back = Math.max(0, back); front = Math.max(0, front);
    const roomU = Math.min(back, front);
    if (used === "single") return [[0, 0]];
    if (used === "line") return rowOffsets(n, Lu, roomU).map((du) => [du, 0]);
    if (n === 3) {
      // Isosceles triangle with its centroid on the COG: two points behind, apex on the side with more room.
      const s = front >= back ? 1 : -1;
      const p = Math.max(0, Math.min(0.25 * Lu, s > 0 ? back : front, (s > 0 ? front : back) / 2));
      const q = Math.min(0.2929 * Lv, roomV);
      return [[-s * p, -q], [-s * p, q], [2 * s * p, 0]];
    }
    // Two rows either side of the COG (4 → 2×2, 6 → 2×3, 8 → 2×4).
    const uv = [], dv = Math.min(0.2929 * Lv, roomV);
    for (const du of rowOffsets(Math.ceil(n / 2), Lu, roomU)) uv.push([du, -dv], [du, dv]);
    return uv;
  }

  /**
   * True when an axis-aligned bounding box is a poor stand-in for the element's top surface:
   * the element is sloped (tall box relative to its length) or skewed in plan (wide box for a long member).
   */
  function looksSloped(box) {
    if (!box) return { sloped: false, skewed: false };
    const Lx = box.max.x - box.min.x, Ly = box.max.y - box.min.y, Lz = box.max.z - box.min.z;
    const L = Math.max(Lx, Ly), W = Math.min(Lx, Ly);
    return {
      sloped: Lz > 1.0 && Lz > 0.15 * L,          // e.g. raking rafter, inclined truss
      skewed: L > 3 && W > 1.0 && W > 0.15 * L && W < 0.5 * L, // long member running diagonally in plan
    };
  }

  // Parameter range [t0, t1] where the line a + t·d lies inside box (slab method), or null.
  function clipLine(a, d, box) {
    let t0 = -Infinity, t1 = Infinity;
    for (const k of ["x", "y", "z"]) {
      if (Math.abs(d[k]) < 1e-12) { if (a[k] < box.min[k] || a[k] > box.max[k]) return null; continue; }
      let ta = (box.min[k] - a[k]) / d[k], tb = (box.max[k] - a[k]) / d[k];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    return t1 >= t0 ? [t0, t1] : null;
  }

  /**
   * Fits the top-surface profile of a member from points the user clicked on its TOP (metres).
   * Plan: a straight line (best fit). Height: straight for 2 points; a parabola for 3+ points
   * (vertical curves are parabolic), or piecewise-linear through the clicks if a parabola doesn't fit.
   * Returns { o, h, nrm, zAt(s), sMin, sMax, kind } where s = plan distance along h from o.
   */
  function fitProfile(pts) {
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
    let h;
    if (n === 2) {
      const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y, l = Math.hypot(dx, dy);
      h = l > 1e-9 ? { x: dx / l, y: dy / l } : { x: 1, y: 0 };
    } else {
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of pts) { const a = p.x - mx, b = p.y - my; sxx += a * a; syy += b * b; sxy += a * b; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      h = { x: Math.cos(ang), y: Math.sin(ang) };
    }
    const o = { x: mx, y: my };
    const S = pts.map((p) => ({ s: (p.x - o.x) * h.x + (p.y - o.y) * h.y, z: p.z })).sort((a, b) => a.s - b.s);
    const sMin = S[0].s, sMax = S[n - 1].s;
    const zSpread = Math.max(...S.map((q) => q.z)) - Math.min(...S.map((q) => q.z));
    if (sMax - sMin < 0.2) return { error: "The traced points are too close together – click near each end of the element." };
    if (sMax - sMin < 0.05 * zSpread) return { error: "The trace is vertical – trace along the length of the element, not up its side." };

    let zAt, kind;
    if (n === 2) {
      const k = (S[1].z - S[0].z) / (S[1].s - S[0].s);
      zAt = (s) => S[0].z + k * (s - S[0].s); kind = "straight";
    } else {
      // Least-squares parabola z = c0 + c1·u + c2·u² (u centred for conditioning).
      const sm = (sMin + sMax) / 2;
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
      for (const q of S) {
        const u = q.s - sm, row = [1, u, u * u];
        for (let i = 0; i < 3; i++) { r[i] += row[i] * q.z; for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j]; }
      }
      const c = solve(M, r);
      const quad = c && ((s) => c[0] + c[1] * (s - sm) + c[2] * (s - sm) ** 2);
      const rms = quad ? Math.sqrt(S.reduce((a, q) => a + (quad(q.s) - q.z) ** 2, 0) / n) : Infinity;
      if (quad && rms <= 0.03) {
        zAt = quad;
        // Call it straight if the curve never strays more than 2 cm from its chord.
        const chord = (s) => quad(sMin) + ((quad(sMax) - quad(sMin)) * (s - sMin)) / (sMax - sMin);
        kind = Math.abs(quad((sMin + sMax) / 2) - chord((sMin + sMax) / 2)) > 0.02 ? "curved" : "straight";
      } else {
        // Piecewise-linear through the clicks, extended along the end segments.
        zAt = (s) => {
          let i = 0;
          while (i < n - 2 && s > S[i + 1].s) i++;
          const A = S[i], B = S[i + 1];
          return A.z + ((B.z - A.z) * (s - A.s)) / (B.s - A.s || 1);
        };
        kind = "curved";
      }
    }
    return { o, h, nrm: { x: -h.y, y: h.x }, zAt, sMin, sMax, kind };
  }

  // Range of s where the plan line o + s·h crosses the plan box (2D slab method), or null.
  function clipPlan(o, h, box) {
    let t0 = -Infinity, t1 = Infinity;
    for (const k of ["x", "y"]) {
      if (Math.abs(h[k]) < 1e-12) { if (o[k] < box.min[k] || o[k] > box.max[k]) return null; continue; }
      let ta = (box.min[k] - o[k]) / h[k], tb = (box.max[k] - o[k]) / h[k];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    return t1 >= t0 ? [t0, t1] : null;
  }

  /**
   * Lifting points along a traced member. pts (or a, b) = points clicked on the TOP of the element.
   * The fitted profile gives the member's direction and the height of its top surface, including
   * vertical curves. The plan line is moved sideways to pass over the COG, so points stay
   * symmetric about the COG and loads stay equal.
   */
  function planOnAxis({ cog, pts, a, b, boxes, n, layout = "auto" }) {
    pts = (pts || [a, b]).filter(Boolean);
    const bs = boxes.filter(Boolean), ub = unionBox(bs);
    if (!ub || !cog || pts.length < 2 || !(n >= 1)) return null;
    const prof = fitProfile(pts);
    if (prof.error) return prof;
    const { h, nrm, zAt, sMin, sMax, kind } = prof;

    // Shift the plan line sideways so it passes over the COG (s is unchanged by the shift).
    const e = (cog.x - prof.o.x) * nrm.x + (cog.y - prof.o.y) * nrm.y;
    const o = { x: prof.o.x + e * nrm.x, y: prof.o.y + e * nrm.y };

    // Member extent along the line: where it crosses the selection's plan box, never less than the clicks.
    const span = clipPlan(o, h, { min: { x: ub.min.x - 0.05, y: ub.min.y - 0.05 }, max: { x: ub.max.x + 0.05, y: ub.max.y + 0.05 } });
    const t0 = Math.min(span ? span[0] : sMin, sMin), t1 = Math.max(span ? span[1] : sMax, sMax);
    const sc = (cog.x - o.x) * h.x + (cog.y - o.y) * h.y; // COG position along the member
    const L = t1 - t0, m = Math.max(0.05, 0.02 * L);

    // Width across the member, estimated from the plan box and the traced direction.
    const Lx = ub.max.x - ub.min.x, Ly = ub.max.y - ub.min.y;
    const cx = Math.abs(h.x), cy = Math.abs(h.y);
    const W = Math.max(0, cx >= cy ? (Ly - L * cy) / cx : (Lx - L * cx) / cy);
    const roomV = Math.max(0, W / 2 - Math.max(0.05, 0.05 * W));

    const notes = [];
    let used = n === 1 ? "single" : n === 2 ? "line" : layout === "auto" ? (W >= 0.25 * L && roomV > 0.1 ? "area" : "line") : layout;
    if (used === "area" && roomV <= 0.05) { used = "line"; notes.push("Element is too narrow to spread points across its width – placed in a line instead."); }

    const uv = makeUV(n, used, L, W, sc - t0 - m, t1 - sc - m, roomV);
    const points = uv.map(([du, dv], i) => {
      const s = sc + du;
      const p = { x: o.x + s * h.x + dv * nrm.x, y: o.y + s * h.y + dv * nrm.y, z: zAt(s) };
      const onElement = bs.some((bx) => inPlan(p, bx, 0.05) && p.z >= bx.min.z - 0.05 && p.z <= bx.max.z + 0.05);
      const extrapolated = s < sMin - 0.05 || s > sMax + 0.05;
      return { label: `P${i + 1}`, ...p, snapped: false, onElement, extrapolated };
    });
    if (points.some((p) => !p.onElement)) notes.push("Some points are outside the selected elements – check the trace was made along the top of the element.");
    const ext = points.filter((p) => p.extrapolated).map((p) => p.label);
    if (ext.length && kind === "curved") notes.push(`${ext.join(", ")} ${ext.length > 1 ? "are" : "is"} beyond your outermost clicks, so ${ext.length > 1 ? "their heights are" : "its height is"} extrapolated – click closer to the ends for accuracy.`);

    // Overall slope (end to end) and how far the curve rises/sags from its chord.
    const z0 = zAt(t0), z1 = zAt(t1);
    const slopeDeg = (Math.atan2(Math.abs(z1 - z0), L) * 180) / Math.PI;
    let arc = 0, prev = null, rise = 0;
    for (let k = 0; k <= 50; k++) {
      const s = t0 + (L * k) / 50, z = zAt(s);
      if (prev) arc += Math.hypot(s - prev.s, z - prev.z);
      rise = Math.abs(z - (z0 + ((z1 - z0) * (s - t0)) / L)) > Math.abs(rise) ? z - (z0 + ((z1 - z0) * (s - t0)) / L) : rise;
      prev = { s, z };
    }
    return { points, layout: used, axis: "traced", notes, slopeDeg, length: arc, width: W, curve: kind, rise, tracePoints: pts.length };
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

    const uv = makeUV(n, used, Lu, Lv, uc - ub.min[U] - mu, ub.max[U] - uc - mu, roomV);

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

  const api = { PT, findMass, findCogProperty, findCentre, combine, scaleBox, boxCentre, unionBox, planLiftPoints, planOnAxis, fitProfile, looksSloped, loadShares, slings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.COG = api;
})(this);
