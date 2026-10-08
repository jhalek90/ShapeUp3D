import { offsetFace, offsetFaceLoops } from '../core/curves';
import { PlaneProjector, pointInPolygon2D, TOL, type Vec2, Vec3 } from '../core/math';
import type { Face } from '../core/Mesh';
import type { Inference } from '../inference/InferenceEngine';
import { formatLength, parseLength } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const SNAPS = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'guide-point', 'on-guide', 'origin', 'on-edge']);

/**
 * Offset: click a face, move the cursor in or out, click (or type a distance).
 * Draws a copy of the face's outline that far inside it (or outside), splitting
 * it. Double-click a face to repeat the last distance.
 */
export class OffsetTool implements Tool {
  readonly id = 'offset';
  readonly name = 'Offset';
  readonly shortcut = 'F';

  private ctx!: ToolContext;
  private faceId: number | null = null;
  private distance = 0;
  private preview: Vec3[][] | null = null;
  private current: Inference | null = null;
  private last: ToolPointerEvent | null = null;
  private previous: number | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    ctx.setCursor('crosshair');
    this.reset();
  }

  deactivate(): void {
    this.ctx.highlight();
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
    if (this.faceId !== null) {
      this.commit(this.distance);
      return;
    }
    const face = this.faceAt(e);
    if (!face) return;
    this.faceId = face.id;
    this.ctx.highlight([face]);
    this.ctx.setStatus('Move in or out and click, or type the distance.');
    this.update();
  }

  doubleClick(e: ToolPointerEvent): void {
    if (this.previous === null || this.faceId !== null) return;
    const face = this.faceAt(e);
    if (face) this.run(face.id, this.previous);
  }

  enterMeasurement(text: string): void {
    const d = parseLength(text, this.ctx.format.unit);
    if (d === null) {
      this.ctx.setStatus(`Invalid distance: "${text}"`);
      return;
    }
    if (this.faceId === null) {
      this.ctx.setStatus('Click a face first, then type the distance.');
      return;
    }
    // Follow the direction the cursor is offsetting in (inward by default).
    this.commit(this.distance < 0 ? -d : d);
  }

  draw(o: Overlay): void {
    if (this.preview) for (const loop of this.preview) o.polyline(loop, { color: '#111', width: 1.5 }, true);
    if (this.current && this.faceId !== null) drawInference(o, this.current, this.last);
  }

  /** The selected face if exactly one is selected, else the face under the cursor. */
  private faceAt(e: ToolPointerEvent): Face | undefined {
    const selected = this.ctx.selection.faces;
    if (selected.length === 1) return selected[0];
    return this.ctx.inference.pick({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) }, 'face')?.face;
  }

  private update(): void {
    const e = this.last;
    if (!e) return;
    const ray = this.ctx.viewport.ray(e.ndc);
    if (this.faceId === null) {
      const face = this.faceAt(e);
      this.ctx.highlight(face ? [face] : []);
      return;
    }
    const face = this.ctx.model.mesh.faces.get(this.faceId);
    if (!face) {
      this.reset();
      return;
    }
    const plane = face.plane;
    const inf = this.ctx.inference.infer({ x: e.x, y: e.y, ray, plane });
    this.current = inf;
    let p = plane.projectPoint(inf.point);
    if (!SNAPS.has(inf.kind)) {
      const t = plane.intersectRay(ray.origin, ray.direction);
      if (t !== null) p = Vec3.from(ray.origin).addScaled(ray.direction, t);
    }
    this.distance = signedDistanceInto(face, p);
    this.preview = offsetFaceLoops(face, this.distance);
    this.ctx.setMeasurement('Distance', formatLength(Math.abs(this.distance), this.ctx.format));
  }

  private commit(d: number): void {
    const id = this.faceId;
    this.reset();
    if (id !== null && Math.abs(d) > TOL) this.run(id, d);
  }

  private run(faceId: number, d: number): void {
    const facing = this.ctx.facing();
    const ok = this.ctx.model.transact('Offset', (m) => {
      const f = m.faces.get(faceId);
      return f ? offsetFace(m, f, d, { facing }) : false;
    });
    if (ok) this.previous = d;
    else this.ctx.setStatus("Can't offset that far: the outline would turn inside out.");
  }

  private reset(): void {
    this.faceId = null;
    this.distance = 0;
    this.preview = null;
    this.current = null;
    this.ctx.highlight();
    this.ctx.setStatus('Click a face to offset its outline. Double-click repeats the last distance.');
    this.ctx.setMeasurement('Distance', '');
  }
}

/** Distance from p to the face's boundary: positive inside the face, negative outside. */
function signedDistanceInto(face: Face, p: Vec3): number {
  const proj = new PlaneProjector(face.plane);
  const q = proj.to2D(p);
  const loops = face.loops.map((l) => l.map((v) => proj.to2D(v.pos)));
  let best = Infinity;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) best = Math.min(best, distToSegment(q, loop[i]!, loop[(i + 1) % loop.length]!));
  }
  const inside = pointInPolygon2D(q, loops[0]!) && !loops.slice(1).some((h) => pointInPolygon2D(q, h));
  return inside ? best : -best;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
