import * as THREE from 'three';
import { Plane, TOL, Vec3 } from '../core/math';
import { circlePoints, drawCurve } from '../core/curves';
import type { CurveKind } from '../core/Mesh';
import { AXIS_COLORS, AXIS_DIRS, type Axis, type Inference } from '../inference/InferenceEngine';
import { formatLength, parseLength } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const ARROW_AXES: Partial<Record<string, Axis>> = { ArrowRight: 'x', ArrowLeft: 'y', ArrowUp: 'z' };
const DRAG_PX = 6;
/** "24s" sets the number of sides. */
const SIDES = /^\s*(\d+)\s*s\s*$/i;

/** Snapped inference kinds whose position defines the radius (projected onto the circle's plane). */
const SNAPS = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'origin', 'on-edge', 'on-axis']);

/**
 * Circle and Polygon: click the center, then click or type the radius. The shape
 * lies on the face under the center, or flat on the ground; arrow keys stand it
 * on the red/green/blue axis instead. Type a number before clicking (or "Ns" any
 * time) to set the number of sides.
 */
export class CircleTool implements Tool {
  private ctx!: ToolContext;
  private sides: number;
  private center: Vec3 | null = null;
  private normal: Vec3 = Vec3.Z;
  private lockedAxis: Axis | null = null;
  /** Current radius point (on the shape's plane). */
  private edgePoint: Vec3 | null = null;
  private current: Inference | null = null;
  private last: ToolPointerEvent | null = null;
  private press: { x: number; y: number } | null = null;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly shortcut: string | undefined,
    private readonly kind: Extract<CurveKind, 'circle' | 'polygon'>,
    defaultSides: number,
  ) {
    this.sides = defaultSides;
  }

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
    if (!this.center) {
      if (!this.current) return;
      this.center = this.current.point;
      this.press = { x: e.x, y: e.y };
      this.ctx.setStatus('Select the radius or type it.');
      this.update();
      return;
    }
    this.commitCurrent();
  }

  pointerUp(e: ToolPointerEvent): void {
    const press = this.press;
    this.press = null;
    if (e.button !== 0 || !press || !this.center) return;
    if (Math.hypot(e.x - press.x, e.y - press.y) > DRAG_PX) this.commitCurrent();
  }

  keyDown(e: KeyboardEvent): boolean {
    const axis = ARROW_AXES[e.key];
    if (!axis || this.center) return false;
    this.lockedAxis = this.lockedAxis === axis ? null : axis;
    this.update();
    return true;
  }

  enterMeasurement(text: string): void {
    const sides = SIDES.exec(text) ?? (!this.center ? /^\s*(\d+)\s*$/.exec(text) : null);
    if (sides) {
      const n = Number(sides[1]);
      if (n < 3 || n > 999) {
        this.ctx.setStatus('Use between 3 and 999 sides.');
        return;
      }
      this.sides = n;
      this.showMeasurement();
      return;
    }
    if (!this.center) {
      this.ctx.setStatus('Type a number of sides, or click to place the center.');
      return;
    }
    const r = parseLength(text, this.ctx.format.unit);
    if (r === null || r <= TOL) {
      this.ctx.setStatus(`Invalid radius: "${text}"`);
      return;
    }
    const dir = this.edgePoint ? this.edgePoint.sub(this.center) : Vec3.ZERO;
    this.commit(r, dir.length() > TOL ? dir : undefined);
  }

  draw(o: Overlay): void {
    const cur = this.current;
    if (!cur) return;
    const center = this.center ?? cur.point;
    const color = this.axisColor();
    if (this.center && this.edgePoint) {
      const dir = this.edgePoint.sub(this.center);
      const r = dir.length();
      if (r > TOL) {
        o.polyline(circlePoints(this.center, this.normal, r, this.sides, this.startDir(dir)), { color: '#111', width: 1.5 }, true);
        o.line(this.center, this.edgePoint, { color: '#555', width: 1, dash: [4, 3] });
      }
    } else {
      // Before the first click: a small marker showing the orientation.
      const r = this.ctx.camera.worldPerPixel(this.ctx.camera.depthOf(new THREE.Vector3(center.x, center.y, center.z))) * 18;
      o.polyline(circlePoints(center, this.normal, r, 24), { color, width: 1.5 }, true);
    }
    drawInference(o, cur, this.last);
  }

  private commitCurrent(): void {
    if (!this.center || !this.edgePoint) return;
    const dir = this.edgePoint.sub(this.center);
    if (dir.length() > TOL) this.commit(dir.length(), dir);
  }

  private commit(radius: number, dir: Vec3 | undefined): void {
    const center = this.center!;
    const normal = this.normal;
    const pts = circlePoints(center, normal, radius, this.sides, this.startDir(dir));
    const facing = this.ctx.facing();
    const kind = this.kind;
    this.ctx.model.transact(this.name, (m) => drawCurve(m, pts, true, { kind, center, normal, radius }, { facing }));
    this.reset();
  }

  /** Polygons turn with the cursor; circles keep a vertex on the red axis (tidier for printing). */
  private startDir(dir: Vec3 | undefined): Vec3 | undefined {
    return this.kind === 'polygon' ? dir : undefined;
  }

  private update(): void {
    const e = this.last;
    if (!e) return;
    const ray = this.ctx.viewport.ray(e.ndc);
    if (!this.center) {
      this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray });
      this.normal = this.lockedAxis ? AXIS_DIRS[this.lockedAxis] : (this.current.face?.normal ?? Vec3.Z);
      return;
    }
    const plane = Plane.fromPointNormal(this.center, this.normal);
    const inf = this.ctx.inference.infer({ x: e.x, y: e.y, ray, from: this.center, plane });
    this.current = inf;
    let p: Vec3;
    if (SNAPS.has(inf.kind)) {
      p = plane.projectPoint(inf.point);
    } else {
      const t = plane.intersectRay(ray.origin, ray.direction);
      p = t !== null ? Vec3.from(ray.origin).addScaled(ray.direction, t) : plane.projectPoint(inf.point);
    }
    this.edgePoint = p;
    this.showMeasurement();
  }

  private showMeasurement(): void {
    if (this.center && this.edgePoint) {
      this.ctx.setMeasurement('Radius', formatLength(this.edgePoint.distanceTo(this.center), this.ctx.format));
    } else {
      this.ctx.setMeasurement('Sides', String(this.sides));
    }
  }

  private axisColor(): string {
    for (const a of ['x', 'y', 'z'] as const) if (Math.abs(this.normal.dot(AXIS_DIRS[a])) > 1 - 1e-9) return AXIS_COLORS[a];
    return '#2c5ce8'; // on a face
  }

  private reset(): void {
    this.center = null;
    this.edgePoint = null;
    this.press = null;
    this.ctx.setStatus(`Select the center. Arrows stand the ${this.kind} on an axis; type a number for sides (${this.sides}).`);
    this.showMeasurement();
    this.update();
  }
}
