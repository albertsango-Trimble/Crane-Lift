// Tests against real geometry from ARV_Sample_1.ifc: the curved-rafter frame (2 rafters + 3 cross beams, 1.40 t).
// Run: node test-frame.js
const C = require("./cog.js");
const assert = require("assert");
const frame = require("./test-frame.json");

const near = (a, b, t) => Math.abs(a - b) <= t;
const v3 = (a) => ({ x: a[0], y: a[1], z: a[2] });
const els = frame.elements;
const rafters = els.filter((e) => e.topProfile);
// True top-surface height of a rafter at y (linear between ray-cast samples, 50 mm apart).
const trueTop = (r, y) => {
  const P = r.topProfile;
  for (let i = 0; i < P.length - 1; i++) if (y >= P[i][0] && y <= P[i + 1][0]) return P[i][1] + ((P[i + 1][1] - P[i][1]) * (y - P[i][0])) / (P[i + 1][0] - P[i][0]);
  return null;
};

// The viewer's boxes are looser than the mesh (seen in the panel: 13.95 × 3.12 m vs 13.82 × 2.54 m), so test both.
for (const [label, inflate] of [["mesh boxes", { y: 0, zTop: 0 }], ["viewer-like boxes", { y: 0.065, zTop: 0.58 }]]) {
  const boxes = els.map((e) => ({ min: { ...v3(e.min), y: e.min[1] - inflate.y }, max: { ...v3(e.max), y: e.max[1] + inflate.y, z: e.max[2] + inflate.zTop } }));
  const rows = els.map((e, i) => ({ kg: e.weight, point: C.boxCentre(boxes[i]) }));
  const res = C.combine(rows);
  assert.ok(near(res.totalKg, 1397.56, 0.01), res.totalKg);
  const cog = res.cog;
  assert.ok(near(cog.x, 21.0, 0.01), `COG x ${cog.x}`);
  assert.ok(C.looksSloped(C.unionBox(boxes)).sloped, "frame should ask for a trace");

  // Trace: 3 clicks along the top of the X = 18 rafter
  const r18 = rafters.find((r) => near(r.xCentre, 18, 0.01));
  const clicks = [3.2, 9.6, 16.1].map((y) => ({ x: 18.0, y, z: trueTop(r18, y) }));

  for (const n of [4, 6, 8]) {
    const plan = C.planOnAxis({ cog, pts: clicks, boxes, n, layout: "auto" });
    assert.ok(!plan.error, plan.error);
    assert.strictEqual(plan.layout, "members", `${label} n=${n}: ${plan.layout}`);
    for (const p of plan.points) {
      const r = rafters.find((rr) => near(rr.xCentre, p.x, 0.02));
      assert.ok(r, `${label} n=${n} ${p.label} at x ${p.x.toFixed(3)} is not on a rafter`);
      const zt = trueTop(r, p.y);
      assert.ok(near(p.z, zt, 0.02), `${label} n=${n} ${p.label} z ${p.z.toFixed(3)} vs rafter top ${zt.toFixed(3)} at y ${p.y.toFixed(2)}`);
    }
    const sh = C.loadShares(plan.points, cog, res.totalKg);
    assert.ok(sh.stable, `${label} n=${n} unstable`);
    assert.ok(sh.kg.every((v) => near(v, res.totalKg / n, 0.5)), `${label} n=${n} shares ${sh.kg.map((v) => v.toFixed(1))}`);
  }

  // 2 points: one on each rafter, across the COG
  let plan = C.planOnAxis({ cog, pts: clicks, boxes, n: 2 });
  assert.strictEqual(plan.layout, "members");
  assert.deepStrictEqual(plan.points.map((p) => Math.round(p.x)).sort(), [18, 24]);
  assert.ok(C.loadShares(plan.points, cog, res.totalKg).stable);
  // 3 points: 2 on one rafter, 1 on the other; on steel, stable
  plan = C.planOnAxis({ cog, pts: clicks, boxes, n: 3 });
  assert.ok(plan.points.every((p) => rafters.some((r) => near(r.xCentre, p.x, 0.02))));
  assert.ok(C.loadShares(plan.points, cog, res.totalKg).stable);

  // A single rafter on its own still gets points along its own line (no member mode)
  const one = [boxes[0]];
  plan = C.planOnAxis({ cog: C.boxCentre(one[0]), pts: clicks, boxes: one, n: 4, layout: "line" });
  assert.notStrictEqual(plan.layout, "members");
  for (const p of plan.points) assert.ok(near(p.x, 18, 0.02) && near(p.z, trueTop(r18, p.y), 0.02), `single rafter ${p.label}`);
  console.log(`Frame tests passed (${label})`);
}

// ======== Portal frame from the same IFC: 4 columns (2 taller) + 3 top beams, 2484 kg ========
{
  const P = frame.portal;
  const boxes = P.map((e) => ({ min: v3(e.min), max: v3(e.max) }));
  const res = C.combine(P.map((e, i) => ({ kg: e.weight, point: C.boxCentre(boxes[i]) })));
  assert.ok(near(res.totalKg, 2484.0, 0.1) && near(res.cog.x, 3.0, 0.005) && near(res.cog.y, 2.869, 0.005), JSON.stringify(res.cog));

  // Columns make the selection 6.49 m tall, but nothing is sloped – no trace needed.
  const flags = C.needsTrace(P.map((e, i) => ({ box: boxes[i], kg: e.weight })));
  assert.ok(!flags.sloped && !flags.skewed, JSON.stringify(flags));
  assert.strictEqual(flags.vertical, 4);
  // ...while the curved-rafter frame still asks for one.
  assert.ok(C.needsTrace(frame.elements.map((e) => ({ box: { min: v3(e.min), max: v3(e.max) }, kg: e.weight }))).sloped);

  const sideBeams = P.filter((e) => e.name === "BEAM" && e.max[1] - e.min[1] > 4); // along Y at X 0 and X 6
  for (const n of [4, 6, 8]) {
    const plan = C.planLiftPoints({ cog: res.cog, boxes, n });
    assert.strictEqual(plan.layout, "members", `portal n=${n}: ${plan.layout}`);
    for (const p of plan.points) {
      const b = sideBeams.find((e) => p.x >= e.min[0] - 1e-6 && p.x <= e.max[0] + 1e-6 && p.y >= e.min[1] && p.y <= e.max[1]);
      assert.ok(b, `portal n=${n} ${p.label} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) not on a top beam`);
      assert.ok(near(p.z, b.max[2], 1e-6), `${p.label} z ${p.z} vs beam top ${b.max[2]}`);
    }
    const sh = C.loadShares(plan.points, res.cog, res.totalKg);
    assert.ok(sh.stable && sh.kg.every((v) => near(v, res.totalKg / n, 0.5)), `portal n=${n} ${sh.kg.map((v) => v.toFixed(1))}`);
  }
  const two = C.planLiftPoints({ cog: res.cog, boxes, n: 2 });
  assert.ok(C.loadShares(two.points, res.cog, res.totalKg).stable);
  const three = C.planLiftPoints({ cog: res.cog, boxes, n: 3 });
  assert.ok(C.loadShares(three.points, res.cog, res.totalKg).stable);
  console.log("Portal frame tests passed");
}

// ======== Arched canopy from Korec_Tekla.ifc: 3 curved beams (X span 6 m, at Y 0/−3/−6) + 6 braces, 862.6 kg ========
{
  const K = frame.canopy;
  const arches = K.filter((e) => e.topProfile);
  const archTop = (a, x) => {
    const P = a.topProfile;
    for (let i = 0; i < P.length - 1; i++) if (x >= P[i][0] && x <= P[i + 1][0]) return P[i][1] + ((P[i + 1][1] - P[i][1]) * (x - P[i][0])) / (P[i + 1][0] - P[i][0]);
    return null;
  };
  const mid = arches.find((a) => near(a.yCentre, -3, 0.01));
  const clicks = [0.4, 2.9, 5.4].map((x) => ({ x, y: -3.0, z: archTop(mid, x) }));   // trace along the middle arch

  const run = (els, n, layout = "auto") => {
    const boxes = els.map((e) => ({ min: v3(e.min), max: v3(e.max) }));
    const res = C.combine(els.map((e, i) => ({ kg: e.weight, point: C.boxCentre(boxes[i]) })));
    const plan = C.planOnAxis({ cog: res.cog, pts: clicks, boxes, n, layout });
    return { res, plan, sh: C.loadShares(plan.points, res.cog, res.totalKg) };
  };
  const onArch = (p) => arches.find((a) => Math.abs(p.y - a.yCentre) < 0.08);

  // All 9 elements (the case that broke): COG sits over the middle arch
  for (const n of [4, 6, 8]) {
    const { res, plan, sh } = run(K, n);
    assert.ok(near(res.totalKg, 862.6, 0.1) && near(res.cog.y, -3.032, 0.005));
    assert.strictEqual(plan.layout, "members", `canopy n=${n}: ${plan.layout}`);
    for (const p of plan.points) {
      const a = onArch(p);
      assert.ok(a, `canopy n=${n} ${p.label} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) is not on an arch`);
      assert.ok(near(p.z, archTop(a, p.x), 0.04), `canopy n=${n} ${p.label} z ${p.z.toFixed(3)} vs arch top ${archTop(a, p.x).toFixed(3)}`);
    }
    assert.ok(sh.stable, `canopy n=${n} unstable`);
    if (n === 6) assert.strictEqual(new Set(plan.points.map((p) => Math.round(p.y))).size, 3, "6 points should use all three arches");
    else assert.ok(plan.points.every((p) => Math.abs(p.y + 3) > 2), `n=${n} should use the outer arches`);
  }
  // 2 points still go along the middle arch (the member under the COG)
  const two = run(K, 2);
  assert.notStrictEqual(two.plan.layout, "members");
  assert.ok(two.plan.points.every((p) => onArch(p) && near(p.y, -3.032, 0.01)) && two.sh.stable);
  // Two arches only (what already worked): still on the arches
  const pair = K.filter((e) => !(e.topProfile && near(e.yCentre, -6, 0.01)) && !(e.max[1] < -3.1));
  const pr = run(pair, 4);
  assert.strictEqual(pr.plan.layout, "members");
  assert.ok(pr.plan.points.every((p) => onArch(p)) && pr.sh.stable);
  console.log("Arched canopy tests passed");
}

// ======== "As many arches as I select": 2–8 copies of the real canopy arch, 3 m apart ========
{
  const src = frame.canopy.find((e) => e.topProfile && near(e.yCentre, -3, 0.01));
  const topAt = (x) => { const P = src.topProfile; for (let i = 0; i < P.length - 1; i++) if (x >= P[i][0] && x <= P[i + 1][0]) return P[i][1] + ((P[i + 1][1] - P[i][1]) * (x - P[i][0])) / (P[i + 1][0] - P[i][0]); return null; };
  const hw = (src.max[1] - src.min[1]) / 2;
  for (let k = 2; k <= 8; k++) {
    const ys = Array.from({ length: k }, (_, i) => -3 * i);
    const boxes = ys.map((y) => ({ min: { x: src.min[0], y: y - hw, z: src.min[2] }, max: { x: src.max[0], y: y + hw, z: src.max[2] } }));
    // braces between neighbouring arches at both ends and mid-span (lighter, crosswise)
    for (let i = 0; i < k - 1; i++) for (const x of [0, 2.9, 5.9]) boxes.push({ min: { x, y: ys[i + 1] + hw, z: 3.0 }, max: { x: x + 0.11, y: ys[i] - hw, z: 3.1 } });
    const kg = boxes.map((b, i) => (i < k ? 220.8 : 35));
    const res = C.combine(boxes.map((b, i) => ({ kg: kg[i], point: C.boxCentre(b) })));
    const clicks = [0.4, 2.9, 5.4].map((x) => ({ x, y: ys[0], z: topAt(x) }));
    for (const n of [2, 3, 4, 6, 8, 10, 12]) {
      const plan = C.planOnAxis({ cog: res.cog, pts: clicks, boxes, n });
      assert.ok(plan && !plan.error && plan.points.length === n, `k=${k} n=${n}`);
      for (const p of plan.points) {
        const onArch = ys.some((y) => Math.abs(p.y - y) <= hw + 1e-6);
        assert.ok(onArch, `k=${k} n=${n} ${p.label} at y ${p.y.toFixed(2)} is in a gap`);
        assert.ok(near(p.z, topAt(p.x), 0.04), `k=${k} n=${n} ${p.label} z ${p.z.toFixed(3)} vs ${topAt(p.x).toFixed(3)}`);
      }
      const sh = C.loadShares(plan.points, res.cog, res.totalKg);
      assert.ok(sh.stable, `k=${k} n=${n} unstable`);
      // points spread over the arches: at least min(k, n/2) different arches used for n ≥ 4 (when n divides evenly)
      if (n >= 4) {
        const used = new Set(plan.points.map((p) => Math.round(p.y))).size;
        assert.ok(used >= 2 && used <= k, `k=${k} n=${n} used ${used}`);
      }
    }
  }
  // More clicks → follows the circular arch closely (smooth curve through the clicks)
  const many = [0.2, 1.2, 2.2, 3.2, 4.2, 5.2].map((x) => ({ x, y: 0, z: topAt(x) }));
  const prof = C.fitProfile(many);
  let worst = 0;
  for (let x = 0.2; x <= 5.2; x += 0.05) worst = Math.max(worst, Math.abs(prof.zAt((x - prof.o.x) * prof.h.x + (0 - prof.o.y) * prof.h.y) - topAt(x)));
  assert.ok(worst < 0.015, `6-click fit worst error ${worst.toFixed(4)} m`);
  console.log(`Multi-arch tests passed (2–8 arches, 2–12 points; 6-click arch fit within ${(worst * 1000).toFixed(0)} mm)`);
}
