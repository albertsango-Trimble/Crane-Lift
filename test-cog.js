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
