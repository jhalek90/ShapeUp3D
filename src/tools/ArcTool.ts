import * as THREE from 'three';
import { arcFromBulge, arcPoints, drawCurve, type Arc } from '../core/curves';
import { Plane, TOL, Vec3 } from '../core/math';
import { AXIS_COLORS, AXIS_DIRS, type Axis, type Inference } from '../inference/InferenceEngine';
import { formatLength, parseLength } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import { InferenceLocks } from './locks';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const ARROW_AXES: Partial<Record<string, Axis>> = { ArrowRight: 'x', ArrowLeft: 'y', ArrowUp: 'z' };
const SIDES = /^\s*(\d+)\s*s\s*$/i;
const RADIUS = /^(.*?)\s*r\s*$/i;
/** Pixels within which the bulge snaps to a half circle. */
const HALF_CIRCLE_PX = 8;
const SNAPS = new Set(['endpoint', 'midpoint', 'center', 'intersection', 'guide-point', 'on-guide', 'origin', 'on-edge', 'on-axis']);

/**
 * 2-Point Arc: click the start, click the end, then pull out the bulge and click
 * (or type the bulge, or a radius as "25r"). Snaps to a half circle. "12s" sets
 * the number of segments. The arc lies on the face it starts on, else upright
 * from the ground; arrow keys pick the axis it bends around.
 */
export class ArcTool implements Tool {
  readonly id = 'arc';
  readonly name = 'Arc';
  readonly shortcut = 'A';

  private ctx!: ToolContext;
  private segments = 12;
  private start: Inference | null = null;
  private end: Vec3 | null = null;
  private arc: Arc | null = null;
  private bulge = 0;
  private halfCircle = false;
  private lockedAxis: Axis | null = null;
  private current: Inference | null = null;
  private readonly locks = new InferenceLocks();
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
      this.ctx.setStatus('Select the end point or type the chord length.');
    } else if (!this.end) {
      if (cur.point.distanceTo(this.start.point) <= TOL) return;
      this.end = cur.point;
      this.locks.reset();
      this.ctx.setStatus('Pull out the bulge, or type it (or a radius like "25r").');
    } else {
      this.commit();
    }
    this.update();
  }

  keyDown(e: KeyboardEvent): boolean {
    const axis = ARROW_AXES[e.key];
    if (axis && this.end) {
      // While bulging: arrows choose which axis the arc bends around.
      this.lockedAxis = this.lockedAxis === axis ? null : axis;
      this.update();
      return true;
    }
    if (this.start && !this.end && this.locks.keyDown(e, this.current, this.start.point)) {
      this.update();
      return true;
    }
    return false;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (!this.locks.keyUp(e)) return false;
    this.update();
    return true;
  }

  enterMeasurement(text: string): void {
    const unit = this.ctx.format.unit;
    const sides = SIDES.exec(text) ?? (!this.start ? /^\s*(\d+)\s*$/.exec(text) : null);
    if (sides) {
      this.segments = Math.max(2, Math.min(999, Number(sides[1])));
      this.showMeasurement();
      return;
    }
    const start = this.start;
    if (!start) {
      this.ctx.setStatus('Type a number of segments, or click to start the arc.');
      return;
    }
    if (!this.end) {
      const length = parseLength(text, unit);
      const dir = this.current ? this.current.point.sub(start.point) : Vec3.ZERO;
      if (length === null || length <= TOL || dir.length() <= TOL) {
        this.ctx.setStatus('Move toward the end point, then type the chord length.');
        return;
      }
      this.end = start.point.addScaled(dir.normalize(), length);
      this.ctx.setStatus('Pull out the bulge, or type it (or a radius like "25r").');
      this.update();
      return;
    }
    const sign = this.bulge < 0 ? -1 : 1;
    const radius = RADIUS.exec(text);
    let bulge: number | null;
    if (radius) {
      const r = parseLength(radius[1]!, unit);
      const half = this.end.distanceTo(start.point) / 2;
      if (r === null || r < half - TOL) {
        this.ctx.setStatus(`The radius must be at least half the chord (${formatLength(half, this.ctx.format)}).`);
        return;
      }
      bulge = r - Math.sqrt(Math.max(0, r * r - half * half));
    } else {
      bulge = parseLength(text, unit);
    }
    if (bulge === null || Math.abs(bulge) <= TOL) {
      this.ctx.setStatus(`Invalid bulge: "${text}"`);
      return;
    }
    this.bulge = sign * bulge;
    this.arc = arcFromBulge(start.point, this.end, this.bulge, this.planeNormal());
    this.commit();
  }

  draw(o: Overlay): void {
    const cur = this.current;
    if (this.arc) {
      o.polyline(arcPoints(this.arc, this.segments), { color: '#111', width: 1.5 });
    } else if (this.start && cur) {
      o.line(this.start.point, this.end ?? cur.point, { color: cur.axis && !this.end ? AXIS_COLORS[cur.axis] : '#111', width: 1.5 });
    }
    if (cur) drawInference(o, this.halfCircle ? { ...cur, tooltip: 'Half Circle' } : cur, this.last);
  }

  /** Normal of the arc's plane: the start face, a locked axis, or upright otherwise. */
  private planeNormal(): Vec3 {
    const a = this.start!.point;
    const chord = this.end!.sub(a).normalize();
    const pick = this.lockedAxis ? AXIS_DIRS[this.lockedAxis] : (this.start!.face?.normal ?? Vec3.Z);
    let n = pick.sub(chord.scale(pick.dot(chord)));
    if (n.length() < 1e-6) {
      // The chord runs along the preferred normal: face the viewer instead.
      const f = this.ctx.facing();
      n = f.sub(chord.scale(f.dot(chord)));
    }
    return n.normalize();
  }

  private update(): void {
    const e = this.last;
    if (!e) return;
    const ray = this.ctx.viewport.ray(e.ndc);
    const start = this.start;
    if (!start) {
      this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray });
      this.showMeasurement();
      return;
    }
    if (!this.end) {
      this.current = this.ctx.inference.infer({
        x: e.x,
        y: e.y,
        ray,
        from: start.point,
        lock: this.locks.lock(start.point),
        plane: start.face?.plane,
      });
      this.ctx.setMeasurement('Length', formatLength(start.point.distanceTo(this.current.point), this.ctx.format));
      return;
    }
    // Bulge: where the cursor is on the arc's plane, measured from the chord.
    const a = start.point;
    const b = this.end;
    const n = this.planeNormal();
    const plane = Plane.fromPointNormal(a, n);
    const inf = this.ctx.inference.infer({ x: e.x, y: e.y, ray, plane });
    this.current = inf;
    let p: Vec3;
    if (SNAPS.has(inf.kind)) {
      p = plane.projectPoint(inf.point);
    } else {
      const t = plane.intersectRay(ray.origin, ray.direction);
      p = t !== null ? Vec3.from(ray.origin).addScaled(ray.direction, t) : plane.projectPoint(inf.point);
    }
    const chord = b.sub(a);
    const side = n.cross(chord.normalize());
    let bulge = p.sub(a.lerp(b, 0.5)).dot(side);
    const half = chord.length() / 2;
    const mid = a.lerp(b, 0.5);
    const pxPerMm = 1 / this.ctx.camera.worldPerPixel(this.ctx.camera.depthOf(new THREE.Vector3(mid.x, mid.y, mid.z)));
    this.halfCircle = Math.abs(Math.abs(bulge) - half) * pxPerMm < HALF_CIRCLE_PX;
    if (this.halfCircle) bulge = Math.sign(bulge || 1) * half;
    this.bulge = bulge;
    this.arc = arcFromBulge(a, b, bulge, n);
    this.ctx.setMeasurement('Bulge', formatLength(Math.abs(bulge), this.ctx.format));
  }

  private commit(): void {
    const arc = this.arc;
    if (!arc) return;
    const pts = arcPoints(arc, this.segments);
    const facing = this.ctx.facing();
    this.ctx.model.transact('Arc', (m) =>
      drawCurve(m, pts, false, { kind: 'arc', center: arc.center, normal: arc.axis, radius: arc.radius }, { facing }),
    );
    this.reset();
  }

  private showMeasurement(): void {
    this.ctx.setMeasurement('Segments', String(this.segments));
  }

  private reset(): void {
    this.start = null;
    this.end = null;
    this.arc = null;
    this.bulge = 0;
    this.halfCircle = false;
    this.lockedAxis = null;
    this.locks.reset();
    this.ctx.setStatus(`Select the start point. Type a number to set segments (${this.segments}).`);
    this.showMeasurement();
    this.update();
  }
}
