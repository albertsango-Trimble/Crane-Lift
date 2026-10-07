# Lift COG – Trimble Connect 3D Viewer extension

Works out the **combined centre of gravity (COG)** of the elements selected in the 3D Viewer, so a crane hook can be placed directly above it.

> **Estimate only.** Results depend on the weights and geometry in the model. Confirm against the lift plan and a competent person before lifting.

## How to use
1. Open the model in the 3D Viewer and open the **Lift COG** panel.
2. Select every element that will be lifted together (Ctrl/Shift-click, or select an assembly).
3. The panel shows the total weight and COG X / Y / Z in metres (model coordinates).
4. **Show marker** places a pink **single point measurement** at the COG in the 3D view (the same markup as Measure → Single point, so it shows the coordinates and appears in the measurement list). **Clear marker** removes only that point, not your other measurements.
5. **Lifting points:** choose 1, 2, 3, 4, 6 or 8 points and a layout, and blue single-point markups appear on top of the elements, labelled with the load each one carries. They update automatically when you change the selection or settings. **Hide lifting points** removes them.
   - **Sloped, diagonal or curved elements** (rafters, raking beams, braces, cambered or vertically curved beams): the panel asks you to **trace** the element instead of drawing points in mid-air. Click **Trace element**, then click the top of the element near each end. The points update after the second click. **For a curved element, keep clicking points along the top** (at least one near the middle), then press **Finish trace**. If clicks aren't picked up, place **Measure → Single point** measurements along the top of the element and press **Use measured points**.
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
- **Traced loads:** points follow the traced profile: its direction in plan and the height of the top surface. With 2 trace points the profile is a straight line. With 3 clicks it is a parabola (the shape of a road or bridge vertical curve; within about 3 cm of a circular arch). With 4 or more clicks it is a parabola if one fits within 1 cm, otherwise a smooth curve through every click. On the canopy arches, 6 clicks follow the real top within 12 mm. The line is moved sideways so it passes over the COG, so points stay symmetric and loads stay equal. Points are placed along the full member length, even if your clicks weren't right at the ends.
- Each element is checked on its own: it is treated as sloped when its box is over 1 m tall and taller than 15% of its length, and as diagonal when its box is wide relative to its length. If any element is, points are not drawn until the load is traced. **Vertical elements** (columns, posts, hangers) and **minor parts** under 5% of the total weight are left out of this check, so a frame of columns and flat beams doesn't need tracing.
- **Loads made of several parallel members** (frames, pairs of rafters, arched canopies, portal frames, ladders): when there are long members either side of the COG, the points go **on the members**, not in the gaps between them. This applies however many members are selected. The points are spread over as many members as the count allows, always including the two outermost, with the same number on each. For example, 3 arches: 4 points use the 2 outer arches and 6 points put 2 on each arch. 5 arches: 10 points put 2 on each. Members running in either plan direction are considered. For 2 points, or with **Along length**, a member running along the COG line is used instead. For traced loads, every member takes the traced profile, adjusted for any difference in height between members.
- A point that lands in a gap between elements is moved onto the nearest element, and the loads are recalculated from the actual positions.
- **Load per point** is the most even split that keeps the load level (exact for 1, 2 and 3 points). With 4+ points, or 3+ in a line, the panel warns that equal shares assume a spreader beam or equalising rigging. Many rigging guides rate a 4-leg sling as if only 2 or 3 legs carry the load.
- If the COG falls outside the lifting points, the panel shows **Unstable**.
- **Hook height (optional):** draws sling lines to a hook above the COG and gives each leg's length, angle from horizontal and tension. Angles below 45° are flagged. Tensions exclude rigging weight and dynamic factors.

## Tips for accurate results
- **Tekla:** add `WEIGHT_GROSS` and `COG_X/Y/Z` to the IFC export's property sets so both weight and true centre of gravity come through.
- If the marker lands far away from the selection, change **Viewer coordinate units**.
- If you select an assembly *and* its parts, it can be counted twice. Select one or the other and check the element list.
- Untraced layouts follow the X or Y axis of the model. If a load is rotated in plan but not flagged, use **Trace element** anyway – it works for any straight member.
- Trace along the **top** of the element. Points are placed at the height of the profile you trace.
- For curved elements, click near both ends and at least once in the middle. Points beyond your outermost clicks have their height extrapolated, and the panel says so.
- The trace is straight in plan. Elements curved in plan (horizontal curves) aren't supported yet.
- For a curved element without a COG property, the COG is the centre of its bounding box. That is close for symmetric curves but not exact.
- Lifting accessories (spreader bars, slings, shackles) are not in the model. Add their weight to the lift plan separately.

## Files
| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest – the URL you give Trimble Connect |
| `index.html`, `style.css` | Panel UI |
| `app.js` | Viewer wiring (selection, properties, bounding boxes, markups) |
| `cog.js` | Pure COG and lifting-point maths, no viewer dependency |
| `test-cog.js` | `node test-cog.js` – unit tests for the COG and lifting-point maths |
| `test-frame.js`, `test-frame.json` | `node test-frame.js` – tests against real geometry: the curved-rafter frame and portal frame from `ARV_Sample_1.ifc`, and the arched canopy from `Korec_Tekla.ifc` (plus 2–8 arch copies) |
| `lift.svg`, `icon.svg` | Fallback lifting-point icon, panel icon |

## Deploy
1. Host the folder on any **HTTPS** static host (GitHub Pages, Netlify, Azure Static Web Apps…).
2. Replace `YOUR-HOST.example.com` in `manifest.json` with your real URLs.
3. Serve `manifest.json` with `Access-Control-Allow-Origin: *` (GitHub Pages does this by default).
4. In Trimble Connect: **Project Settings → Apps & Capabilities → Add Custom** → paste the manifest URL → enable.

Quick test without installing:
`https://web.connect.trimble.com/projects/<projectId>/viewer/3d?extension=https://YOUR-HOST/tc-extension/index.html`

API reference: https://components.connect.trimble.com/trimble-connect-workspace-api/modules.html
