// Tests geo.js against the real IFC files (needs web-ifc: npm i web-ifc).
// npm i web-ifc && node test-geo.mjs ARV_Sample_1.ifc Korec_Tekla.ifc test-geo-arv.json test-geo-korec.json
import * as WebIFC from "web-ifc";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const C = require("./cog.js"), G = require("./geo.js"), F = require("./test-frame.json");
const assert = require("assert");
const [arvPath, korecPath, arvRef, korecRef] = process.argv.slice(2);
const near = (a, b, t) => Math.abs(a - b) <= t;

const api = new WebIFC.IfcAPI(); await api.Init();
async function open(p) { const t = Date.now(); const m = await G.GeoModel.open(WebIFC, api, new Uint8Array(fs.readFileSync(p))); return [m, Date.now() - t]; }

function run(model, ids, kgs, n, ref) {
  const t = Date.now();
  // As the extension does it: GUID → express id → mesh
  const elems = ids.map((id) => {
    const guid = api.GetGuidFromExpressId(model.mid, id);
    const ex = model.expressIdFor(guid);
    assert.strictEqual(ex, id, `GUID round trip for #${id}`);
    const mesh = model.mesh(ex);
    return { id, mesh, st: G.meshStats(mesh), kg: kgs[ids.indexOf(id)] };
  });
  for (const e of elems) {
    const r = ref[e.id];
    assert.ok(e.st.centroid, `#${e.id} has no centroid`);
    for (const k of ["x", "y", "z"]) assert.ok(near(e.st.centroid[k], r.centroid["xyz".indexOf(k)], 0.002), `#${e.id} centroid ${k}: ${e.st.centroid[k]} vs ${r.centroid}`);
    assert.ok(near(e.st.volume, r.volume, r.volume * 0.06), `#${e.id} volume ${e.st.volume} vs ${r.volume}`);
  }
  const rows = elems.map((e, i) => ({ kg: kgs[i], point: e.st.centroid }));
  const res = C.combine(rows);
  const hm = G.buildHeightmap(elems.map((e) => e.mesh));
  const plan = G.planWithGeometry({ C, cog: res.cog, elems, hm, n, totalKg: res.totalKg });
  const sh = plan.points ? C.loadShares(plan.points, res.cog, res.totalKg) : null;
  return { elems, res, hm, plan, sh, ms: Date.now() - t };
}

const top = (P, q) => { for (let i = 0; i < P.length - 1; i++) if (q >= P[i][0] && q <= P[i + 1][0]) return P[i][1] + ((P[i + 1][1] - P[i][1]) * (q - P[i][0])) / (P[i + 1][0] - P[i][0]); return null; };
const [arv, tArv] = await open(arvPath), [korec, tKorec] = await open(korecPath);
console.log(`Opened ARV in ${tArv} ms, Korec in ${tKorec} ms`);
const RA = JSON.parse(fs.readFileSync(arvRef)), RK = JSON.parse(fs.readFileSync(korecRef));

// 1. Curved-rafter frame: no trace needed, points on the rafters at the real top
{
  const ids = F.elements.map((e) => e.id), kgs = F.elements.map((e) => e.weight);
  for (const n of [2, 4, 6]) {
    const { res, hm, plan, sh, ms } = run(arv, ids, kgs, n, RA);
    assert.ok(plan.points, plan.error);
    for (const p of plan.points) {
      const r = F.elements.find((e) => e.topProfile && Math.abs(p.x - e.xCentre) < 0.11);
      assert.ok(r, `rafter frame n=${n} ${p.label} at x ${p.x.toFixed(3)} not on a rafter`);
      const zt = top(r.topProfile, p.y);
      assert.ok(near(p.z, zt, 0.03), `rafter frame n=${n} ${p.label} z ${p.z.toFixed(3)} vs top ${zt.toFixed(3)}`);
    }
    assert.ok(sh.stable, `rafter frame n=${n} unstable`);
    if (n === 4) console.log(`Rafter frame n=4 (${ms} ms, cell ${(hm.cell * 1000).toFixed(0)} mm): COG ${["x", "y", "z"].map((k) => res.cog[k].toFixed(3)).join(", ")}; points`, plan.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join(" | "), "loads", sh.kg.map((v) => v.toFixed(1)).join("/"));
  }
}
// 2. Portal frame: on the top beams
{
  const ids = F.portal.map((e) => e.id), kgs = F.portal.map((e) => e.weight);
  const { plan, sh, res } = run(arv, ids, kgs, 4, RA);
  for (const p of plan.points) assert.ok(near(p.z, 5.0, 0.01), `portal ${p.label} z ${p.z}`);
  assert.ok(sh.stable);
  console.log("Portal n=4: points", plan.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join(" | "), "loads", sh.kg.map((v) => v.toFixed(1)).join("/"), "COG z", res.cog.z.toFixed(3));
}
// 3. Arched canopy (all 9): on the arches at the real arch top, no trace
{
  const ids = F.canopy.map((e) => e.id), kgs = F.canopy.map((e) => e.weight);
  const arches = F.canopy.filter((e) => e.topProfile);
  for (const n of [4, 6]) {
    const { plan, sh } = run(korec, ids, kgs, n, RK);
    for (const p of plan.points) {
      const a = arches.find((e) => Math.abs(p.y - e.yCentre) < 0.08);
      assert.ok(a, `canopy n=${n} ${p.label} at y ${p.y.toFixed(3)} not on an arch`);
      assert.ok(near(p.z, top(a.topProfile, p.x), 0.03), `canopy n=${n} ${p.label} z ${p.z.toFixed(3)} vs ${top(a.topProfile, p.x).toFixed(3)}`);
    }
    assert.ok(sh.stable);
    console.log(`Canopy n=${n}:`, plan.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join(" | "));
  }
}
// 4. Single curved rafter on its own: 2 points along it, on its top
{
  const { plan, sh } = run(arv, [56327], [649.04], 2, RA);
  const r = F.elements[0];
  for (const p of plan.points) assert.ok(near(p.x, 18, 0.11) && near(p.z, top(r.topProfile, p.y), 0.03), `single rafter ${p.label} ${p.x},${p.y},${p.z}`);
  assert.ok(sh.stable);
  console.log("Single curved rafter n=2:", plan.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`).join(" | "));
}
// 5. Complex cranked piece (stand-in for a customer model): two legs with a void between them,
//    a heavy head block offset to one side, and a skewed brace. Nothing is symmetric.
{
  // Oriented box → closed triangle mesh. c = centre, axes u/v/w (unit), half sizes a/b/c.
  const obox = (c, u, v, w, a, b, d) => {
    const P = [], I = [];
    for (const sz of [-1, 1]) for (const sy of [-1, 1]) for (const sx of [-1, 1])
      P.push(c[0] + sx * a * u[0] + sy * b * v[0] + sz * d * w[0], c[1] + sx * a * u[1] + sy * b * v[1] + sz * d * w[1], c[2] + sx * a * u[2] + sy * b * v[2] + sz * d * w[2]);
    for (const f of [[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]]) I.push(...f);
    return { pos: Float64Array.from(P), idx: Uint32Array.from(I) };
  };
  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
  const sl = Math.atan2(6, 16), ry = [0, Math.cos(sl), Math.sin(sl)], rz = [0, -Math.sin(sl), Math.cos(sl)]; // legs rise 6 m over 16 m
  const sk = Math.atan2(2.4, 9), bu = [Math.sin(sk), Math.cos(sk), 0];                                        // brace skewed in plan
  const parts = [
    { kg: 160000, mesh: obox([0.5, 8, 3.5], X, ry, rz, 0.5, 8.5, 0.5) },          // leg A
    { kg: 160000, mesh: obox([2.9, 8, 3.5], X, ry, rz, 0.5, 8.5, 0.5) },          // leg B (1.4 m void between legs)
    { kg: 190000, mesh: obox([2.4, 16.8, 7.5], X, Y, Z, 2.2, 1.4, 1.6) },          // heavy head block, offset towards B
    { kg: 24000,  mesh: obox([1.7, 5, 2.2], bu, [-bu[1], bu[0], 0], Z, 0.25, 4.65, 0.25) }, // skewed brace across the void
  ];
  const elems = parts.map((p) => ({ ...p, st: G.meshStats(p.mesh) }));
  const res = C.combine(elems.map((e) => ({ kg: e.kg, point: e.st.centroid })));
  const hm = G.buildHeightmap(elems.map((e) => e.mesh));
  assert.strictEqual(hm.top(res.cog.x, res.cog.y + 0.0), hm.top(res.cog.x, res.cog.y)); // sanity
  for (const n of [2, 3, 4, 6]) {
    const plan = G.planWithGeometry({ C, cog: res.cog, elems, hm, n, totalKg: res.totalKg });
    assert.ok(plan.points, plan.error);
    for (const p of plan.points) {
      const zt = hm.top(p.x, p.y);
      assert.ok(zt != null && Math.abs(zt - p.z) < 0.05, `cranked n=${n} ${p.label} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) is not on steel (top ${zt})`);
    }
    const sh = C.loadShares(plan.points, res.cog, res.totalKg);
    assert.ok(sh.stable, `cranked n=${n} unstable`);
    console.log(`Cranked piece n=${n}: loads ${sh.kg.map((v) => (v / 1000).toFixed(1) + " t").join(" / ")}${plan.notes.length ? " – " + plan.notes.join(" ") : ""}`);
  }
}
console.log("All geometry tests passed");
