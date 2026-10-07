# Lift COG – Trimble Connect 3D Viewer extension

Works out the **combined centre of gravity (COG)** of the elements selected in the 3D Viewer, so a crane hook can be placed directly above it.

> **Estimate only.** Results depend on the weights and geometry in the model. Confirm against the lift plan and a competent person before lifting.

## True geometry (recommended)
Trimble Connect only gives extensions each element's **bounding box**. That's fine for flat, square-on steel, but not for sloped, curved, cranked or open-frame loads. **Load true geometry** reads the model's own IFC, so the extension uses the **real shape**:
- **True centre of gravity:** the volume centroid of each element's actual solid, weighted by its weight.
- **Lifting points on real steel:** points are laid out with the rules below, then placed on the actual top surface. Any point over a gap is moved onto the nearest steel. If moving them breaks the balance, the pattern is drawn in until the load is balanced and stable.
- **Slopes, curves, arches and bent pieces** are handled automatically.

How it gets the IFC: **Load true geometry** asks once for permission to use your Trimble Connect sign-in (Connect shows a prompt). It then downloads the IFC of **every model that has elements in the selection**, one after another, straight from your project and its region, and matches them to the selection by element GUIDs. If one model can't be loaded (not an IFC, or the download fails), the others still load; the status line lists any that failed, and their elements use bounding boxes. Pressing the button again retries only the failed ones. Once true geometry is on, a later selection that includes another model loads that model automatically.

**Privacy:** the IFC is read **in your browser only** (with the open-source [web-ifc](https://github.com/ThatOpen/engine_web-ifc) library). It is not uploaded anywhere. Only the library code is fetched from jsDelivr.

Limits: the model in Connect must be an **IFC** (not `.ifczip` or a native Tekla/Revit file). Very large models take a while to read the first time; after that they stay loaded for the session. If a model was moved in Connect, a clear offset (over 1 m) between the IFC and the viewer is detected and corrected.

## How to use
1. Open the model in the 3D Viewer and open the **Lift COG** panel.
2. Select every element that will be lifted together (Ctrl/Shift-click, or select an assembly).
3. The panel shows the total weight and COG X / Y / Z in metres (model coordinates).
4. **Show marker** places a pink **single point measurement** at the COG in the 3D view (the same markup as Measure → Single point, so it shows the coordinates and appears in the measurement list). **Clear marker** removes only that point, not your other measurements.
5. **Lifting points:** choose 1, 2, 3, 4, 6 or 8 points and a layout, and blue single-point markups appear on top of the elements, labelled with the load each one carries. They update automatically when you change the selection or settings. **Hide lifting points** removes them.
   - **Sloped, diagonal or curved loads without true geometry:** a bounding box can't show where their top surface is, so the panel doesn't draw points in mid-air. It asks you to **Load true geometry** or to **Pick lifting points**.
   - **Choosing the points yourself** (designed lifting lugs, special rigging): click **Pick lifting points**, then click the element wherever a sling attaches. Each click snaps to the model surface, so every point is on the element, and the loads and stability update after each click. Press **Finish picking** when done. **Clear picked points** goes back to automatic placement. Picked points are remembered for each selection.
6. **Copy result** copies a summary, the per-element table and the lifting points (paste into Excel or the lift plan).

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

## How lifting points are placed
- Points are laid out **symmetrically about the COG**, so on a rigid load every point carries an equal share.
- **1 point:** directly above the COG.
- **2 points:** along the longer plan axis, about 0.207 × length in from each end (the spacing that minimises bending in a uniform beam), centred on the COG.
- **3 points:** a triangle with its centroid on the COG (wide loads), or a line (narrow loads).
- **4, 6, 8, 10, 12 points:** two rows either side of the COG (wide loads), or a line (narrow loads).
- **Layout → Auto** spreads points over the footprint when the load is at least a quarter as wide as it is long; otherwise it puts them in a line. You can force either.
- **Flat, square-on loads:** each point is dropped onto the **top of the element below it** (from its bounding box).
- Each element is checked on its own: it is treated as sloped when its box is over 1 m tall and taller than 15% of its length, and as diagonal when its box is wide relative to its length. If any element is and true geometry isn't loaded, points are not drawn (load true geometry or pick the points). **Vertical elements** (columns, posts, hangers) and **minor parts** under 5% of the total weight are left out of this check, so a frame of columns and flat beams doesn't need tracing.
- **Loads made of several parallel members** (frames, pairs of rafters, arched canopies, portal frames, ladders): when there are long members either side of the COG, the points go **on the members**, not in the gaps between them. This applies however many members are selected. The points are spread over as many members as the count allows, always including the two outermost, with the same number on each. For example, 3 arches: 4 points use the 2 outer arches and 6 points put 2 on each arch. 5 arches: 10 points put 2 on each. Members running in either plan direction are considered. For 2 points, or with **Along length**, a member running along the COG line is used instead.
- A point that lands in a gap between elements is moved onto the nearest element, and the loads are recalculated from the actual positions.
- **Load per point** is the most even split that keeps the load level (exact for 1, 2 and 3 points). With 4+ points, or 3+ in a line, the panel warns that equal shares assume a spreader beam or equalising rigging. Many rigging guides rate a 4-leg sling as if only 2 or 3 legs carry the load.
- If the COG falls outside the lifting points, the panel shows **Unstable**.
- **Hook height (optional):** draws sling lines to a hook above the COG and gives each leg's length, angle from horizontal and tension. Angles below 45° are flagged. Tensions exclude rigging weight and dynamic factors.

## Tips for accurate results
- **Tekla:** add `WEIGHT_GROSS` and `COG_X/Y/Z` to the IFC export's property sets so both weight and true centre of gravity come through.
- If the marker lands far away from the selection, change **Viewer coordinate units**.
- If you select an assembly *and* its parts, it can be counted twice. Select one or the other and check the element list.
- The extension only sees each element's bounding box and the points you click, not its true shape. For anything a box describes poorly, **Pick lifting points** is the reliable option.
- Lifting accessories (spreader bars, slings, shackles) are not in the model. Add their weight to the lift plan separately.

## Files
| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest – the URL you give Trimble Connect |
| `index.html`, `style.css` | Panel UI |
| `app.js` | Viewer wiring (selection, properties, bounding boxes, markups) |
| `cog.js` | Pure COG and lifting-point maths, no viewer dependency |
| `geo.js` | True geometry: IFC meshes (via web-ifc), volume centroids, top-surface height map, placing points on real steel |
| `test-cog.js` | `node test-cog.js` – unit tests for the COG and lifting-point maths |
| `test-frame.js`, `test-frame.json` | `node test-frame.js` – tests against real geometry: the curved-rafter frame and portal frame from `ARV_Sample_1.ifc`, and the arched canopy from `Korec_Tekla.ifc` (plus 2–8 arch copies) |
| `test-geo.mjs`, `test-geo-*.json` | `npm i web-ifc && node test-geo.mjs ARV_Sample_1.ifc Korec_Tekla.ifc test-geo-arv.json test-geo-korec.json` – checks geometry against IfcOpenShell reference values |
| `lift.svg`, `icon.svg` | Fallback lifting-point icon, panel icon |

## Deploy
1. Host the folder on any **HTTPS** static host (GitHub Pages, Netlify, Azure Static Web Apps…).
2. Replace `YOUR-HOST.example.com` in `manifest.json` with your real URLs.
3. Serve `manifest.json` with `Access-Control-Allow-Origin: *` (GitHub Pages does this by default).
4. In Trimble Connect: **Project Settings → Apps & Capabilities → Add Custom** → paste the manifest URL → enable.

Quick test without installing:
`https://web.connect.trimble.com/projects/<projectId>/viewer/3d?extension=https://YOUR-HOST/tc-extension/index.html`

API reference: https://components.connect.trimble.com/trimble-connect-workspace-api/modules.html
