# Lift COG – Trimble Connect 3D Viewer extension

Works out the **combined centre of gravity (COG)** of the elements selected in the 3D Viewer, so a crane hook can be placed directly above it.

> **Estimate only.** Results depend on the weights and geometry in the model. Confirm against the lift plan and a competent person before lifting.

## How to use
1. Open the model in the 3D Viewer and open the **Lift COG** panel.
2. Select every element that will be lifted together (Ctrl/Shift-click, or select an assembly).
3. The panel shows the total weight and COG X / Y / Z in metres (model coordinates).
4. **Show marker** drops a red and white target at the COG in the 3D view.
5. **Copy result** copies a summary and per-element table (paste into Excel or the lift plan).

## How it calculates
Combined COG = Σ(mᵢ · cᵢ) / Σmᵢ

**Weight of each element (mᵢ), first match wins:**
1. A weight you typed into the element's box.
2. A weight/mass property in the model (kg). Gross weight is preferred over plain weight, then net. "Weight per metre" style properties are ignored.
3. A volume property × the density setting (default 7850 kg/m³ for steel). Change it for concrete (~2400) or timber.
4. None: the element is **excluded** and highlighted red. Type a weight to include it.

**Centre of each element (cᵢ):**
1. COG properties in the model, if present, such as Tekla `COG_X / COG_Y / COG_Z`. They are used only if they fall inside the element's bounding box.
2. Otherwise the **centre of the element's bounding box**, marked *approx*. This is exact for symmetric parts (beams, columns, plates) but not for asymmetric ones (angle cleats, brackets, precast with openings). For those, export COG from Tekla/your authoring tool.

## Tips for accurate results
- **Tekla:** add `WEIGHT_GROSS` and `COG_X/Y/Z` to the IFC export's property sets so both weight and true centre of gravity come through.
- If the marker lands far away from the selection, change **Viewer coordinate units**.
- If you select an assembly *and* its parts, it can be counted twice. Select one or the other and check the element list.
- Lifting accessories (spreader bars, slings, shackles) are not in the model. Add their weight to the lift plan separately.

## Files
| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest – the URL you give Trimble Connect |
| `index.html`, `style.css` | Panel UI |
| `app.js` | Viewer wiring (selection, properties, bounding boxes, marker) |
| `cog.js` | Pure COG maths, no viewer dependency |
| `test-cog.js` | `node test-cog.js` – unit tests for the maths |
| `cog.svg`, `icon.svg` | COG marker and panel icon |

## Deploy
1. Host the folder on any **HTTPS** static host (GitHub Pages, Netlify, Azure Static Web Apps…).
2. Replace `YOUR-HOST.example.com` in `manifest.json` with your real URLs.
3. Serve `manifest.json` with `Access-Control-Allow-Origin: *` (GitHub Pages does this by default).
4. In Trimble Connect: **Project Settings → Apps & Capabilities → Add Custom** → paste the manifest URL → enable.

Quick test without installing:
`https://web.connect.trimble.com/projects/<projectId>/viewer/3d?extension=https://YOUR-HOST/tc-extension/index.html`

API reference: https://components.connect.trimble.com/trimble-connect-workspace-api/modules.html
