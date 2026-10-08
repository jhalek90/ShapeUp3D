# ShapeUp3d — notes for working on this repo

Browser-based 3D modeler in the spirit of SketchUp Make 2017, for designing 3D-print
parts. TypeScript + Vite + Three.js, MIT. Everything runs client-side; the server only
serves static files. **Roadmap, milestone status and design decisions: [PLAN.md](PLAN.md).**

## Commands

```bash
npm run dev        # dev server (http://localhost:5173)
npm test           # vitest (unit tests, Node)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build into dist/
```

Run `npx tsc --noEmit`, `npx vitest run` and `npm run build` before calling anything done.

## Architecture (where things live)

- `src/core/` — geometry, **no three.js imports** (keeps it testable in Node).
  - `Mesh.ts` vertices/edges/faces (+ curves, guides, instances), invariants, `validate()`.
  - `Model.ts` root mesh + group/component definitions, edit context (`active`,
    `enter`/`exit`), `transact` (undo snapshots, per-mesh JSON caching), live previews.
  - `ops.ts` drawing: segment insertion, per-plane face rebuild (`rebuildPlane`), erase/merge.
  - `pushpull.ts`, `transform.ts` (move/rotate/scale/copy of vertices), `curves.ts`
    (circle/arc/polygon/offset), `groups.ts`, `scene.ts` (world-space snap geometry),
    `stl.ts` / `importMesh.ts` / `solid.ts` (STL I/O, watertight checks).
  - `affine.ts` = the `Transform` class (named so it doesn't collide with `transform.ts`).
- `src/inference/InferenceEngine.ts` — snapping (endpoints, midpoints, edges, faces, axes,
  intersections, guides, locks).
- `src/tools/` — one class per tool; `ToolManager`, shared `locks.ts`, `targets.ts`.
- `src/viewport/` — camera controller, renderer, 2D overlay, input routing.
- `src/app/` — `App` wiring, `Selection`, `DocumentController` (files/autosave), `StlController`.
- `src/io/` — `.su3d` document format (versioned JSON), file pickers, IndexedDB autosave.

## Conventions

- Model units are millimetres everywhere; `TOL = 0.001 mm`. Units only affect display/input.
- Every model change goes through `model.transact(name, (activeMesh, model) => …)`.
  Operations that touch meshes other than the active one must pass `{ scope: 'all' }`
  (the JSON cache and snap-geometry cache depend on this).
- Geometry ops get unit tests, including invariant checks (`mesh.validate()`),
  watertightness and signed volume (catches face-orientation bugs). Prefer adding a
  regression test that fails without the fix.
- Comments explain *why*; match the existing density. Plain, user-readable status text.

## Gotchas

- **Windows, case-insensitive filesystem**: never create a file differing from an existing
  one only by case (`Transform.ts` once overwrote `transform.ts`).
- Python edit scripts on Windows write CRLF; git normalizes to LF (`.gitattributes`).
- Browsers reserve Ctrl+T / Ctrl+N, so Select None is Ctrl+Shift+A and New is menu-only.
- Never commit the VPS IP or any secrets; scan staged diffs before committing.

## Browser testing (headless)

Unit tests can't catch interaction bugs, so features are also driven in a real browser:
`npm install playwright-core` in a scratch folder (not the repo), launch
`chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader'] })`
against `npx vite --port 5199`, and script mouse/keyboard. In dev builds `window.app` is
the `App` instance (camera, model, tools, selection) for inspecting state. Native file
dialogs can't be clicked headlessly: stub `window.showSaveFilePicker` /
`showOpenFilePicker` to exercise the real save/open code. Pitfalls seen: clicks snapping
to unintended geometry in zoomed-out views (draw in Top view with typed values), test
points that coincide with midpoints, and software-rendering slowness inflating timings.

## Deploy (not done yet)

Static files: `npm run build`, copy `dist/` to the VPS, serve with Caddy (see PLAN.md).
Ask the user before touching the server.
