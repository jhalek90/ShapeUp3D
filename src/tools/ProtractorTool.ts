import * as THREE from 'three';
import { Plane, TOL, Vec3 } from '../core/math';
import { rotation } from '../core/transform';
import { AXIS_COLORS, AXIS_DIRS, type Axis, type Inference } from '../inference/InferenceEngine';
import { formatAngle, parseAngle } from '../units/angle';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const ARROW_AXES: Partial<Record<string, Axis>> = { ArrowRight: 'x', ArrowLeft: 'y', ArrowUp: 'z' };
const SNAP_STEP = Math.PI / 12; // 15°
const SNAP_RANGE = (2.5 * Math.PI) / 180;
const PROTRACTOR_PX = 45;

/**
 * Protractor: click the center (on the face under the cursor, or flat; arrows pick
 * an axis), click a reference direction, then click or type an angle. Leaves a
 * guide line through the center at that angle. Snaps to 15°.
 */
export class ProtractorTool implements Tool {
  readonly id = 'protractor';
  readonly name = 'Protractor';
  readonly shortcut = undefined;

  private ctx!: ToolContext;
  private center: Vec3 | null = null;
  private axis: Vec3 = Vec3.Z;
  private lockedAxis: Axis | null = null;
  private reference: Vec3 | null = null;
  private angle = 0;
  private current: Inference | null = null;
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
    if (!this.center) {
      this.center = cur.point;
      this.ctx.setStatus('Click a reference direction (where 0° is).');
    } else if (!this.reference) {
      const dir = this.inPlane(cur.point);
      if (!dir) return;
      this.reference = dir;
      this.ctx.setStatus('Click or type the angle for the guide.');
    } else {
      this.commit(this.angle);
    }
    this.update();
  }

  keyDown(e: KeyboardEvent): boolean {
    const axis = ARROW_AXES[e.key];
    if (!axis || this.center) return false;
    this.lockedAxis = this.lockedAxis === axis ? null : axis;
    this.update();
    return true;
  }

  enterMeasurement(text: string): void {
    if (!this.reference) {
      this.ctx.setStatus('Place the protractor and pick a reference direction first.');
      return;
    }
    const a = parseAngle(text);
    if (a === null) this.ctx.setStatus(`Invalid angle: "${text}"`);
    else this.commit(this.angle < 0 ? -a : a);
  }

  draw(o: Overlay): void {
    const cur = this.current;
    if (!cur) return;
    const center = this.center ?? cur.point;
    const { u, v } = Plane.fromPointNormal(center, this.axis).basis();
    const radius = this.ctx.camera.worldPerPixel(this.ctx.camera.depthOf(new THREE.Vector3(center.x, center.y, center.z))) * PROTRACTOR_PX;
    const circle: Vec3[] = [];
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      circle.push(center.addScaled(u, Math.cos(t) * radius).addScaled(v, Math.sin(t) * radius));
    }
    o.polyline(circle, { color: this.axisColor(), width: 1.5 }, true);
    if (this.center && this.reference) {
      o.line(this.center, this.center.addScaled(this.reference, radius * 1.6), { color: '#555', width: 1, dash: [4, 3] });
      const dir = rotation(Vec3.ZERO, this.axis, this.angle)(this.reference);
      const reach = this.ctx.camera.distance * 4;
      o.line(this.center.addScaled(dir, -reach), this.center.addScaled(dir, reach), { color: '#5a5f66', width: 1, dash: [6, 4] });
    } else if (this.center) {
      o.line(this.center, cur.point, { color: '#555', width: 1, dash: [4, 3] });
    }
    drawInference(o, cur, this.last);
  }

  private update(): void {
    const e = this.last;
    if (!e) return;
    const ray = this.ctx.viewport.ray(e.ndc);
    if (!this.center) {
      this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray });
      this.axis = this.lockedAxis ? AXIS_DIRS[this.lockedAxis] : (this.current.face?.normal ?? Vec3.Z);
      return;
    }
    this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray, from: this.center, plane: Plane.fromPointNormal(this.center, this.axis) });
    if (!this.reference) return;
    const dir = this.inPlane(this.current.point);
    if (!dir) return;
    let angle = Math.atan2(this.reference.cross(dir).dot(this.axis), this.reference.dot(dir));
    const snapped = Math.round(angle / SNAP_STEP) * SNAP_STEP;
    if (Math.abs(angle - snapped) < SNAP_RANGE) angle = snapped;
    this.angle = angle;
    this.ctx.setMeasurement('Angle', formatAngle(angle));
  }

  private inPlane(p: Vec3): Vec3 | null {
    const d = p.sub(this.center!);
    const flat = d.sub(this.axis.scale(d.dot(this.axis)));
    return flat.length() > TOL ? flat.normalize() : null;
  }

  private axisColor(): string {
    for (const a of ['x', 'y', 'z'] as const) if (Math.abs(this.axis.dot(AXIS_DIRS[a])) > 1 - 1e-9) return AXIS_COLORS[a];
    return '#777';
  }

  private commit(angle: number): void {
    const center = this.center!;
    const dir = rotation(Vec3.ZERO, this.axis, angle)(this.reference!);
    this.ctx.model.transact('Guide', (m) => m.addGuideLine(center, dir));
    this.reset();
    this.ctx.setMeasurement('Angle', formatAngle(angle));
  }

  private reset(): void {
    this.center = null;
    this.reference = null;
    this.angle = 0;
    this.ctx.setStatus('Click to place the protractor. Arrows pick an axis.');
    this.update();
  }
}
