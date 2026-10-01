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

  const api = { PT, findMass, findCogProperty, findCentre, combine, scaleBox, boxCentre, unionBox };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.COG = api;
})(this);
