// Quick checks for cog.js — run: node test-cog.js
const C = require("./cog.js");
const assert = require("assert");

const obj = (sets) => ({ properties: sets.map(([name, props]) => ({ name, properties: props.map(([n, v, t]) => ({ name: n, value: v, type: t })) })) });
const box = (a, b) => ({ min: { x: a[0], y: a[1], z: a[2] }, max: { x: b[0], y: b[1], z: b[2] } });

// Mass: prefer gross weight
let m = C.findMass(obj([["Tekla", [["WEIGHT_NET", 90, 3], ["WEIGHT_GROSS", 100, 3], ["WEIGHT_PER_METRE", 5, 3]]]]), 7850);
assert.strictEqual(m.kg, 100);

// Mass: fall back to volume × density
m = C.findMass(obj([["Qto", [["NetVolume", 0.01, 2], ["GrossVolume", 0.012, 2]]]]), 7850);
assert.ok(Math.abs(m.kg - 94.2) < 1e-9, m.kg);

// No mass
assert.strictEqual(C.findMass(obj([["X", [["Name", "B1", 5]]]]), 7850).kg, null);

// COG property in mm → m, accepted when inside box
const withCog = obj([["Tekla", [["COG_X", 1500, 0], ["COG_Y", 200, 0], ["COG_Z", 3000, 0]]]]);
let c = C.findCentre(withCog, box([1, 0, 2], [2, 1, 4]));
assert.deepStrictEqual(c.point, { x: 1.5, y: 0.2, z: 3 });
assert.strictEqual(c.approximate, false);

// COG property outside box → rejected, box centre used
c = C.findCentre(withCog, box([10, 10, 10], [12, 12, 12]));
assert.deepStrictEqual(c.point, { x: 11, y: 11, z: 11 });
assert.ok(c.approximate);

// Combined COG: 100 kg at x=0, 300 kg at x=4 → x=3
const r = C.combine([
  { kg: 100, point: { x: 0, y: 0, z: 0 } },
  { kg: 300, point: { x: 4, y: 0, z: 2 } },
  { kg: null, point: { x: 99, y: 99, z: 99 } },
]);
assert.strictEqual(r.totalKg, 400);
assert.deepStrictEqual(r.cog, { x: 3, y: 0, z: 1.5 });
assert.strictEqual(r.used, 2);
assert.strictEqual(r.excluded, 1);

// Unit scaling mm → m
assert.deepStrictEqual(C.scaleBox(box([1000, 0, 0], [2000, 500, 0]), 0.001), box([1, 0, 0], [2, 0.5, 0]));

console.log("All COG tests passed");

// ================= Lifting points =================
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;

// Beam like the screenshot: 6.03 m along X, 0.2 wide, 0.204 high, 278.4 kg, COG in the middle
const beam = box([0, 0, 0], [6.03, 0.2, 0.204]);
const bc = { x: 3.015, y: 0.1, z: 0.102 };

// 2 points: 0.207L from each end, on top flange, 50/50
let plan = C.planLiftPoints({ cog: bc, boxes: [beam], n: 2 });
assert.strictEqual(plan.layout, "line");
assert.ok(near(plan.points[0].x, 0.2071 * 6.03, 1e-3) && near(plan.points[1].x, 6.03 - 0.2071 * 6.03, 1e-3), JSON.stringify(plan.points));
assert.ok(plan.points.every((p) => p.z === 0.204 && near(p.y, 0.1)));
let sh = C.loadShares(plan.points, bc, 278.4);
assert.ok(sh.stable && sh.determinate);
assert.ok(sh.kg.every((v) => near(v, 139.2, 1e-6)), sh.kg);

// 1 point: directly over COG, on top
plan = C.planLiftPoints({ cog: bc, boxes: [beam], n: 1 });
assert.ok(near(plan.points[0].x, 3.015) && plan.points[0].z === 0.204);
assert.deepStrictEqual(C.loadShares(plan.points, bc, 278.4).kg, [278.4]);

// 4 points on a narrow beam → auto falls back to a line, flagged indeterminate, equal shares
plan = C.planLiftPoints({ cog: bc, boxes: [beam], n: 4 });
assert.strictEqual(plan.layout, "line");
sh = C.loadShares(plan.points, bc, 278.4);
assert.ok(sh.stable && !sh.determinate);
assert.ok(sh.kg.every((v) => near(v, 69.6, 1e-6)), sh.kg);

// Off-centre COG on a beam: 2 points stay symmetric about the COG → still 50/50
const offC = { x: 1.5, y: 0.1, z: 0.1 };
plan = C.planLiftPoints({ cog: offC, boxes: [beam], n: 2 });
assert.ok(near((plan.points[0].x + plan.points[1].x) / 2, 1.5, 1e-9));
assert.ok(plan.points[0].x >= 0.05);
assert.ok(C.loadShares(plan.points, offC, 100).kg.every((v) => near(v, 50)));

// Wide panel 4 × 3 m: 4 points as a rectangle, 3 points as a triangle, both equal & determinate for 3
const panel = box([0, 0, 0], [4, 3, 0.2]);
const pc = { x: 2, y: 1.5, z: 0.1 };
plan = C.planLiftPoints({ cog: pc, boxes: [panel], n: 4 });
assert.strictEqual(plan.layout, "area");
assert.strictEqual(plan.points.length, 4);
sh = C.loadShares(plan.points, pc, 1000);
assert.ok(sh.kg.every((v) => near(v, 250)), sh.kg);
plan = C.planLiftPoints({ cog: pc, boxes: [panel], n: 3 });
sh = C.loadShares(plan.points, pc, 900);
assert.ok(sh.determinate && sh.stable && sh.kg.every((v) => near(v, 300, 1e-6)), JSON.stringify(sh));
const cx = plan.points.reduce((a, p) => a + p.x, 0) / 3, cy = plan.points.reduce((a, p) => a + p.y, 0) / 3;
assert.ok(near(cx, 2) && near(cy, 1.5)); // triangle centroid on COG

// Unequal points: 2 points at x=0 and x=4, COG at x=1 → 75% / 25%
sh = C.loadShares([{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }], { x: 1, y: 0, z: 0 }, 100);
assert.ok(near(sh.kg[0], 75) && near(sh.kg[1], 25), sh.kg);

// COG outside points → unstable
sh = C.loadShares([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], { x: 2, y: 0, z: 0 }, 100);
assert.strictEqual(sh.stable, false);
// COG off the line of points → unstable (load will roll)
sh = C.loadShares([{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], { x: 1, y: 0.3, z: 0 }, 100);
assert.strictEqual(sh.stable, false);

// Two separate beams with a gap; 2 points must land on steel, not in the gap
const b1 = box([0, 0, 0], [2, 0.2, 0.3]), b2 = box([3, 0, 0], [5, 0.2, 0.5]);
plan = C.planLiftPoints({ cog: { x: 2.5, y: 0.1, z: 0.2 }, boxes: [b1, b2], n: 2 });
for (const p of plan.points) assert.ok([b1, b2].some((b) => p.x >= b.min.x && p.x <= b.max.x), JSON.stringify(p));
assert.strictEqual(plan.points[1].z, 0.5); // top of the taller beam

// Slings: 2 points 3 m apart, hook 2 m above → 53.1° from horizontal, tension = share × len / height
const sl = C.slings([{ x: -1.5, y: 0, z: 0 }, { x: 1.5, y: 0, z: 0 }], { x: 0, y: 0, z: 0 }, 2, [50, 50]);
assert.ok(near(sl.legs[0].length, 2.5) && near(sl.legs[0].tensionKg, 62.5) && near(sl.legs[0].angleFromHorizontal, 53.1301, 1e-3));

// ================= Sloped / skewed member (like the 24.9 t element) =================
// Top-surface line runs from A (high end) to B (low end), skewed in plan.
const A = { x: 100, y: 50.2, z: 26.04 }, B = { x: 117.3, y: 53.1, z: 20.64 };
const slopedBox = box([99.9, 50.0, 20.37], [117.47, 53.33, 26.04]);
const flags = C.looksSloped(slopedBox);
assert.ok(flags.sloped, "sloped member should be flagged");
assert.ok(!C.looksSloped(beam).sloped && !C.looksSloped(beam).skewed, "flat beam must not be flagged");
assert.ok(!C.looksSloped(panel).sloped && !C.looksSloped(panel).skewed, "flat panel must not be flagged");

// COG: middle of the member, 0.25 m below its top line, slightly off the traced line in plan.
const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 - 0.25 };
const sCog = { x: mid.x + 0.03, y: mid.y - 0.02, z: mid.z };
plan = C.planOnAxis({ cog: sCog, a: A, b: B, boxes: [slopedBox], n: 2 });
assert.ok(!plan.error, plan.error);
assert.strictEqual(plan.layout, "line");
// Points sit on the traced top line (height follows the slope) – not on the box top
const zOnLine = (p) => { // height of the top line at this plan position
  const L = Math.hypot(B.x - A.x, B.y - A.y); const t = ((p.x - A.x) * (B.x - A.x) + (p.y - A.y) * (B.y - A.y)) / (L * L);
  return A.z + t * (B.z - A.z);
};
for (const p of plan.points) assert.ok(near(p.z, zOnLine(p), 1e-6), `z ${p.z} vs line ${zOnLine(p)}`);
assert.ok(plan.points[0].z < 26.04 - 0.5 || plan.points[1].z < 26.04 - 0.5, "at least one point well below the box top");
// Equal loads and stable
sh = C.loadShares(plan.points, sCog, 24900);
assert.ok(sh.stable, JSON.stringify(sh)); assert.ok(sh.kg.every((v) => near(v, 12450, 1e-6)), sh.kg);
// Spacing ≈ 2 × 0.293 × member length (box-clipped length, ≥ traced length)
const sp = Math.hypot(plan.points[1].x - plan.points[0].x, plan.points[1].y - plan.points[0].y, plan.points[1].z - plan.points[0].z);
assert.ok(sp > 2 * 0.29 * Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z) * 0.99, `spacing ${sp}`);
assert.ok(plan.slopeDeg > 15 && plan.slopeDeg < 20, plan.slopeDeg);
// Same result whichever end is clicked first
const planRev = C.planOnAxis({ cog: sCog, a: B, b: A, boxes: [slopedBox], n: 2 });
const key = (pl) => pl.points.map((p) => [p.x, p.y, p.z].map((v) => v.toFixed(4)).join()).sort().join("|");
assert.strictEqual(key(planRev), key(plan));
// Bad traces
assert.ok(C.planOnAxis({ cog: sCog, a: A, b: { ...A, x: A.x + 0.05 }, boxes: [slopedBox], n: 2 }).error);
assert.ok(C.planOnAxis({ cog: sCog, a: A, b: { ...A, z: A.z - 3 }, boxes: [slopedBox], n: 2 }).error);
// 4 points along a traced member: all on the line, equal shares
plan = C.planOnAxis({ cog: sCog, a: A, b: B, boxes: [slopedBox], n: 4, layout: "line" });
for (const p of plan.points) assert.ok(near(p.z, zOnLine(p), 1e-6));
assert.ok(C.loadShares(plan.points, sCog, 24900).kg.every((v) => near(v, 6225, 1e-6)));

console.log("All lifting-point tests passed");
