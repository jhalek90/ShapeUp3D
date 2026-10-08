import { TOL, type Vec3 } from '../core/math';
import type { Face, Mesh } from '../core/Mesh';
import { alignedFaceDistances, pushPull } from '../core/pushpull';
import type { Inference } from '../inference/InferenceEngine';
import { formatLength, parseLength } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import { CtrlTap } from './locks';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const DRAG_PX = 6;
/** Pixels within which the moving face snaps into the plane of a face in line with it. */
const FACE_SNAP_PX = 10;

interface Drag {
  faceId: number;
  /** Point clicked on the face; the distance is measured along the normal from here. */
  origin: Vec3;
  normal: Vec3;
  distance: number;
  press: { x: number; y: number };
  /** Distances that put the face exactly on another face in line with it. */
  snaps: number[];
}

/**
 * Push/Pull: click a face, move, click again (or drag and release, or type a
 * distance). The model updates live while dragging. Ctrl toggles keeping the
 * original face. Double-click a face to repeat the last distance; typing a value
 * right after a push/pull redoes it with that distance.
 */
export class PushPullTool implements Tool {
  readonly id = 'pushpull';
  readonly name = 'Push/Pull';
  readonly shortcut = 'P';

  private ctx!: ToolContext;
  private drag: Drag | null = null;
  private current: Inference | null = null;
  private keepBase = false;
  private readonly ctrl = new CtrlTap();
  private last: ToolPointerEvent | null = null;
  /** The last completed push/pull, for repeating or re-entering its distance. */
  private previous: { faceId: number; distance: number; keepBase: boolean } | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    ctx.setCursor('crosshair');
    this.reset();
  }

  deactivate(): void {
    this.ctx.highlight();
  }

  cancel(): void {
    this.ctx.model.endPreview();
    this.reset();
  }

  pointerMove(e: ToolPointerEvent): void {
    this.last = e;
    if (this.drag) this.updateDrag();
    else this.hover(e);
  }

  pointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.last = e;
    if (this.drag) {
      this.commit(this.drag.distance);
      return;
    }
    const hit = this.ctx.inference.pick({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) }, 'face');
    if (!hit?.face) return;
    this.drag = {
      faceId: hit.face.id,
      origin: hit.point,
      normal: hit.face.normal,
      distance: 0,
      press: { x: e.x, y: e.y },
      snaps: alignedFaceDistances(this.ctx.model.mesh, hit.face, hit.point),
    };
    this.ctx.highlight();
    this.ctx.model.beginPreview();
    this.ctx.setStatus('Move to push or pull, then click — or type a distance. Ctrl = keep the original face.');
  }

  pointerUp(e: ToolPointerEvent): void {
    const d = this.drag;
    if (e.button !== 0 || !d) return;
    // Click-drag-release.
    if (Math.hypot(e.x - d.press.x, e.y - d.press.y) > DRAG_PX) this.commit(d.distance);
  }

  doubleClick(e: ToolPointerEvent): void {
    // Repeat the last distance on the face under the cursor.
    const prev = this.previous;
    if (!prev || this.drag) return;
    const hit = this.ctx.inference.pick({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) }, 'face');
    if (!hit?.face) return;
    const id = hit.face.id;
    this.run(id, prev.distance, prev.keepBase);
  }

  keyDown(e: KeyboardEvent): boolean {
    this.ctrl.keyDown(e);
    return false;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (!this.ctrl.keyUp(e)) return false;
    this.keepBase = !this.keepBase;
    if (this.drag) this.updateDrag();
    this.ctx.setStatus(this.keepBase ? 'Push/Pull will keep the original face.' : 'Push/Pull will move the face.');
    return true;
  }

  enterMeasurement(text: string): void {
    const length = parseLength(text, this.ctx.format.unit);
    if (length === null) {
      this.ctx.setStatus(`Invalid distance: "${text}"`);
      return;
    }
    const d = this.drag;
    if (d) {
      // Follow the direction the mouse is pulling in; before any movement, pull toward the viewer.
      const sign = Math.abs(d.distance) > TOL ? Math.sign(d.distance) : d.normal.dot(this.ctx.facing()) >= 0 ? 1 : -1;
      this.commit(sign * length);
      return;
    }
    // Right after a push/pull: redo it with the typed distance.
    const prev = this.previous;
    if (prev && this.ctx.model.undoName === 'Push/Pull') {
      this.ctx.model.undo();
      this.run(prev.faceId, Math.sign(prev.distance) * length, prev.keepBase);
      return;
    }
    this.ctx.setStatus('Click a face first, then type the distance.');
  }

  draw(o: Overlay): void {
    if (this.drag && this.current) {
      const end = this.drag.origin.addScaled(this.drag.normal, this.drag.distance);
      o.line(this.drag.origin, end, { color: '#555', width: 1, dash: [4, 3] });
      drawInference(o, this.current, this.last);
    }
  }

  private hover(e: ToolPointerEvent): void {
    const hit = this.ctx.inference.pick({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) }, 'face');
    this.ctx.highlight(hit?.face ? [hit.face] : []);
  }

  private updateDrag(): void {
    const d = this.drag;
    const e = this.last;
    if (!d || !e) return;
    // Infer against the model as it was, not the live preview.
    this.ctx.model.showPreview();
    const inf = this.ctx.inference.infer({
      x: e.x,
      y: e.y,
      ray: this.ctx.viewport.ray(e.ndc),
      lock: { kind: 'line', origin: d.origin, dir: d.normal, tooltip: '' },
    });
    // Show what was snapped to (e.g. "Endpoint"), not the line lock.
    this.current = { ...inf, tooltip: inf.refTooltip ?? '', refTooltip: undefined };
    d.distance = inf.point.sub(d.origin).dot(d.normal);
    // Unless the cursor picked up a point, snap onto faces in line with this one
    // (so a pocket can be pushed exactly down to the far side and punch through).
    if (!inf.ref) {
      const snapped = this.faceSnap(d, d.distance);
      if (snapped !== null) {
        d.distance = snapped;
        this.current = { ...inf, point: d.origin.addScaled(d.normal, snapped), tooltip: 'On Face' };
      }
    }
    const keepBase = this.keepBase;
    this.ctx.model.showPreview((m) => {
      const face = m.faces.get(d.faceId);
      if (face) pushPull(m, face, d.distance, { keepBase });
    });
    this.ctx.setMeasurement('Distance', formatLength(Math.abs(d.distance), this.ctx.format));
  }

  /** The in-line face distance within a few pixels of `distance` on screen, if any. */
  private faceSnap(d: Drag, distance: number): number | null {
    const here = this.ctx.inference.screen(d.origin.addScaled(d.normal, distance));
    if (!here) return null;
    let best: number | null = null;
    let bestPx = FACE_SNAP_PX;
    for (const s of d.snaps) {
      const there = this.ctx.inference.screen(d.origin.addScaled(d.normal, s));
      if (!there) continue;
      const px = Math.hypot(there.x - here.x, there.y - here.y);
      if (px < bestPx) {
        bestPx = px;
        best = s;
      }
    }
    return best;
  }

  private commit(distance: number): void {
    const d = this.drag;
    if (!d) return;
    this.ctx.model.endPreview();
    if (Math.abs(distance) > TOL) this.run(d.faceId, distance, this.keepBase);
    this.reset();
  }

  private run(faceId: number, distance: number, keepBase: boolean): void {
    const face = (m: Mesh): Face | undefined => m.faces.get(faceId);
    const ok = this.ctx.model.transact('Push/Pull', (m) => {
      const f = face(m);
      return f ? pushPull(m, f, distance, { keepBase }) : false;
    });
    if (ok) {
      this.previous = { faceId, distance, keepBase };
      this.ctx.setMeasurement('Distance', formatLength(Math.abs(distance), this.ctx.format));
    } else {
      this.ctx.setStatus("Can't push/pull that far: it would collapse the geometry.");
    }
  }

  private reset(): void {
    this.drag = null;
    this.current = null;
    this.ctx.setStatus('Click a face to push or pull it. Double-click repeats the last distance.');
  }
}
