import { Plane, TOL, Vec3 } from '../core/math';
import { drawPolyline } from '../core/ops';
import type { Inference } from '../inference/InferenceEngine';
import { formatLength, parseLengthList } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const DRAG_PX = 6;

/** In-plane axes of a rectangle: corners are start + u·w + v·h. */
interface Basis {
  u: Vec3;
  v: Vec3;
  normal: Vec3;
}

const XY: Basis = { u: Vec3.X, v: Vec3.Y, normal: Vec3.Z };
const XZ: Basis = { u: Vec3.X, v: Vec3.Z, normal: Vec3.Y };
const YZ: Basis = { u: Vec3.Y, v: Vec3.Z, normal: Vec3.X };

/** Point kinds that should pull the corner to a specific spot (projected onto the rectangle's plane). */
const SNAPS = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'origin', 'on-edge', 'on-axis']);

/**
 * Rectangle tool. Click one corner, then the opposite corner, or type "width, height".
 * Drawn on the face under the first click, or on the ground / an axis plane.
 */
export class RectangleTool implements Tool {
  readonly id = 'rectangle';
  readonly name = 'Rectangle';
  readonly shortcut = 'R';

  private ctx!: ToolContext;
  private start: Inference | null = null;
  private current: Inference | null = null;
  private rect: { corners: Vec3[]; w: number; h: number; basis: Basis } | null = null;
  private last: ToolPointerEvent | null = null;
  private press: { x: number; y: number } | null = null;

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
    if (!this.start) {
      if (!this.current) return;
      this.start = this.current;
      this.press = { x: e.x, y: e.y };
      this.ctx.setStatus('Select opposite corner or type dimensions (width, height).');
      this.update();
      return;
    }
    this.commitCurrent();
  }

  pointerUp(e: ToolPointerEvent): void {
    const press = this.press;
    this.press = null;
    if (e.button !== 0 || !press || !this.start) return;
    if (Math.hypot(e.x - press.x, e.y - press.y) > DRAG_PX) {
      this.last = e;
      this.update();
      this.commitCurrent();
    }
  }

  enterMeasurement(text: string): void {
    const start = this.start;
    if (!start) {
      this.ctx.setStatus('Click to place the first corner, then type dimensions.');
      return;
    }
    const values = parseLengthList(text, this.ctx.format.unit);
    if (!values || values.length !== 2 || values[0] == null || values[1] == null) {
      this.ctx.setStatus(`Enter two dimensions separated by a comma, e.g. "40, 25". Got "${text}".`);
      return;
    }
    // Keep the direction the cursor is pulling in.
    const basis = this.rect?.basis ?? this.faceBasis() ?? XY;
    const w = values[0] * (this.rect && this.rect.w < 0 ? -1 : 1);
    const h = values[1] * (this.rect && this.rect.h < 0 ? -1 : 1);
    this.commit(corners(start.point, basis, w, h));
  }

  draw(o: Overlay): void {
    if (this.rect) {
      const c = this.rect.corners;
      for (let i = 0; i < 4; i++) o.line(c[i]!, c[(i + 1) % 4]!, { color: '#111', width: 1.5 });
    }
    if (this.current) drawInference(o, this.current, this.last);
  }

  private commitCurrent(): void {
    const r = this.rect;
    if (!r || Math.abs(r.w) <= TOL || Math.abs(r.h) <= TOL) return;
    this.commit(r.corners);
  }

  private commit(pts: Vec3[]): void {
    const facing = this.ctx.facing();
    this.ctx.model.transact('Rectangle', (mesh) => drawPolyline(mesh, pts, true, { facing }));
    this.reset();
  }

  private reset(): void {
    this.start = null;
    this.rect = null;
    this.press = null;
    this.ctx.setStatus('Select first corner.');
    this.ctx.setMeasurement('Dimensions', '');
    this.update();
  }

  private faceBasis(): Basis | null {
    const face = this.start?.face;
    if (!face) return null;
    const n = face.normal;
    // Align with the red axis where possible (green if the face is perpendicular to red).
    let u = Vec3.X.sub(n.scale(n.dot(Vec3.X)));
    if (u.length() < 1e-6) u = Vec3.Y.sub(n.scale(n.dot(Vec3.Y)));
    u = u.normalize();
    return { u, v: n.cross(u), normal: n };
  }

  /** Plane of the rectangle: the start face, else the axis plane containing both corners. */
  private basisFor(p: Vec3): Basis {
    const fb = this.faceBasis();
    if (fb) return fb;
    const d = p.sub(this.start!.point);
    if (Math.abs(d.z) <= TOL) return XY;
    if (Math.abs(d.y) <= TOL) return XZ;
    if (Math.abs(d.x) <= TOL) return YZ;
    return XY;
  }

  private update(): void {
    const e = this.last;
    if (!e) return;
    const ray = this.ctx.viewport.ray(e.ndc);
    const start = this.start;
    if (!start) {
      this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray });
      return;
    }
    const A = start.point;
    const inf = this.ctx.inference.infer({
      x: e.x,
      y: e.y,
      ray,
      plane: start.face?.plane ?? this.ctx.inference.defaultPlane(A),
    });
    this.current = inf;

    const basis = this.basisFor(inf.point);
    const plane = Plane.fromPointNormal(A, basis.normal);
    let p: Vec3;
    if (SNAPS.has(inf.kind)) {
      p = plane.projectPoint(inf.point);
    } else {
      const t = plane.intersectRay(ray.origin, ray.direction);
      p = t !== null && t > 0 ? Vec3.from(ray.origin).addScaled(ray.direction, t) : plane.projectPoint(inf.point);
    }
    const d = p.sub(A);
    const w = d.dot(basis.u);
    const h = d.dot(basis.v);
    this.rect = { corners: corners(A, basis, w, h), w, h, basis };
    const fmt = (x: number) => formatLength(Math.abs(x), this.ctx.format);
    this.ctx.setMeasurement('Dimensions', `${fmt(w)}, ${fmt(h)}`);
  }
}

function corners(a: Vec3, b: Basis, w: number, h: number): Vec3[] {
  return [a, a.addScaled(b.u, w), a.addScaled(b.u, w).addScaled(b.v, h), a.addScaled(b.v, h)];
}
