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
const VERSION = "2.2.0";

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
const keyOf = (sel) => (Array.isArray(sel) ? sel : [])
  .filter((m) => m.objectRuntimeIds?.length)
  .map((m) => `${m.modelId}:${[...m.objectRuntimeIds].sort((x, y) => x - y).join(",")}`).sort().join("|");

function onEvent(event, args) {
  if (event === "viewer.onSelectionChanged") {
    const sel = args?.data ?? args ?? [];
    if (picking) {
      // Clicks made while picking can re-select or clear the element – ignore those.
      // Selecting a different element means the user has moved on: stop picking and follow them.
      const k = keyOf(sel);
      if (!k || k === picking.key) return;
      finishPicking();
    }
    queueSelection(sel);
  } else if (event === "viewer.onPicked") {
    onPicked(args?.data ?? args);
  } else if (event === "extension.accessToken") {
    onAccessToken(args?.data ?? args);
  }
}

let queuedKey = null; // selection waiting to load (debounced)
function queueSelection(sel, force = false) {
  const k = keyOf(sel);
  if (!force && (k === queuedKey || (queuedKey === null && k === selectionKey() && !loading))) return; // same as shown / already queued
  queuedKey = k;
  clearTimeout(timer);
  timer = setTimeout(() => { queuedKey = null; loadSelection(sel).catch((e) => log("Error:", String(e))); }, 250);
}

// Re-read the viewer's current selection (after tracing, or from the Refresh button).
async function resyncSelection() {
  if (!API) return;
  const sel = await API.viewer.getSelection().catch(() => null);
  const k = keyOf(sel);
  // An empty selection here usually means picking clicks cleared it – keep the element.
  if (k && k !== selectionKey()) queueSelection(sel);
}

// ---------- picking lifting points by hand ----------
// For shapes where you want to choose the attachment points yourself (designed lugs, special
// rigging), the user clicks where each sling attaches. Clicks snap to the model surface.
let picking = null; // { key, pts: [] } while waiting for clicks
let pickTimeout = null;
const selectionKey = () => keyOf(selection);

// Picked positions come in the viewer's units; choose the scale that puts them on the selection.
function toMetres(pos) {
  const box = result?.box, s = unitScale();
  const fits = (k) => box && ["x", "y", "z"].every((c) => pos[c] * k >= box.min[c] - 1 && pos[c] * k <= box.max[c] + 1);
  const k = [s, s * 0.001, s * 1000].find(fits);
  return k ? { x: pos.x * k, y: pos.y * k, z: pos.z * k } : null;
}

const PICK_LABEL = "Pick lifting points";
const pickTool = (text) => API.viewer.activateTool("picking", { snapTypes: ["surface", "edge", "point"], instruction: { title: "Lift COG – pick lifting points", text } });

const manual = new Map(); // selection key → [{ x, y, z }] in metres
const activeManual = () => manual.get(selectionKey()) || null;
function pickStatus(html, cls = "hint") { $("pickStatus").className = cls; $("pickStatus").innerHTML = html; }

async function startPickLift() {
  if (picking) return finishPicking();
  if (!result?.box) return pickStatus("Select the element first.", "err-text small");
  const key = selectionKey();
  manual.set(key, []);
  picking = { key, pts: [] };
  $("btnPickLift").textContent = "Finish picking";
  pickStatus("<strong>Click the element where each sling attaches.</strong> Loads update after every click.", "warn-text");
  recalc();
  armTimeout();
  try {
    await pickTool("Click where each sling attaches");
  } catch (e) {
    stopPicking();
    pickStatus(`The viewer's picking tool isn't available (${esc(e.message || e)}).`, "err-text small");
  }
}

function clearPicked() {
  if (picking) stopPicking();
  manual.delete(selectionKey());
  pickStatus("");
  recalc();
}

function showPickStatus() {
  const pts = activeManual();
  if (!pts) return pickStatus("");
  if (!pts.length) return pickStatus("No points picked – press <em>Pick lifting points</em> to start again.", "hint");
  const ok = lift?.shares?.stable;
  pickStatus(`${pts.length} point${pts.length > 1 ? "s" : ""} picked on the model. ${ok ? "The lift is stable – see the loads below." : "Not stable yet – see below."} <em>Clear picked points</em> returns to automatic placement.`, ok ? "ok-text" : "warn-text");
}

function armTimeout() {
  clearTimeout(pickTimeout);
  pickTimeout = setTimeout(() => picking && finishPicking(), 120000);
}

// Stop listening for clicks; the points picked so far stay in use.
function finishPicking() {
  stopPicking();
  showPickStatus();
}

function stopPicking() {
  const wasPicking = !!picking;
  picking = null;
  clearTimeout(pickTimeout);
  $("btnPickLift").textContent = PICK_LABEL;
  API?.viewer.activateTool("reset").catch(() => {});
  if (wasPicking) setTimeout(() => resyncSelection(), 300); // catch any selection change made while picking
}

function onPicked(data) {
  if (!picking) return;
  const det = Array.isArray(data) ? data[0] : data;
  if (!det?.position) return;
  const p = toMetres(det.position);
  if (!p) return pickStatus("That click wasn't on the selected element – click on it.", "err-text small");
  picking.pts.push(p);
  manual.set(picking.key, picking.pts.slice());
  armTimeout();
  log(`Lifting point ${picking.pts.length}: ${f(p.x)}, ${f(p.y)}, ${f(p.z)} m`);
  recalc();
  const ok = lift?.shares?.stable;
  pickStatus(`<strong>${picking.pts.length} point${picking.pts.length > 1 ? "s" : ""} picked.</strong> ${picking.pts.length < 2 ? "Keep clicking." : ok ? "Stable – keep clicking to add more, or press <em>Finish picking</em>." : "Not stable yet – the centre of gravity must be inside the points. Keep clicking."}`, ok ? "ok-text" : "warn-text");
  pickTool("Click where the next sling attaches, or press Finish picking").catch(() => {});
}

// ---------- true geometry (IFC read in the browser) ----------
// The viewer only exposes bounding boxes, so for the real shape the extension reads the model's
// IFC itself, downloaded from Trimble Connect with the user's own access. Nothing is uploaded
// anywhere – it stays in this browser tab.
const WEBIFC_VERSION = "0.0.78";
const WEBIFC_CDN = `https://cdn.jsdelivr.net/npm/web-ifc@${WEBIFC_VERSION}/`;
const REGION_HOSTS = {
  northAmerica: "https://app.connect.trimble.com", europe: "https://app21.connect.trimble.com",
  unitedKingdom: "https://app22.connect.trimble.com", asiaPacific: "https://app31.connect.trimble.com",
  australia: "https://app32.connect.trimble.com",
};
const REGION_ALIASES = { na: "northAmerica", us: "northAmerica", northamerica: "northAmerica", eu: "europe", europe: "europe",
  uk: "unitedKingdom", gb: "unitedKingdom", unitedkingdom: "unitedKingdom", ap: "asiaPacific", asia: "asiaPacific",
  asiapacific: "asiaPacific", au: "australia", aus: "australia", "ap-au": "australia", australia: "australia" };

const geoModels = new Map(); // modelId → { state: "loading"|"ready"|"error", model, name, offset, message }
let ifcApi = null, ifcApiPromise = null;
let accessToken = null, tokenWaiters = [];
let hmCache = { key: null, hm: null };

function geoStatus(html, cls = "hint") { $("geoStatus").className = cls; $("geoStatus").innerHTML = html; }
const geoReady = (modelId) => geoModels.get(modelId)?.state === "ready";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });
}

async function getIfcApi() {
  if (ifcApi) return ifcApi;
  if (!ifcApiPromise) ifcApiPromise = (async () => {
    if (!window.WebIFC) await loadScript(`${WEBIFC_CDN}web-ifc-api-iife.js`);
    const api = new window.WebIFC.IfcAPI();
    await api.Init((path) => WEBIFC_CDN + path, true); // single-threaded: no special page headers needed
    ifcApi = api;
    return api;
  })().catch((e) => { ifcApiPromise = null; throw e; });
  return ifcApiPromise;
}

// Connect access token: the user is asked once; afterwards Connect hands it over directly.
function onAccessToken(data) {
  const t = typeof data === "string" ? data : data?.accessToken || data?.token;
  if (t && t !== "pending" && t !== "denied") {
    accessToken = t;
    tokenWaiters.splice(0).forEach((w) => w.resolve(t));
  } else if (t === "denied") tokenWaiters.splice(0).forEach((w) => w.reject(new Error("denied")));
}
async function getAccessToken() {
  const r = await API.extension.requestPermission("accesstoken");
  if (r && r !== "pending" && r !== "denied") return (accessToken = r);
  if (r === "denied") throw new Error("denied");
  if (accessToken) return accessToken;
  geoStatus("Waiting for you to allow access in the Trimble Connect prompt…", "warn-text");
  return new Promise((resolve, reject) => {
    tokenWaiters.push({ resolve, reject });
    setTimeout(() => reject(new Error("No answer to the access prompt.")), 120000);
  });
}

async function regionHost() {
  const p = await API.project.getProject().catch(() => null);
  const loc = String(p?.location || "").trim();
  if (/^https?:\/\//i.test(loc)) { try { return new URL(loc).origin; } catch (e) { /* fall through */ } }
  const id = REGION_ALIASES[loc.toLowerCase().replace(/[\s_]/g, "")];
  if (id) return REGION_HOSTS[id];
  try { // the viewer page's own host usually is the project's region
    const ref = new URL(document.referrer);
    if (/connect\.trimble\.com$/.test(ref.hostname) && /^app\d*\./.test(ref.hostname)) return ref.origin;
  } catch (e) { /* ignore */ }
  return REGION_HOSTS.northAmerica;
}

async function downloadUrl(token, host, fileId, versionId) {
  const q = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
  let last = null;
  for (const v of ["2.1", "2.0"]) for (const path of [`/files/fs/${fileId}/downloadurl${q}`, `/files/${fileId}/downloadurl${q}`]) {
    try {
      const res = await fetch(`${host}/tc/api/${v}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      if (!res.ok) { last = new Error(`Connect API ${res.status}`); continue; }
      const data = await res.json();
      const url = data?.url || data?.downloadUrl || data?.signedUrl;
      if (url) return url;
    } catch (e) { last = e; }
  }
  throw last || new Error("Trimble Connect didn't return a download link.");
}

async function fetchWithProgress(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body?.getReader) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(), chunks = [];
  let got = 0, lastShown = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (got - lastShown > 2e6) { lastShown = got; geoStatus(`Downloading ${esc(label)}: ${(got / 1e6).toFixed(0)}${total ? ` of ${(total / 1e6).toFixed(0)}` : ""} MB…`, "warn-text"); }
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function openIfc(modelId, bytes, name) {
  geoStatus(`Reading ${esc(name)} (${(bytes.length / 1e6).toFixed(1)} MB)…`, "warn-text");
  await new Promise((r) => setTimeout(r, 30)); // let the status paint before the heavy parse
  const api = await getIfcApi();
  const t = performance.now();
  const model = await GEO.GeoModel.open(window.WebIFC, api, bytes);
  const prev = geoModels.get(modelId);
  if (prev?.model && prev.model !== model) prev.model.close();
  geoModels.set(modelId, { state: "ready", model, name, offset: null });
  log(`Geometry: ${name} read in ${((performance.now() - t) / 1000).toFixed(1)} s`);
}

// Download the IFC behind each selected model from Trimble Connect.
async function loadGeometryFromConnect() {
  const ids = [...new Set(selection.map((m) => m.modelId))];
  if (!ids.length) return geoStatus("Select the elements first, then load their geometry.", "err-text small");
  const specs = await API.viewer.getModels("loaded").catch(() => []);
  let token;
  try { token = await getAccessToken(); } catch (e) {
    return geoStatus(e.message === "denied"
      ? "Access wasn't allowed, so the model can't be downloaded. You can reset this in the extension's settings and try again."
      : `Couldn't get access to Trimble Connect (${esc(e.message)}). Try again in a moment.`, "err-text small");
  }
  const host = await regionHost();
  for (const modelId of ids) {
    if (geoReady(modelId)) continue;
    const spec = (Array.isArray(specs) ? specs : []).find((m) => m.id === modelId) || {};
    const name = spec.name || modelId;
    if (!/\.ifc(zip)?$/i.test(name) && !/ifc/i.test(spec.type || "")) {
      geoModels.set(modelId, { state: "error", name, message: "not an IFC file" });
      geoStatus(`${esc(name)} isn't an IFC file, so its geometry can't be read here. Export it to IFC and upload that to the project.`, "err-text small");
      continue;
    }
    if (/\.ifczip$/i.test(name)) {
      geoModels.set(modelId, { state: "error", name, message: "ifczip" });
      geoStatus(`${esc(name)} is a zipped IFC, which isn't supported yet. Upload the unzipped IFC to the project.`, "err-text small");
      continue;
    }
    try {
      geoModels.set(modelId, { state: "loading", name });
      geoStatus(`Getting a download link for ${esc(name)}…`, "warn-text");
      const url = await downloadUrl(token, host, modelId, spec.versionId);
      const bytes = await fetchWithProgress(url, name);
      await openIfc(modelId, bytes, name);
    } catch (e) {
      geoModels.set(modelId, { state: "error", name, message: String(e.message || e) });
      log("Geometry download failed:", String(e.message || e));
      geoStatus(`Couldn't download ${esc(name)} from Trimble Connect (${esc(e.message || e)}). Points use bounding boxes until it loads.`, "err-text small");
      return;
    }
  }
  await attachGeometry();
}

// Give every selected element its real mesh (where the model's IFC is loaded), then recalculate.
async function attachGeometry({ recalc: doRecalc = true } = {}) {
  const seq = loadSeq;
  let found = 0, missing = 0;
  for (const modelId of [...new Set(rows.map((r) => r.modelId))]) {
    const g = geoModels.get(modelId);
    if (g?.state !== "ready") continue;
    const mrows = rows.filter((r) => r.modelId === modelId && r.mesh === undefined);
    if (!mrows.length) continue;
    const guids = await API.viewer.convertToObjectIds(modelId, mrows.map((r) => r.id)).catch(() => []);
    if (seq !== loadSeq) return;
    mrows.forEach((r, i) => {
      const ex = guids[i] != null ? g.model.expressIdFor(guids[i]) : null;
      const mesh = ex != null ? g.model.mesh(ex) : null;
      r.mesh = mesh || null;
      r.geo = mesh ? GEO.meshStats(mesh) : null;
      if (mesh) found++; else missing++;
    });
    alignModel(modelId, g);
  }
  if (!found && !missing) return; // nothing new to attach
  hmCache = { key: null, hm: null };
  updateGeoStatus(found, missing);
  if (doRecalc) recalc();
}

// The viewer and the IFC normally share coordinates. If a model was moved in Connect, the meshes
// are shifted to match (only for clear offsets – the viewer's boxes are a little loose by nature).
function alignModel(modelId, g) {
  if (g.offset) return;
  const d = rows.filter((r) => r.modelId === modelId && r.geo && r.box).map((r) => ["x", "y", "z"].map((k) => r.box.min[k] - r.geo.min[k]));
  if (!d.length) return;
  const med = [0, 1, 2].map((k) => d.map((v) => v[k]).sort((a, b) => a - b)[Math.floor(d.length / 2)]);
  g.offset = Math.hypot(...med) > 1 ? { x: med[0], y: med[1], z: med[2] } : { x: 0, y: 0, z: 0 };
  if (g.offset.x || g.offset.y || g.offset.z) log(`Geometry offset for ${g.name}: ${med.map((v) => v.toFixed(2)).join(", ")} m`);
}
function shifted(r) {
  const o = geoModels.get(r.modelId)?.offset;
  if (!r.mesh || !o || (!o.x && !o.y && !o.z)) return r.mesh;
  if (r._shifted) return r._shifted;
  const pos = Float64Array.from(r.mesh.pos);
  for (let i = 0; i < pos.length; i += 3) { pos[i] += o.x; pos[i + 1] += o.y; pos[i + 2] += o.z; }
  return (r._shifted = { pos, idx: r.mesh.idx });
}
const shiftPoint = (r, p) => { const o = geoModels.get(r.modelId)?.offset; return p && o ? { x: p.x + o.x, y: p.y + o.y, z: p.z + o.z } : p; };

function updateGeoStatus(found, missing) {
  const ready = [...geoModels.values()].filter((g) => g.state === "ready");
  if (!ready.length) return;
  const withMesh = rows.filter((r) => r.mesh).length;
  geoStatus(`Using true geometry from ${ready.map((g) => esc(g.name)).join(", ")} – ${withMesh} of ${rows.length} selected element${rows.length === 1 ? "" : "s"} matched.${missing ? ` ${missing} couldn't be found in the IFC and use their bounding box.` : ""}`, withMesh ? "ok-text" : "warn-text");
}

function geometryHeightmap() {
  const meshed = rows.filter((r) => r.mesh);
  const key = selectionKey() + "|" + meshed.length;
  if (hmCache.key !== key) hmCache = { key, hm: meshed.length ? GEO.buildHeightmap(meshed.map(shifted)) : null };
  return hmCache.hm;
}

// ---------- data loading ----------
let loadSeq = 0; // only the most recent selection load is allowed to update the panel

let loading = false;
async function loadSelection(sel) {
  const seq = ++loadSeq;
  loading = true;
  const newSel = Array.isArray(sel) ? sel.filter((m) => m.objectRuntimeIds?.length) : [];
  const total = newSel.reduce((n, m) => n + m.objectRuntimeIds.length, 0);
  $("selCount").textContent = total;
  log(`Selection: ${total} object${total === 1 ? "" : "s"}`);
  if (!total) { selection = []; rows = []; loading = false; return recalc(); } // clears the result, plan and markups
  if (total > MAX_OBJECTS) log(`${total} objects selected – only the first ${MAX_OBJECTS} are used.`);

  $("elements").innerHTML = '<span class="muted">Reading properties…</span>';
  const newRows = [];
  let budget = MAX_OBJECTS;
  for (const { modelId, objectRuntimeIds } of newSel) {
    const ids = objectRuntimeIds.slice(0, budget);
    budget -= ids.length;
    if (!ids.length) break;
    const [props, boxes] = await Promise.all([
      API.viewer.getObjectProperties(modelId, ids).catch((e) => (log("Properties failed:", String(e)), [])),
      API.viewer.getObjectBoundingBoxes(modelId, ids).catch((e) => (log("Bounding boxes failed:", String(e)), [])),
    ]);
    if (seq !== loadSeq) return; // a newer selection arrived while we were waiting – drop this one
    const propById = new Map((props || []).map((p) => [p.id, p]));
    const boxById = new Map((boxes || []).map((b) => [b.id, b.boundingBox]));
    for (const id of ids) newRows.push({ modelId, id, obj: propById.get(id) || { id }, rawBox: boxById.get(id) || null });
  }
  if (seq !== loadSeq) return;
  selection = newSel;
  rows = newRows;
  if (rows.some((r) => geoReady(r.modelId))) {
    await attachGeometry({ recalc: false }).catch((e) => log("Geometry:", String(e)));
    if (seq !== loadSeq) return;
  }
  loading = false;
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
    if (!(r.kg > 0) && !r.override && r.geo?.volume > 0 && density() > 0) {
      r.kg = r.geo.volume * density(); r.massSource = `True geometry volume × ${density()} kg/m³`;
    }
    if (r.geo?.centroid) {
      r.point = shiftPoint(r, r.geo.centroid); r.centreSource = "True geometry (volume centroid)"; r.approx = false;
    } else {
      const c = COG.findCentre(r.obj, r.box);
      r.point = c.point; r.centreSource = c.source; r.approx = c.approximate;
    }
  }
  result = rows.length ? COG.combine(rows) : null;
  if (result) result.box = COG.unionBox(rows.map((r) => r.box));
  planLift();
  render();
  if (liftVisible) scheduleLiftRedraw();
  if (markerVisible) { clearTimeout(markerTimer); markerTimer = setTimeout(() => showMarker().catch((e) => log("COG marker failed:", String(e))), 300); }
}
let markerTimer = null;

// ---------- lifting points ----------
function planLift() {
  lift = null;
  if (!result?.cog) return;
  const opts = { cog: result.cog, boxes: rows.map((r) => (r.box ? { ...r.box, kg: r.kg } : null)), n: parseInt($("nPoints").value, 10), layout: $("layout").value };
  const man = activeManual();
  if (!man && !picking) pickStatus(""); // any picking message belonged to a different selection
  let plan;
  if (man) {
    // Points the user clicked on the model – used exactly as picked.
    if (!man.length) { lift = { awaitingPicks: true }; return; }
    plan = { points: man.map((p, i) => ({ label: `P${i + 1}`, ...p })), layout: "picked", axis: "picked", notes: [] };
  } else if (rows.some((r) => r.mesh)) {
    // True geometry: real top surfaces, no tracing needed.
    const hm = geometryHeightmap();
    const elems = rows.filter((r) => r.mesh).map((r) => ({ mesh: shifted(r), kg: r.kg }));
    plan = GEO.planWithGeometry({ C: COG, cog: result.cog, elems, hm, n: opts.n, layout: opts.layout, totalKg: result.totalKg });
    if (plan?.error) { lift = { error: plan.error }; return; }
    const without = rows.filter((r) => !r.mesh).length;
    if (plan && without) plan.notes.push(`${without} element${without > 1 ? "s" : ""} weren't found in the IFC, so ${without > 1 ? "they aren't" : "it isn't"} used for placing points.`);
  } else {
    // A bounding box is only a good stand-in for the top surface of flat, axis-aligned loads.
    // Checked per element, ignoring columns and small parts (see COG.needsTrace).
    const flags = COG.needsTrace(rows.map((r) => ({ box: r.box, kg: r.kg })));
    if (flags.sloped || flags.skewed) { lift = { needsTrace: true, flags }; return; }
    plan = COG.planLiftPoints(opts);
  }
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

// What the 3D view should show, rounded to the millimetre / kilogram. If it hasn't changed since
// the last draw, the markups are left alone instead of being deleted and redrawn.
let drawnSig = null, liftIdsUnknown = false;
function liftSignature() {
  if (!lift || !lift.points) return `none:${lift?.needsTrace ? 1 : 0}:${lift?.awaitingPicks ? 1 : 0}:${lift?.error || ""}`;
  const r = (v) => Math.round(v * 1000);
  return JSON.stringify([
    lift.points.map((p) => [r(p.x), r(p.y), r(p.z)]),
    $("labels").checked ? lift.shares?.kg.map((v) => Math.round(v)) : 0,
    lift.slings ? [r(lift.slings.hook.x), r(lift.slings.hook.y), r(lift.slings.hook.z)] : 0,
  ]);
}

async function drawLift({ force = false } = {}) {
  const sig = liftSignature();
  if (!force && sig === drawnSig) return; // nothing to change in the 3D view
  drawnSig = sig;
  await clearLift();
  if (!lift || !lift.points) {
    liftStatus(lift?.needsTrace ? "Not drawn – load true geometry or pick the points (see below)."
      : lift?.awaitingPicks ? "Click the element where each sling attaches."
      : lift?.error ? "Not drawn – see below." : "", lift ? "warn-text" : "muted");
    return;
  }
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
  liftIdsUnknown = !ids.length && !liftIcons.length; // viewer didn't report ids – sweep by colour next time

  const where = lift.points.map((p) => `${p.label} (${f(p.x, 2)}, ${f(p.y, 2)}, ${f(p.z, 2)})`).join(", ");
  log(`Lifting points drawn: ${where}`);
  if (problems.length) {
    problems.forEach((p) => log(p.replace(/<[^>]+>/g, "")));
    liftStatus(problems.join("<br>"), "err-text small");
  } else {
    liftStatus(`Showing ${lift.points.length} lifting point${lift.points.length > 1 ? "s" : ""} in blue.`, "ok-text");
  }
}

let liftSwept = false;
async function clearLift({ sweep = false } = {}) {
  if (liftIds.length) await API.markup.removeMarkups(liftIds).catch(() => {});
  liftIds = [];
  if (liftIcons.length) await API.viewer.removeIcon(liftIcons).catch(() => {});
  liftIcons = [];
  // Searching the viewer for stray blue markups is only needed once (leftovers from an earlier
  // session), when the viewer didn't report ids, or when the user hides the points.
  if (sweep || liftIdsUnknown || !liftSwept) { await sweepMarkups(LIFT_COLOR); liftSwept = true; liftIdsUnknown = false; }
}

// ---------- rendering ----------
function render() {
  // With true geometry the real top surface is known, so tracing isn't needed.
  const usingGeo = rows.some((r) => r.mesh);
  void usingGeo;
  renderResult();
  renderLift();
  renderElements();
}

// One-line description of how the points were placed.
function layoutText(l) {
  const how = { members: "on the members either side of the COG", area: "spread over the load", line: "in a line along the load", single: "single point over the COG" }[l.layout] || l.layout;
  if (l.layout === "picked") return `${l.points.length} point${l.points.length > 1 ? "s" : ""} you picked on the model (on its surface). Hook directly above the centre of gravity.`;
  if (l.axis === "geometry") return `Placed on the real top surface of the steel, from the model's IFC (true geometry). Layout: ${how}.`;
  return `Layout: ${how}. Points sit on top of the element below them (from its bounding box).`;
}

function renderLift() {
  if (!lift) {
    $("liftResult").innerHTML = '<span class="muted">Select elements with a known weight to plan lifting points.</span>';
    return;
  }
  if (lift.error) {
    $("liftResult").innerHTML = `<p class="err-text">${esc(lift.error)}</p>`;
    return;
  }
  if (lift.awaitingPicks) {
    $("liftResult").innerHTML = '<p class="warn-text">Click the element in the 3D view where each sling attaches. Each click adds a point and the loads are worked out straight away.</p>';
    return;
  }
  if (lift.needsTrace) {
    const what = [lift.flags.sloped && "sloped or curved", lift.flags.skewed && "running diagonally in plan"].filter(Boolean).join(" and ");
    $("liftResult").innerHTML = `<p class="warn-text"><strong>This load looks ${what}.</strong> Without its real shape the points would float above the steel, so they aren't drawn. Press <em>Load true geometry</em> (above) so the points sit on the real top surface, or use <em>Pick lifting points</em> to click them yourself.</p>`;
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
      : lift.layout === "picked"
        ? '<p class="warn-text">Loads are unequal because the points aren\'t symmetric about the centre of gravity. Move points to even them out, or rig for the shares shown.</p>'
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
    <div class="hint">${layoutText(lift)}</div>
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
let markerVisible = false; // when shown, the pink COG point follows the selection
let markerSig = null, markerSwept = false;
async function showMarker({ force = false } = {}) {
  const sig = result?.cog ? ["x", "y", "z"].map((k) => Math.round(result.cog[k] * 1000)).join(",") : "none";
  if (!force && sig === markerSig) return; // COG hasn't moved
  markerSig = sig;
  await clearMarker();
  if (!result?.cog) return;
  // Single point measurement markup (same as the viewer's Measure → Single point tool).
  // MarkupPick positions are in millimetres; result.cog is in metres.
  const [id] = await addMarkups("addSinglePointMarkups", [{ color: MARKER_COLOR, start: mm(result.cog) }]);
  markerId = id ?? null;
  if (markerId == null) markerSwept = false; // no id reported – find it by colour next time
  log(`COG point placed at ${f(result.cog.x)}, ${f(result.cog.y)}, ${f(result.cog.z)} m`);
}

async function clearMarker() {
  // Only removes our own (pink) COG point – the user's other measurements are left alone.
  if (markerId != null) await API.markup.removeMarkups([markerId]).catch(() => {});
  else if (!markerSwept) { await sweepMarkups(MARKER_COLOR); markerSwept = true; } // leftovers / unknown id
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
  if (lift?.points) {
    const sl = lift.slings;
    lines.push("", `Lifting points (${lift.points.length}, ${lift.layout}${lift.axis === "geometry" ? ", true geometry" : ""})${lift.shares.stable ? "" : " – UNSTABLE: COG outside lifting points"}`,
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

$("btnMarker").onclick = () => { markerVisible = true; if (!result?.cog) log("Nothing to mark yet."); showMarker({ force: true }).catch((e) => log("COG marker failed:", String(e))); };
$("btnClear").onclick = () => { markerVisible = false; markerSig = null; markerSwept = false; clearMarker().catch((e) => log(String(e))); };
$("btnFit").onclick = () => fit().catch((e) => log(String(e)));
$("btnCopy").onclick = () => copyResult().catch((e) => log(String(e)));
$("btnLift").onclick = () => { liftVisible = true; drawLift({ force: true }).catch((e) => { log("Lifting points:", String(e)); liftStatus(esc(String(e)), "err-text small"); }); };
$("version").textContent = `v${VERSION}`;
$("btnLiftClear").onclick = () => { liftVisible = false; drawnSig = null; clearLift({ sweep: true }).then(() => liftStatus("Lifting points hidden.")).catch((e) => log(String(e))); };
$("density").onchange = recalc;
$("units").onchange = recalc;
for (const id of ["nPoints", "layout", "hookHeight", "labels"]) $(id).onchange = recalc;
$("btnPickLift").onclick = () => startPickLift().catch((e) => { stopPicking(); pickStatus(esc(String(e)), "err-text small"); });
$("btnPickClear").onclick = clearPicked;
$("btnGeo").onclick = () => loadGeometryFromConnect().catch((e) => geoStatus(esc(String(e.message || e)), "err-text small"));
$("btnRefresh").onclick = async () => {
  if (picking) finishPicking();
  const sel = await API?.viewer.getSelection().catch(() => null);
  if (sel) queueSelection(sel, true);
};

main();
