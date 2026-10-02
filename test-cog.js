// Lift COG – Trimble Connect 3D Viewer extension
// Works out the combined centre of gravity of the selected elements so a crane hook
// can be positioned directly above it.

const $ = (id) => document.getElementById(id);
const MARKER_COLOR = { r: 255, g: 20, b: 147, a: 255 }; // pink (0–255 per channel)
let markerId = null; // id the viewer assigns to our COG point markup
const LIFT_COLOR = { r: 0, g: 120, b: 255, a: 255 }; // blue
let liftIds = [];        // markup ids for lifting points, labels and sling lines
let liftVisible = true;  // shown by default; markups follow changes automatically
let lift = null;         // last lifting plan
const MAX_OBJECTS = 1000;
const VERSION = "1.3.0";

let API = null;
let selection = [];   // [{ modelId, objectRuntimeIds }]
let rows = [];        // per-element data, see buildRows()
let result = null;    // last combined result
const overrides = new Map(); // "modelId:id" → kg typed by the user

// ---------- helpers ----------
function log(...args) {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  $("log").textContent = `${new Date().toLocaleTimeString()}  ${line}\n` + $("log").textContent;
  console.log("[lift-cog]", ...args);
}
const setStatus = (t, c) => { $("status").textContent = t; $("status").className = `status ${c}`; };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f = (n, d = 3) => (n == null ? "–" : n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const kg = (n) => (n == null ? "–" : n >= 1000 ? `${f(n / 1000, 2)} t` : `${f(n, 1)} kg`);
const unitScale = () => parseFloat($("units").value);
const density = () => parseFloat($("density").value) || 0;

// ---------- events ----------
let timer = null;
function onEvent(event, args) {
  if (event === "viewer.onSelectionChanged") {
    const sel = args?.data ?? args ?? [];
    clearTimeout(timer);
    timer = setTimeout(() => loadSelection(sel).catch((e) => log("Error:", String(e))), 250);
  }
}

// ---------- data loading ----------
async function loadSelection(sel) {
  selection = Array.isArray(sel) ? sel.filter((m) => m.objectRuntimeIds?.length) : [];
  const total = selection.reduce((n, m) => n + m.objectRuntimeIds.length, 0);
  $("selCount").textContent = total;
  rows = [];
  if (!total) return recalc(); // clears the result, lifting plan and (if shown) lifting markups
  if (total > MAX_OBJECTS) {
    log(`${total} objects selected – only the first ${MAX_OBJECTS} are used.`);
  }

  $("elements").innerHTML = '<span class="muted">Reading properties…</span>';
  let budget = MAX_OBJECTS;
  for (const { modelId, objectRuntimeIds } of selection) {
    const ids = objectRuntimeIds.slice(0, budget);
    budget -= ids.length;
    if (!ids.length) break;
    const [props, boxes] = await Promise.all([
      API.viewer.getObjectProperties(modelId, ids).catch((e) => (log("Properties failed:", String(e)), [])),
      API.viewer.getObjectBoundingBoxes(modelId, ids).catch((e) => (log("Bounding boxes failed:", String(e)), [])),
    ]);
    const propById = new Map(props.map((p) => [p.id, p]));
    const boxById = new Map(boxes.map((b) => [b.id, b.boundingBox]));
    for (const id of ids) rows.push({ modelId, id, obj: propById.get(id) || { id }, rawBox: boxById.get(id) || null });
  }
  recalc();
}

// Recompute masses/centres from cached data (cheap: runs on every setting/override change)
function recalc() {
  const s = unitScale();
  for (const r of rows) {
    r.box = r.rawBox ? COG.scaleBox(r.rawBox, s) : null;
    r.name = r.obj.product?.name || r.obj.name || r.obj.class || `Object ${r.id}`;
    const found = COG.findMass(r.obj, density());
    const key = `${r.modelId}:${r.id}`;
    r.override = overrides.has(key);
    r.kg = r.override ? overrides.get(key) : found.kg;
    r.massSource = r.override ? "Entered manually" : found.source;
    const c = COG.findCentre(r.obj, r.box);
    r.point = c.point; r.centreSource = c.source; r.approx = c.approximate;
  }
  result = rows.length ? COG.combine(rows) : null;
  if (result) result.box = COG.unionBox(rows.map((r) => r.box));
  planLift();
  render();
  if (liftVisible) scheduleLiftRedraw();
}

// ---------- lifting points ----------
function planLift() {
  lift = null;
  if (!result?.cog) return;
  const plan = COG.planLiftPoints({
    cog: result.cog,
    boxes: rows.map((r) => r.box),
    n: parseInt($("nPoints").value, 10),
    layout: $("layout").value,
  });
  if (!plan) return;
  const shares = COG.loadShares(plan.points, result.cog, result.totalKg);
  const sl = COG.slings(plan.points, result.cog, parseFloat($("hookHeight").value), shares.kg);
  lift = { ...plan, shares, slings: sl };
}

let liftTimer = null;
function scheduleLiftRedraw() {
  clearTimeout(liftTimer);
  liftTimer = setTimeout(() => drawLift().catch((e) => { log("Lifting points:", String(e)); liftStatus(esc(String(e)), "err-text small"); }), 300);
}

const mm = (p) => ({ positionX: p.x * 1000, positionY: p.y * 1000, positionZ: p.z * 1000 });
const sameColor = (a, b) => a && b && a.r === b.r && a.g === b.g && a.b === b.b;

// Calls a MarkupAPI add method and returns the ids it reports. Copes with viewers that
// return nothing, and throws a readable error if the method doesn't exist.
async function addMarkups(method, items) {
  if (!API.markup || typeof API.markup[method] !== "function") throw new Error(`markup.${method} is not available in this viewer`);
  const res = await API.markup[method](items);
  return Array.isArray(res) ? res.map((m) => m?.id).filter((id) => id != null) : [];
}

// Removes every point/text/line markup of the given colour. Used as a safety net because some
// viewer versions don't return ids, and so markups survive panel reloads.
async function sweepMarkups(color) {
  const ids = [];
  for (const get of ["getSinglePointMarkups", "getTextMarkups", "getLineMarkups"]) {
    if (typeof API.markup?.[get] !== "function") continue;
    const list = await API.markup[get]().catch(() => []);
    for (const m of Array.isArray(list) ? list : []) if (sameColor(m.color, color) && m.id != null) ids.push(m.id);
  }
  if (ids.length) await API.markup.removeMarkups(ids).catch(() => {});
}

function liftStatus(html, cls = "muted") {
  $("liftStatus").className = cls;
  $("liftStatus").innerHTML = html;
}

const LIFT_ICON_BASE = 880000; // ids for the icon fallback
let liftIcons = [];

async function drawLift() {
  await clearLift();
  if (!lift) { liftStatus(""); return; }
  const ids = [], problems = [];

  // 1. Points – blue single point measurements; fall back to blue icons if markups fail.
  try {
    ids.push(...await addMarkups("addSinglePointMarkups", lift.points.map((p) => ({ color: LIFT_COLOR, start: mm(p) }))));
  } catch (e) {
    problems.push(`Single point markups failed (${esc(e.message || e)}), showing icons instead.`);
    try {
      liftIcons = lift.points.map((p, i) => ({ id: LIFT_ICON_BASE + i, iconPath: new URL("lift.svg", location.href).href, position: { x: p.x, y: p.y, z: p.z }, size: 28 }));
      await API.viewer.addIcon(liftIcons);
    } catch (e2) {
      liftIcons = [];
      problems.push(`Icons failed too (${esc(e2.message || e2)}).`);
    }
  }

  // 2. Labels and 3. sling lines – optional extras, failures don't stop the points.
  if ($("labels").checked) {
    const up = Math.max(0.3, (result.box.max.z - result.box.min.z) * 0.5); // leader length (m)
    try {
      ids.push(...await addMarkups("addTextMarkup", lift.points.map((p, i) => ({
        color: LIFT_COLOR, start: mm(p), end: mm({ x: p.x, y: p.y, z: p.z + up }), text: `${p.label} ${kg(lift.shares.kg[i])}`,
      }))));
    } catch (e) { problems.push(`Labels failed (${esc(e.message || e)}).`); }
  }
  if (lift.slings) {
    try {
      ids.push(...await addMarkups("addLineMarkups", lift.points.map((p) => ({ color: LIFT_COLOR, start: mm(p), end: mm(lift.slings.hook) }))));
    } catch (e) { problems.push(`Sling lines failed (${esc(e.message || e)}).`); }
  }
  liftIds = ids;

  const where = lift.points.map((p) => `${p.label} (${f(p.x, 2)}, ${f(p.y, 2)}, ${f(p.z, 2)})`).join(", ");
  log(`Lifting points drawn: ${where}`);
  if (problems.length) {
    problems.forEach((p) => log(p.replace(/<[^>]+>/g, "")));
    liftStatus(problems.join("<br>"), "err-text small");
  } else {
    liftStatus(`Showing ${lift.points.length} lifting point${lift.points.length > 1 ? "s" : ""} in blue.`, "ok-text");
  }
}

async function clearLift() {
  if (liftIds.length) await API.markup.removeMarkups(liftIds).catch(() => {});
  liftIds = [];
  if (liftIcons.length) await API.viewer.removeIcon(liftIcons).catch(() => {});
  liftIcons = [];
  await sweepMarkups(LIFT_COLOR);
}

// ---------- rendering ----------
function render() {
  renderResult();
  renderLift();
  renderElements();
}

function renderLift() {
  if (!lift) {
    $("liftResult").innerHTML = '<span class="muted">Select elements with a known weight to plan lifting points.</span>';
    return;
  }
  const { points, shares, slings: sl, layout, notes } = lift;
  const W = result.totalKg;
  const head = `<tr><th>Point</th><th>X (m)</th><th>Y (m)</th><th>Z (m)</th><th>Load</th>${sl ? "<th>Sling</th><th>Angle*</th><th>Tension</th>" : ""}</tr>`;
  const body = points.map((p, i) => {
    const leg = sl?.legs[i];
    return `<tr><td><span class="dot"></span>${p.label}</td><td>${f(p.x)}</td><td>${f(p.y)}</td><td>${f(p.z)}</td>
      <td>${kg(shares.kg[i])}<div class="hint">${f((100 * shares.kg[i]) / W, 0)}%</div></td>
      ${leg ? `<td>${f(leg.length, 2)} m</td><td class="${leg.angleFromHorizontal < 45 ? "err-text" : ""}">${f(leg.angleFromHorizontal, 0)}°</td><td>${kg(leg.tensionKg)}</td>` : ""}</tr>`;
  }).join("");

  const msgs = [];
  if (!shares.stable) {
    msgs.push(`<p class="err-text"><strong>Unstable:</strong> the centre of gravity is outside the lifting points${shares.offset > 0.005 ? ` (${f(shares.offset * 1000, 0)} mm off their line)` : ""}. The load will tilt or roll. Choose a different number of points or layout.</p>`);
  } else if (points.length > 1) {
    const spread = Math.max(...shares.kg) - Math.min(...shares.kg);
    msgs.push(spread <= 0.01 * W
      ? '<p class="ok-text">Balanced: every point carries an equal share and the hook sits directly above the COG.</p>'
      : '<p class="warn-text">Loads are unequal because some points had to move onto an element – check the shares above.</p>');
  }
  if (!shares.determinate) {
    msgs.push(`<p class="warn-text">With ${points.length} points the shares assume the load is shared evenly, e.g. through a spreader beam or equalising rigging. With fixed-length slings a rigid load may hang on fewer points – many rigging guides rate a 4-leg sling as if only 2 or 3 legs carry the load.</p>`);
  }
  if (sl?.legs.some((l) => l.angleFromHorizontal < 45)) {
    msgs.push('<p class="err-text">Sling angle below 45° from horizontal – increase hook height or reduce point spacing.</p>');
  }
  for (const n of notes) msgs.push(`<p class="warn-text">${esc(n)}</p>`);

  $("liftResult").innerHTML = `
    <div class="hint">Layout: ${layout === "area" ? "spread over footprint" : layout === "line" ? `in a line along ${lift.axis.toUpperCase()}` : "single point over COG"}. Points sit on top of the element below them.</div>
    <table class="lift">${head}${body}</table>
    ${sl ? `<p class="hint">*Angle from horizontal. Hook at ${f(sl.hook.x)}, ${f(sl.hook.y)}, ${f(sl.hook.z)} m. Tension excludes rigging weight and dynamic factors.</p>` : ""}
    ${msgs.join("")}`;
}

function renderResult() {
  if (!result || !result.cog) {
    $("result").innerHTML = rows.length
      ? '<span class="err-text">No element has a usable weight. Enter weights below.</span>'
      : '<span class="muted">Select the elements that will be lifted together.</span>';
    return;
  }
  const { cog, totalKg, used, excluded, box } = result;
  const approxCount = rows.filter((r) => r.kg > 0 && r.approx).length;
  let rel = "";
  if (box) {
    const mid = COG.boxCentre(box);
    rel = `
      <tr><td>Offset from centre of selection (X, Y)</td><td>${f(cog.x - mid.x)} m, ${f(cog.y - mid.y)} m</td></tr>
      <tr><td>Height above lowest point</td><td>${f(cog.z - box.min.z)} m</td></tr>
      <tr><td>Selection extents (X × Y × Z)</td><td>${f(box.max.x - box.min.x, 2)} × ${f(box.max.y - box.min.y, 2)} × ${f(box.max.z - box.min.z, 2)} m</td></tr>`;
  }
  $("result").innerHTML = `
    <div class="big">${kg(totalKg)}</div>
    <table class="result">
      <tr><td>COG X</td><td><strong>${f(cog.x)} m</strong></td></tr>
      <tr><td>COG Y</td><td><strong>${f(cog.y)} m</strong></td></tr>
      <tr><td>COG Z</td><td><strong>${f(cog.z)} m</strong></td></tr>
      ${rel}
      <tr><td>Elements used</td><td>${used}${excluded ? ` <span class="err-text">(${excluded} excluded – no weight)</span>` : ""}</td></tr>
    </table>
    <p class="hint">Place the hook directly above (COG X, COG Y).</p>
    ${approxCount ? `<p class="warn-text">${approxCount} element(s) use the bounding-box centre as their centre of gravity. This is only accurate for symmetric parts.</p>` : ""}`;
}

function renderElements() {
  if (!rows.length) { $("elements").innerHTML = '<span class="muted">Nothing selected.</span>'; return; }
  const body = rows.map((r, i) => `
    <tr class="${r.kg > 0 ? "" : "missing"}">
      <td><div class="el-name">${esc(r.name)}</div>
          <div class="hint">${esc(r.massSource)}</div>
          <div class="hint">${esc(r.centreSource)}${r.approx ? ' <span class="tag">approx</span>' : ""}</div></td>
      <td class="num"><input type="number" min="0" step="0.1" data-i="${i}" value="${r.kg > 0 ? +r.kg.toFixed(1) : ""}" placeholder="kg" />
          ${r.override ? `<button class="link" data-reset="${i}">auto</button>` : ""}</td>
    </tr>`).join("");
  $("elements").innerHTML = `<table class="elements"><thead><tr><th>Element</th><th class="num">Weight (kg)</th></tr></thead><tbody>${body}</tbody></table>`;

  $("elements").querySelectorAll("input[data-i]").forEach((inp) => {
    inp.onchange = () => {
      const r = rows[+inp.dataset.i];
      const v = parseFloat(inp.value);
      const key = `${r.modelId}:${r.id}`;
      if (Number.isFinite(v) && v >= 0) overrides.set(key, v); else overrides.delete(key);
      recalc();
    };
  });
  $("elements").querySelectorAll("button[data-reset]").forEach((b) => {
    b.onclick = () => { const r = rows[+b.dataset.reset]; overrides.delete(`${r.modelId}:${r.id}`); recalc(); };
  });
}

// ---------- actions ----------
async function showMarker() {
  if (!result?.cog) return log("Nothing to mark yet.");
  await clearMarker();
  // Single point measurement markup (same as the viewer's Measure → Single point tool).
  // MarkupPick positions are in millimetres; result.cog is in metres.
  const [id] = await addMarkups("addSinglePointMarkups", [{ color: MARKER_COLOR, start: mm(result.cog) }]);
  markerId = id ?? null;
  log(`COG point placed at ${f(result.cog.x)}, ${f(result.cog.y)}, ${f(result.cog.z)} m`);
}

async function clearMarker() {
  // Only removes our own (pink) COG point – the user's other measurements are left alone.
  if (markerId != null) await API.markup.removeMarkups([markerId]).catch(() => {});
  markerId = null;
  await sweepMarkups(MARKER_COLOR);
}

async function fit() {
  if (!selection.length) return;
  await API.viewer.setCamera({ modelObjectIds: selection }, { animationTime: 400 });
}

async function copyResult() {
  if (!result?.cog) return;
  const lines = [
    `Lift COG – ${new Date().toLocaleString()}`,
    `Total weight: ${kg(result.totalKg)} (${result.used} elements${result.excluded ? `, ${result.excluded} excluded` : ""})`,
    `COG: X ${f(result.cog.x)} m, Y ${f(result.cog.y)} m, Z ${f(result.cog.z)} m`,
    "",
    "Element\tWeight (kg)\tWeight source\tCentre source",
    ...rows.map((r) => `${r.name}\t${r.kg > 0 ? r.kg.toFixed(1) : "-"}\t${r.massSource}\t${r.centreSource}`),
  ];
  if (lift) {
    const sl = lift.slings;
    lines.push("", `Lifting points (${lift.points.length}, ${lift.layout})${lift.shares.stable ? "" : " – UNSTABLE: COG outside lifting points"}`,
      `Point\tX (m)\tY (m)\tZ (m)\tLoad (kg)${sl ? "\tSling (m)\tAngle from horizontal (°)\tTension (kg)" : ""}`,
      ...lift.points.map((p, i) => [p.label, p.x.toFixed(3), p.y.toFixed(3), p.z.toFixed(3), lift.shares.kg[i].toFixed(1),
        ...(sl ? [sl.legs[i].length.toFixed(2), sl.legs[i].angleFromHorizontal.toFixed(0), sl.legs[i].tensionKg.toFixed(1)] : [])].join("\t")));
    if (!lift.shares.determinate) lines.push("Note: shares assume even load sharing (spreader beam / equalising rigging).");
  }
  await navigator.clipboard.writeText(lines.join("\n")).then(
    () => log("Result copied to clipboard"),
    () => log("Clipboard blocked – check the Log for the text") || log(lines.join("\n")),
  );
}

// ---------- boot ----------
async function main() {
  try {
    API = await TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000);
    setStatus("Connected", "ok");
    log(`Lift COG v${VERSION} connected`);
    await loadSelection(await API.viewer.getSelection());
  } catch (e) {
    setStatus("Not connected", "err");
    log("Could not connect – open this page inside the Trimble Connect 3D Viewer.", String(e));
  }
}

$("btnMarker").onclick = () => showMarker().catch((e) => log("COG marker failed:", String(e)));
$("btnClear").onclick = () => clearMarker().catch((e) => log(String(e)));
$("btnFit").onclick = () => fit().catch((e) => log(String(e)));
$("btnCopy").onclick = () => copyResult().catch((e) => log(String(e)));
$("btnLift").onclick = () => { liftVisible = true; drawLift().catch((e) => { log("Lifting points:", String(e)); liftStatus(esc(String(e)), "err-text small"); }); };
$("version").textContent = `v${VERSION}`;
$("btnLiftClear").onclick = () => { liftVisible = false; clearLift().then(() => liftStatus("Lifting points hidden.")).catch((e) => log(String(e))); };
$("density").onchange = recalc;
$("units").onchange = recalc;
for (const id of ["nPoints", "layout", "hookHeight", "labels"]) $(id).onchange = recalc;

main();
