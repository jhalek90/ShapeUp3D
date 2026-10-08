# ShapeUp3d

A free, open-source, browser-based 3D modeler in the spirit of SketchUp Make 2017,
built for designing parts for 3D printing. Runs entirely in your browser — no
accounts, nothing stored on a server.

> Early development. See [PLAN.md](PLAN.md) for the roadmap.

## Development

Requires Node.js 20+.

```bash
npm install
npm run dev        # start dev server at http://localhost:5173
npm test           # run unit tests
npm run build      # typecheck + production build into dist/
```

## Controls (so far)

- Middle-drag: orbit around the point under the cursor
- Shift + middle-drag: pan
- Scroll: zoom toward the cursor
- Double-click the wheel: center the view on that point
- `O` Orbit, `H` Pan, `Z` Zoom, `Shift+Z` Zoom Extents, `Space` Select
- Camera menu: standard views, perspective / parallel projection
- `L` Line: click points; type a length (e.g. `25`, `3'6"`, `1.5m`) + Enter for exact lines.
  Arrow keys lock an axis (→ red, ← green, ↑ blue); hold Shift to lock the current inference.
- `R` Rectangle: click two corners, or click one and type `width, height`
- `C` Circle / Polygon: click center, click or type radius. Type a number first to set sides.
- `A` Arc: click start, click end, pull out the bulge (or type it, or a radius like `25r`).
- `F` Offset: click a face, move in/out, click or type a distance.
- `P` Push/Pull: click a face, move, click (or type a distance). Ctrl keeps the original face.
  Type a new value right after to change it; double-click a face to repeat.
- `M` Move: moves the selection (or what's under the cursor). Tap Ctrl to copy;
  after a copy type `x5` for an array or `/5` to divide.
- `Q` Rotate: click center, click reference, click/type angle (snaps to 15°). Arrow keys pick the axis.
- `Space` Select: click, double/triple-click, drag boxes; Ctrl add, Shift toggle. `Delete` erases.
- `E` Eraser: click/drag over edges. Shift hides, Ctrl softens.
- `Ctrl+Z` / `Ctrl+Y` undo / redo

## License

[MIT](LICENSE)

ShapeUp3d is an independent project, not affiliated with or endorsed by Trimble or SketchUp.
SketchUp is a trademark of Trimble Inc.
