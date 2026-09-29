# Toolbed

Photograph your tools on a sheet of Letter or A4 paper, click each one, and get a Gridfinity bin or a foam shadow-board insert cut to their shapes. It does what Tooltrace's designer does, and everything runs in the browser, so there's no server to host.

"Toolbed" is a working name. Rename it in `src/components/ui.tsx` (`APP_NAME`), in `index.html` (`<title>`), and in `package.json`.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, choose **Add New → Project** and import that repository. The Vite preset, `npm run build` and the `dist` output are picked up from `vercel.json`, so no environment variables are needed.
3. Deploy.

Or use the command line, from this folder: `npx vercel` for a preview, then `npx vercel --prod`.

## What it does

| Step | How |
|---|---|
| Photo | EXIF rotation applied, then working copy downscaled to 2048 px. Drag and drop, file picker, paste, or the bundled sample. |
| Paper | Click the sheet. The four corners are fitted with line fits along each edge, so a tool lying across the edge doesn't pull a corner out. The corner handles can be dragged, and a full homography corrects camera tilt. |
| Trace | Click a tool, click again to add missed parts, Shift-click to remove parts. There's a hover preview while tracing. **Trace in detail** re-runs the model on a crop of the full-resolution photo. |
| Tracer | SAM 2.1 tiny via transformers.js, on WebGPU where available with WASM as the fallback. It downloads once (65 MB standard, 155 MB precise) and is cached by the browser. If the model can't load, a simple selector takes over: brightness for the sheet, "not paper" for tools. |
| Layout | Drag, nudge with the arrow keys, rotate with R, or use **Arrange tightly**, which packs tools into the fewest grid cells. Circle and rectangle pockets can be added too. |
| Gridfinity | Standard 42 mm grid, feet, stacking lip, and magnet holes at the corners or in every cell. Each pocket gets its own depth, heights snap to the 7 mm grid, and finger scoops and engraved labels are optional. Contrasting pocket floors come out as a separate part, and large bins split along cell lines to fit your printer bed. |
| Foam | A cut layer on a ¼" backer. |
| Export | 3MF (bin and contrast floors as separate parts), STL, STEP, DXF (R12, mm), SVG (real size), a 1:1 size-check PDF, and a project file. |
| Storage | The current project autosaves in the browser (IndexedDB). Photos never leave the device. |

## How it's built

- **App**: Vite, React and Tailwind. Code is under `src/components`; state is in `src/state` (a zustand store plus a session module for bitmaps and workers).
- **Vision** (`src/lib/vision`):
  - paper homography;
  - outline smoothing;
  - mask tracing along pixel edges, which keeps sizes exact;
  - paper-quad fitting;
  - the no-AI selector.
- **Model worker** (`src/workers/sam.worker.ts`): encodes the image once, then each click only runs the small decoder.
- **CAD worker** (`src/workers/cad.worker.ts`): replicad (OpenCascade compiled to WASM) builds real solids for the preview and every export.

## Develop

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 27 unit tests: vision, paper fit, layout, CAD solids, exports
npm run build
```

`scripts/e2e_browser.py` drives the built app in headless Chromium with Playwright. It loads the sample photo, finds the paper, traces four tools, arranges them, builds the 3D bin, and downloads every export. `scripts/make_sample.py` regenerates `public/sample.jpg`.

## Test status

- The unit tests and the headless browser run pass.
- In the browser run, traced sizes matched the drawn ones to within 0.2 mm. For example, a 25.0 mm socket traced as 25.1 mm and a 177 mm wrench as 177 mm.
- All exported meshes are watertight.
- **Not yet checked:** the in-browser SAM model. The build sandbox couldn't reach Hugging Face, so that run used the simple selector. The code follows transformers.js 4.3's `Sam2Model` API, but check tracing on the deployed site first.

## Licences

| Component | Licence |
|---|---|
| replicad | MIT |
| replicad-opencascadejs | LGPL-2.1, loaded as a separate WASM file |
| transformers.js | Apache-2.0 |
| SAM 2.1 weights | Apache-2.0 |
| three.js | MIT |
| jsPDF | MIT |
| clipper-lib | Boost |
| fflate | MIT |
| DejaVu Sans (label font) | Free licence; see `public/fonts/LICENSE-DejaVu.txt` |
