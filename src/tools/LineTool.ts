import { type Plane, TOL, type Vec3 } from '../core/math';
import { drawSegments } from '../core/ops';
import { AXIS_COLORS, type Inference } from '../inference/InferenceEngine';
import { formatLength, parseLength } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import { InferenceLocks } from './locks';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

/** Mouse travel that turns a press into click-drag-release drawing. */
const DRAG_PX = 6;

/**
 * Line tool. Click to start, click to place each next point; the chain continues
 * until Esc or until a line closes a face. Type a length to place the next point
 * along the current direction. Arrow keys lock an axis (→ red, ← green, ↑ blue,
 * ↓ unlock); hold Shift to lock the current inference.
 */
export class LineTool implements Tool {
  readonly id = 'line';
  readonly name = 'Line';
  readonly shortcut = 'L';

  private ctx!: ToolContext;
  private start: Vec3 | null = null;
  /** Plane of the face the chain started on; free points stay on it. */
  private startPlane: Plane | undefined;
  private current: Inference | null = null;
  private readonly locks = new InferenceLocks();
  private last: ToolPointerEvent | null = null;
  private press: { x: number; y: number; placedStart: boolean } | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    ctx.setCursor('crosshair');
    this.reset();
  }

  cancel(): void {
    this.reset();
  }

  pointerMove(e: ToolPointerEvent): void {
    this.last = e;
    this.update();
  }

  pointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.last = e;
    this.update();
    if (!this.current) return;
    if (!this.start) {
      this.start = this.current.point;
      this.startPlane = this.current.face?.plane;
      this.press = { x: e.x, y: e.y, placedStart: true };
      this.prompt();
      this.update();
      return;
    }
    this.press = { x: e.x, y: e.y, placedStart: false };
    this.commit(this.current.point);
  }

  pointerUp(e: ToolPointerEvent): void {
    const press = this.press;
    this.press = null;
    if (e.button !== 0 || !press?.placedStart || !this.start) return;
    if (Math.hypot(e.x - press.x, e.y - press.y) > DRAG_PX) {
      this.last = e;
      this.update();
      if (this.current) this.commit(this.current.point);
    }
  }

  keyDown(e: KeyboardEvent): boolean {
    if (!this.locks.keyDown(e, this.current, this.start)) return false;
    this.update();
    return true;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (!this.locks.keyUp(e)) return false;
    this.update();
    return true;
  }

  enterMeasurement(text: string): void {
    const start = this.start;
    const current = this.current;
    if (!start || !current) {
      this.ctx.setStatus('Click to place the start point, then type a length.');
      return;
    }
    const length = parseLength(text, this.ctx.format.unit);
    if (length === null) {
      this.ctx.setStatus(`Invalid length: "${text}"`);
      return;
    }
    const dir = current.point.sub(start);
    if (dir.length() <= TOL) {
      this.ctx.setStatus('Move the cursor to choose a direction, then type the length.');
      return;
    }
    this.commit(start.addScaled(dir.normalize(), length));
  }

  draw(o: Overlay): void {
    const cur = this.current;
    if (!cur) return;
    if (this.start) {
      const color = cur.axis ? AXIS_COLORS[cur.axis] : '#111';
      o.line(this.start, cur.point, { color, width: cur.axis ? 2 : 1.5 });
    }
    drawInference(o, cur, this.last);
  }

  private commit(end: Vec3): void {
    const start = this.start;
    if (!start || end.distanceTo(start) <= TOL) return;
    const facing = this.ctx.facing();
    const result = this.ctx.model.transact('Line', (mesh) => drawSegments(mesh, [[start, end]], { facing }));
    this.locks.reset();
    if (result.facesChanged) {
      // Like SketchUp, completing a face ends the chain.
      this.reset();
      return;
    }
    this.start = end;
    this.prompt();
    this.update();
  }

  private reset(): void {
    this.start = null;
    this.startPlane = undefined;
    this.locks.reset();
    this.press = null;
    this.prompt();
    this.ctx.setMeasurement('Length', '');
    this.update();
  }

  private prompt(): void {
    this.ctx.setStatus(
      this.start
        ? 'Select end point or type a length. Arrows lock an axis (→ red, ← green, ↑ blue); hold Shift to lock the inference.'
        : 'Select start point.',
    );
  }

  private update(): void {
    const e = this.last;
    if (!e) return;
    this.current = this.ctx.inference.infer({
      x: e.x,
      y: e.y,
      ray: this.ctx.viewport.ray(e.ndc), // recomputed in case the camera moved
      from: this.start ?? undefined,
      lock: this.locks.lock(this.start),
      plane: this.startPlane,
    });
    if (this.start) {
      this.ctx.setMeasurement('Length', formatLength(this.start.distanceTo(this.current.point), this.ctx.format));
    }
  }
}
