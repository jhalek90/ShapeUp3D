import { TOL, type Vec3 } from '../core/math';
import type { Inference } from '../inference/InferenceEngine';
import { formatLength, parseLength } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import { CtrlTap, InferenceLocks } from './locks';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

/** Starting on one of these makes a guide point at the end; on an edge or guide line, a parallel guide line. */
const POINT_KINDS = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'guide-point', 'origin']);

/**
 * Tape Measure: click two points to measure between them. Starting on a point
 * leaves a guide point at the end; starting on an edge (or guide line) leaves a
 * guide line parallel to it, through the end. Type a length for an exact offset.
 * Ctrl toggles making guides (measure only).
 */
export class TapeMeasureTool implements Tool {
  readonly id = 'tape';
  readonly name = 'Tape Measure';
  readonly shortcut = 'T';

  private ctx!: ToolContext;
  private start: Inference | null = null;
  private current: Inference | null = null;
  private makeGuides = true;
  private readonly locks = new InferenceLocks();
  private readonly ctrl = new CtrlTap();
  private last: ToolPointerEvent | null = null;

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
    const cur = this.current;
    if (!cur) return;
    if (!this.start) {
      this.start = cur;
      this.prompt();
      this.update();
      return;
    }
    this.commit(cur.point);
  }

  keyDown(e: KeyboardEvent): boolean {
    this.ctrl.keyDown(e);
    if (!this.locks.keyDown(e, this.current, this.start?.point ?? null)) return false;
    this.update();
    return true;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (this.ctrl.keyUp(e)) {
      this.makeGuides = !this.makeGuides;
      this.prompt();
      return true;
    }
    if (!this.locks.keyUp(e)) return false;
    this.update();
    return true;
  }

  enterMeasurement(text: string): void {
    const start = this.start;
    const cur = this.current;
    if (!start || !cur) {
      this.ctx.setStatus('Click a start point first, then type the distance.');
      return;
    }
    const length = parseLength(text, this.ctx.format.unit);
    if (length === null) {
      this.ctx.setStatus(`Invalid length: "${text}"`);
      return;
    }
    const from = this.measureFrom(cur.point);
    const dir = cur.point.sub(from);
    if (dir.length() <= TOL) {
      this.ctx.setStatus('Move the cursor to choose a direction, then type the distance.');
      return;
    }
    this.commit(from.addScaled(dir.normalize(), length));
  }

  draw(o: Overlay): void {
    const cur = this.current;
    if (!cur) return;
    if (this.start) {
      const from = this.measureFrom(cur.point);
      o.line(from, cur.point, { color: '#111', width: 1.5, dash: [6, 3] });
      const line = this.startLine();
      if (line && this.makeGuides) {
        // Preview of the parallel guide.
        const reach = this.ctx.camera.distance * 4;
        o.line(cur.point.addScaled(line.dir, -reach), cur.point.addScaled(line.dir, reach), { color: '#5a5f66', width: 1, dash: [6, 4] });
      }
    }
    drawInference(o, cur, this.last);
  }

  /** The edge or guide line the tape started on, if any. */
  private startLine(): { a: Vec3; dir: Vec3 } | null {
    const s = this.start;
    if (s?.kind === 'on-edge' && s.edge) return { a: s.edge.v0.pos, dir: s.edge.direction };
    if (s?.kind === 'on-guide' && s.guide?.kind === 'line') return { a: s.guide.point, dir: s.guide.dir };
    return null;
  }

  /** Measured from the start point, or from the nearest point on the start edge (perpendicular distance). */
  private measureFrom(p: Vec3): Vec3 {
    const line = this.startLine();
    if (!line) return this.start!.point;
    // Foot of the perpendicular from p to the line (dir is a unit vector).
    return line.a.addScaled(line.dir, line.dir.dot(p.sub(line.a)));
  }

  private commit(end: Vec3): void {
    const start = this.start!;
    const from = this.measureFrom(end);
    const distance = from.distanceTo(end);
    const line = this.startLine();
    if (this.makeGuides && distance > TOL) {
      if (line) {
        const dir = line.dir;
        this.ctx.model.transact('Guide', (m) => m.addGuideLine(end, dir));
      } else if (POINT_KINDS.has(start.kind)) {
        this.ctx.model.transact('Guide', (m) => m.addGuidePoint(end));
      }
    }
    this.reset();
    this.ctx.setMeasurement('Length', formatLength(distance, this.ctx.format));
    this.ctx.setStatus(`Measured ${formatLength(distance, this.ctx.format)}. Click to measure again.`);
  }

  private update(): void {
    const e = this.last;
    if (!e) return;
    const start = this.start?.point;
    this.current = this.ctx.inference.infer({
      x: e.x,
      y: e.y,
      ray: this.ctx.viewport.ray(e.ndc),
      from: start,
      lock: this.locks.lock(start ?? null),
    });
    if (this.start) this.ctx.setMeasurement('Length', formatLength(this.measureFrom(this.current.point).distanceTo(this.current.point), this.ctx.format));
  }

  private prompt(): void {
    const guides = this.makeGuides ? '' : ' (measuring only — Ctrl to make guides)';
    this.ctx.setStatus(
      this.start
        ? `Select the end point or type a distance${guides}.`
        : `Click a point to measure from, or an edge to make a parallel guide${guides}. Ctrl toggles guides.`,
    );
  }

  private reset(): void {
    this.start = null;
    this.locks.reset();
    this.prompt();
    this.ctx.setMeasurement('Length', '');
    this.update();
  }
}
