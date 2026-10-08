# ShapeUp3d — Project Plan

A free, open-source, browser-based 3D modeler in the spirit of SketchUp Make 2017,
focused on designing parts for 3D printing.

> Not affiliated with or endorsed by Trimble or SketchUp. SketchUp is a trademark of Trimble Inc.

## Goals

- Feel like SketchUp: edges + faces, inference snapping, push/pull, type-exact dimensions.
- Produce clean, watertight STL output for 3D printing.
- 100% client-side. The server only serves static files — no accounts, no stored data.
- MIT licensed, open to contributions.

## Non-goals (for now)

- `.skp` import/export
- Accounts, cloud storage, sharing
- Plugin/extension API
- Touch/tablet input (mouse + keyboard only)
- Rendering/materials beyond simple colors

---

## Tech stack

| Concern | Choice |
|---|---|
| Language / build | TypeScript, Vite |
| Rendering | Three.js (WebGL) |
| Geometry core | Custom edge/face model (see below) — no framework dependency |
| Booleans | [Manifold](https://github.com/elalish/manifold) (WASM, Apache-2.0) |
| Tests | Vitest — the geometry core and unit parsing are heavily tested |
| UI | Plain TypeScript + CSS (no framework until it's clearly needed) |
| Hosting | Caddy serving `dist/` on the VPS |

## Architecture

```
src/
  core/        Geometry model: vertices, edges, faces, loops, groups, components.
               Pure TS, no Three.js imports. Fully unit-tested.
  ops/         Modeling operations on the core: split, merge, push/pull, follow-me,
               offset, transform. Each op is an undoable command.
  inference/   Snapping engine: points, edges, faces, axes, parallel/perpendicular,
               guides, "from point" tracking.
  tools/       One file per tool (Line, Rectangle, PushPull, ...). Tools consume
               mouse/keyboard events + inference, and emit ops.
  viewport/    Three.js scene, camera control, rendering the model, picking.
  io/          Native file format, STL import/export, later OBJ/3MF.
  solids/      Manifold bridge: booleans, watertight check.
  units/       Unit formatting and Measurements-box parsing.
  ui/          Toolbar, status bar, Measurements box, panels, dialogs.
```

**Rule:** `core/`, `ops/`, `units/` never import Three.js. That keeps the
geometry logic testable in Node and independent of rendering.

### Geometry data model

SketchUp allows non-manifold geometry (an edge shared by 3+ faces, loose edges),
so a strict half-edge structure doesn't fit. We use an edge-centric model:

- **Vertex** — id, position (mm, float64)
- **Edge** — id, two vertices, flags (`soft`, `smooth`, `hidden`), list of faces using it
- **Face** — id, plane, one outer loop + zero or more inner loops (holes);
  each loop is an ordered list of (edge, reversed?) uses
- **Group / ComponentInstance** — transform + reference to its own isolated entity
  collection (geometry inside a group doesn't stick to outside geometry)
- **ComponentDefinition** — shared geometry for all instances
- **Guide** — guide lines and guide points (from Tape Measure / Protractor)

Core behaviors (the "SketchUp magic"):
- Closing a coplanar loop of edges creates a face automatically.
- Drawing an edge across a face splits the face.
- Edges intersecting edges split each other at the crossing point.
- Erasing an edge between two coplanar faces merges them; erasing a face's
  bounding edge removes that face.
- Vertices within **tolerance (0.001 mm)** weld together.

### Units

- Internal unit: **millimetres**, always.
- Display units (per model): mm, cm, m, inches (decimal/fractional), feet+inches.
- The Measurements box accepts any unit regardless of setting: `25`, `25mm`,
  `2.5cm`, `1.5m`, `1"`, `3'6"`, `3' 6 1/2"`. Bare numbers use the model unit.
- Also accepts multi-values (`30,20` for rectangles) and array syntax for
  Move/Copy (`x5`, `*5`, `/5`).

### Undo / redo

Every op is a command applied to the model inside a transaction. The first
version can snapshot-diff the affected entities; it's optimized later if needed.

### Files & storage (browser-only)

- **Native format:** `.osk` — JSON (zipped later if size matters), versioned schema.
- **Open/Save:** File System Access API where available (Chrome/Edge, requires
  HTTPS or localhost); otherwise upload/download fallback.
  On the bare IP over plain HTTP, the fallback is used — that's fine.
- **Autosave:** IndexedDB, for crash recovery only.

### STL

- **Export:** binary STL (ASCII option), whole model or selection, unit scale
  chosen on export. Runs a watertight/manifold check first and warns with
  highlighted problem edges.
- **Import:** binary + ASCII. Ask source unit (default mm). Weld vertices, then
  merge coplanar adjacent triangles into real faces so imported parts are
  editable (push/pull a face of an imported cube). Curved regions stay faceted
  with soft/smooth edges. Imported into a group.

---

## Keyboard shortcuts (SketchUp defaults)

| Key | Tool | Key | Tool |
|---|---|---|---|
| Space | Select | P | Push/Pull |
| L | Line | M | Move |
| R | Rectangle | Q | Rotate |
| C | Circle | S | Scale |
| A | Arc | F | Offset |
| E | Eraser | T | Tape Measure |
| O | Orbit | H | Pan |
| Z | Zoom | Shift+Z | Zoom extents |
| G | Make group/component | Ctrl+Z / Ctrl+Y | Undo / Redo |

Mouse: middle-drag orbit, Shift+middle-drag pan, wheel zooms toward cursor.
Arrow keys lock inference axes (→ red, ← green, ↑ blue, ↓ parallel/perpendicular);
Shift holds the current inference lock.

---

## Milestones

Each milestone ends with something usable in the browser.

### M0 — Scaffold ✅
Repo, MIT license, Vite + TS + Three.js, Vitest, viewport with Z-up infinite
axes, ground grid, temporary camera controls, units module + parser (tested),
Measurements box wired to the parser. Deploy instructions.

### M1 — Viewport & tool framework ✅
- SketchUp-style camera (`viewport/CameraController.ts`, unit-tested): orbit around
  the point under the cursor with a level horizon, pan that keeps the grabbed point
  under the cursor, zoom toward the cursor, double-click wheel to center, Zoom
  Extents, standard views (animated), perspective ⇄ parallel, dynamic near/far.
- Tool framework (`tools/`): Tool interface, ToolManager, input routing (middle
  mouse + wheel always navigate; left/right go to the tool), shortcuts,
  status-bar hints, Measurements box.
- Tools: Select (placeholder), Orbit (O), Pan (H), Zoom (Z; Shift+drag or typed
  value sets field of view, e.g. `35` or `50mm`).
- Camera menu: standard views, projection, Zoom Extents.

### M2 — Geometry core ✅
- `core/Mesh.ts`: vertices/edges/faces with welding (0.001 mm), invariants and a
  `validate()` checker; `core/Model.ts`: transactions + snapshot undo/redo.
- `core/ops.ts`: segment insertion (welding, splitting at crossings, collinear
  overlap merging), automatic faces per plane via `core/planar.ts` (region finding
  with holes), face splitting, coplanar merge on erase, vertex healing, consistent
  face orientation (ground faces face down; closed shells face outward).
- Rendering (`viewport/ModelRenderer.ts`): front/back face colours, edges.
- Tested incl. a randomized 150-line stress test that checks every invariant.
- Perf note: ~13 ms/op average on a 2,500-face single plane; add a spatial index
  if real models get slow.

### M3 — Inference + first drawing tools ✅
- `inference/InferenceEngine.ts` (tested): endpoint, midpoint, origin, on-edge,
  red/green/blue axis from the start point, on-face, on world axis, free point;
  hides geometry behind faces; line and plane locks.
- Arrow-key axis locks, Shift locks the current inference.
- 2D overlay for rubber bands, markers and tooltips.
- **Line** (chains, ends on closing a face, typed lengths, click-drag-release) and
  **Rectangle** (on faces or axis planes, typed "w, h").
- Edit menu + Ctrl+Z / Ctrl+Y.
- Intersection inference: edge × edge and edge through face (black ✕).
- Locked lines (arrows / Shift) stop exactly where they meet a hovered edge or face.
- Still to add later: parallel/perpendicular (magenta) inference, "from point"
  dotted-line tracking.

### M4 — Core editing ✅
- **Select**: click / double-click (neighbours) / triple-click (connected),
  window (left→right) and crossing (right→left) boxes, Ctrl add, Shift toggle,
  Ctrl+Shift remove, Esc clears, Ctrl+A / Ctrl+T, Delete erases.
- **Eraser**: click or drag over edges; Shift hides, Ctrl softens, Ctrl+Shift unsoftens.
- **Push/Pull** (`core/pushpull.ts`, tested with signed-volume checks): extrude free
  faces, stretch boxes, pockets, bosses, notches, faces with holes; Ctrl keeps the
  original face; typed distance; re-type right after to change it; double-click repeats.
- **Move/Copy** (Ctrl tap toggles copy), arrays `x5` / `/5`; **Rotate** with
  protractor on face/axis plane, 15° snapping, typed angle, radial arrays.
- Live previews while dragging (`Model.beginPreview/showPreview/endPreview`).
- Moved geometry stretches neighbours, welds onto vertices it lands on, and
  non-planar faces fold into soft-edged triangles.
- Pushing a face down onto the far side of a solid punches a hole through (both
  for a fresh pocket and for deepening an existing one). While dragging, the face
  snaps into the plane of any parallel face in line with it ("On Face").
- After every push/pull a tidy pass joins vertices that landed on edges (no
  T-junctions), re-derives the faces of the planes involved (a face split by a slot
  becomes two faces) and removes edges left bounding nothing. Side faces only partly
  overlapping a neighbour cut just the overlap. Checked by a randomized test of
  hundreds of push/pull sequences (valid, watertight, no T-junctions).
- Drawing never auto-fills a region whose edges all already border two faces
  (e.g. the mouth of a through-hole), which would make non-manifold geometry.
- Known limits: moved/copied geometry doesn't split edges it crosses; pushing a face
  *past* the far side doesn't intersect it; drawing a shape across the mouth of a
  hole fills the part inside the shape (as SketchUp does).

### M5 — Curves & offset ✅
- Curves: edges of a circle/arc/polygon share a curve id (`core/Mesh.ts`), so they
  select and erase as one; circles/arcs remember their center for "Center" inference.
  Curves follow moves/rotations/copies and are dropped to plain edges when distorted.
- **Circle** (C, 24 sides) and **Polygon** (6 sides): on the face under the center or
  the ground; arrows stand it on an axis; type sides before clicking (or "Ns").
- **Arc** (A, 2-point with bulge): typed bulge or radius ("25r"), half-circle snap,
  "Ns" segments.
- **Offset** (F): offsets a face's loops in or out (mitred corners), circles stay
  circles; double-click repeats.
- Push/Pull of circles/arcs makes soft, smooth side edges; the renderer shades across
  smooth edges so cylinders and round holes look round.
- Not yet: 3-point arc, pie, tangent-arc inference, offset of selected edges (only faces).

### M6a — Files, measuring, scale ✅
- **Files**: native `.su3d` (versioned JSON: geometry, guides, units, camera),
  validated on open. File menu: New, Open (Ctrl+O), Save (Ctrl+S, writes back to the
  same file where the browser allows), Save As (Ctrl+Shift+S). Title shows the file
  name and • for unsaved changes.
- **Autosave**: every change is kept in the browser (IndexedDB) and restored on
  reload; nothing leaves the browser.
- **Guides** (part of the model, undoable, saved): dashed infinite lines and points,
  snappable ("On Guide", "Guide Point", intersections with edges/guides). Eraser
  erases them; Edit → Delete Guides.
- **Tape Measure** (T): measure; from an edge makes a parallel guide line, from a
  point a guide point; typed distances; Ctrl = measure only.
- **Protractor**: guide line at an angle (15° snapping, typed angle).
- **Scale** (S): bounding-box grips (corner uniform, edge 2-axis, face 1-axis),
  typed factor / per-axis factors / size ("50mm"), Ctrl = about center. Circles stay
  circles under uniform scale.
- Shortcut change: Select None is Ctrl+Shift+A (browsers reserve Ctrl+T / Ctrl+N).

### M6b — Groups & components ✅
- Model = root mesh + definitions; groups/components are instances (affine
  transform + definition). Groups are unique; component copies share their
  definition (editing one updates all, live).
- Make Group (Ctrl+G), Make Component (G), Explode, Close Group (Esc). Double-click
  a group to edit it: its geometry moves into world coordinates while open, so all
  tools work unchanged; everything outside is drawn faded. Clicking outside closes it.
- Move/Rotate/Scale/Copy/arrays and Eraser/Delete work on groups as wholes; the
  Select tool picks groups (blue bounding box), including in window/crossing boxes.
- Snapping sees all geometry (everything outside the open group is copied into a
  world-space snap mesh), so you can align to other groups.
- File format v2 (definitions + instances); v1 files still open. Undo works across
  entering/leaving groups. Saved files always have groups closed; unused
  definitions are dropped.
- Fix: axes pointing at the viewer (blue in Top view) no longer capture the cursor.
- Not yet: outliner panel, component naming/browser, Make Unique, mirrored scales.

### M7 — STL import/export
- As described above, including the watertight check.
- *This is the milestone where it becomes usable for real print work.*

### M8 — Follow Me
- Extrude a face along a path (edges or a face's perimeter), incl. lathe-style
  revolve around a circle path.

### M9 — Solid tools
- Manifold integration: **Union, Subtract, Intersect, Trim, Split, Outer Shell**.
- **Solid inspector:** identify why a group isn't solid (holes, stray faces,
  reversed faces) and offer fixes.
- **Intersect Faces** (with model / with selection).

### M10 — Polish
- Dimensions and text labels, tags (layers), outliner.
- Face styles: shaded, X-ray, hidden line, back-edges.
- 3MF and OBJ export.
- Fillet/chamfer helpers (nice-to-have for print parts).

### Release
- Name: ShapeUp3d ✅. README with screenshots, contribution guide, GitHub repo,
  CI (tests + build), deploy.

---

## Deployment (VPS)

The app is static. Build locally, copy `dist/` to the server, serve with Caddy.

```bash
npm run build
scp -r dist/* user@YOUR_SERVER_IP:/var/www/shapeup3d/
```

Caddy (`/etc/caddy/Caddyfile`), IP-only over HTTP for now:

```
:80 {
    root * /var/www/shapeup3d
    file_server
    encode gzip zstd
    header /assets/* Cache-Control "public, max-age=31536000, immutable"
}
```

When a domain is added, replace `:80` with the domain name and Caddy will
obtain HTTPS certificates automatically (which also enables in-place file saving).

## Testing strategy

- **Unit tests** (Vitest) for `core/`, `ops/`, `units/`, `io/` — geometry
  correctness is the foundation; every op gets tests for normal and edge cases
  (coincident points, collinear edges, faces with holes, tolerance boundaries).
- **Round-trip tests** for file formats (save → load → equal; STL export → import → same volume).
- Manual checklists per milestone for tool feel in the browser.
