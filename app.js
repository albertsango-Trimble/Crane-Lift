// Lift COG – Trimble Connect 3D Viewer extension
// Works out the combined centre of gravity of the selected elements so a crane hook
// can be positioned directly above it.

const $ = (id) => document.getElementById(id);
const MARKER_COLOR = { r: 255, g: 20, b: 147, a: 255 }; // pink (0–255 per channel)
let markerId = null; // id the viewer assigns to our COG point markup
const MAX_OBJECTS = 1000;

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
  if (!total) return render();
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
  render();
}

// ---------- rendering ----------
function render() {
  renderResult();
  renderElements();
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
  const [markup] = await API.markup.addSinglePointMarkups([{
    color: MARKER_COLOR,
    start: {
      positionX: result.cog.x * 1000,
      positionY: result.cog.y * 1000,
      positionZ: result.cog.z * 1000,
    },
  }]);
  markerId = markup?.id ?? null;
  log(`COG point placed at ${f(result.cog.x)}, ${f(result.cog.y)}, ${f(result.cog.z)} m`);
}

async function clearMarker() {
  // Only removes our own COG point – the user's other measurements are left alone.
  if (markerId != null) await API.markup.removeMarkups([markerId]).catch(() => {});
  markerId = null;
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
    await loadSelection(await API.viewer.getSelection());
  } catch (e) {
    setStatus("Not connected", "err");
    log("Could not connect – open this page inside the Trimble Connect 3D Viewer.", String(e));
  }
}

$("btnMarker").onclick = () => showMarker().catch((e) => log(String(e)));
$("btnClear").onclick = () => clearMarker().catch((e) => log(String(e)));
$("btnFit").onclick = () => fit().catch((e) => log(String(e)));
$("btnCopy").onclick = () => copyResult().catch((e) => log(String(e)));
$("density").onchange = recalc;
$("units").onchange = recalc;

main();
