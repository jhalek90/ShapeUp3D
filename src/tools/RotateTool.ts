import * as THREE from 'three';
import { Plane, TOL, Vec3 } from '../core/math';
import { Transform } from '../core/affine';
import type { Mesh } from '../core/Mesh';
import type { Model } from '../core/Model';
import { rotation } from '../core/transform';
import { AXIS_COLORS, AXIS_DIRS, type Axis, type Inference } from '../inference/InferenceEngine';
import { formatAngle, parseAngle, parseArray } from '../units/angle';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import { AXIS_NAMES, CtrlTap } from './locks';
import { hoverTarget, targetsAt, transformTargets, type Targets } from './targets';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const ARROW_AXES: Partial<Record<string, Axis>> = { ArrowRight: 'x', ArrowLeft: 'y', ArrowUp: 'z' };
/** Angles snap to multiples of this when the cursor is close. */
const SNAP_STEP = Math.PI / 12; // 15°
const SNAP_RANGE = (2.5 * Math.PI) / 180;
const PROTRACTOR_PX = 45;

/**
 * Rotate: click the center (the protractor lies on the face under the cursor, or
 * flat on the ground; arrow keys pick the red/green/blue axis), click a reference
 * point, then click or type the angle. Angles snap to 15°. Ctrl toggles copying;
 * after a rotated copy, type "x6" for a radial array or "/6" to divide.
 */
export class RotateTool implements Tool {
  readonly id = 'rotate';
  readonly name = 'Rotate';
  readonly shortcut = 'Q';

  private ctx!: ToolContext;
  private stage: 'center' | 'reference' | 'angle' = 'center';
  private center: Vec3 | null = null;
  private axis: Vec3 = Vec3.Z;
  private lockedAxis: Axis | null = null;
  private reference: Vec3 | null = null;
  private angle = 0;
  private targets: Targets | null = null;
  private copy = false;
  private readonly ctrl = new CtrlTap();
  private current: Inference | null = null;
  private last: ToolPointerEvent | null = null;
  private previous: { targets: Targets; center: Vec3; axis: Vec3; angle: number; copy: boolean } | null = null;

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
    this.update();
  }

  pointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.last = e;
    this.update();
    const cur = this.current;
    if (!cur) return;
    if (this.stage === 'center') {
      const targets = targetsAt(this.ctx, e);
      if (!targets) {
        this.ctx.setStatus('Nothing to rotate here. Select something, or start on an edge or face.');
        return;
      }
      this.targets = targets;
      this.center = cur.point;
      this.stage = 'reference';
      this.ctx.highlight();
      this.ctx.setStatus('Pick a point to start the rotation from.');
    } else if (this.stage === 'reference') {
      const ref = this.inPlane(cur.point);
      if (!ref) return;
      this.reference = ref;
      this.stage = 'angle';
      this.ctx.model.beginPreview();
      this.ctx.setStatus('Pick the angle or type it in degrees. Ctrl toggles copy.');
    } else {
      this.commit(this.angle);
    }
  }

  keyDown(e: KeyboardEvent): boolean {
    this.ctrl.keyDown(e);
    const axis = ARROW_AXES[e.key];
    if (axis && this.stage === 'center') {
      this.lockedAxis = this.lockedAxis === axis ? null : axis;
      this.update();
      return true;
    }
    return false;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (!this.ctrl.keyUp(e)) return false;
    this.copy = !this.copy;
    this.update();
    return true;
  }

  enterMeasurement(text: string): void {
    if (this.stage === 'angle') {
      const a = parseAngle(text);
      if (a === null) this.ctx.setStatus(`Invalid angle: "${text}"`);
      // Follow the direction the mouse is turning.
      else this.commit(this.angle < 0 ? -a : a);
      return;
    }
    const prev = this.previous;
    if (!prev || this.ctx.model.undoName !== (prev.copy ? 'Copy' : 'Rotate')) {
      this.ctx.setStatus('Click to place the protractor first.');
      return;
    }
    const array = parseArray(text);
    if (array) {
      if (!prev.copy) {
        this.ctx.setStatus('Arrays work after a rotated copy (press Ctrl while rotating).');
        return;
      }
      this.ctx.model.undo();
      this.ctx.model.transact('Copy', (m, model) => {
        for (let i = 1; i <= array.count; i++) {
          const k = array.mode === 'multiply' ? i : i / array.count;
          transformTargets(model, m, prev.targets, Transform.rotation(prev.center, prev.axis, prev.angle * k), true);
        }
      });
      return;
    }
    const a = parseAngle(text);
    if (a === null) {
      this.ctx.setStatus(`Invalid angle: "${text}"`);
      return;
    }
    this.ctx.model.undo();
    this.run(prev.targets, prev.center, prev.axis, Math.sign(prev.angle || 1) * Math.abs(a), prev.copy);
  }

  draw(o: Overlay): void {
    const cur = this.current;
    if (!cur) return;
    const center = this.center ?? cur.point;
    const color = this.axisColor();
    const { u, v } = Plane.fromPointNormal(center, this.axis).basis();
    const radius = this.ctx.camera.worldPerPixel(this.ctx.camera.depthOf(new THREE.Vector3(center.x, center.y, center.z))) * PROTRACTOR_PX;
    const circle: Vec3[] = [];
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      circle.push(center.addScaled(u, Math.cos(t) * radius).addScaled(v, Math.sin(t) * radius));
    }
    o.polyline(circle, { color, width: 1.5 }, true);
    if (this.reference && this.center) {
      o.line(this.center, this.center.addScaled(this.reference, radius * 1.6), { color: '#555', width: 1, dash: [4, 3] });
      const r = rotation(Vec3.ZERO, this.axis, this.angle)(this.reference);
      o.line(this.center, this.center.addScaled(r, radius * 1.6), { color: '#111', width: 1.5 });
    } else if (this.center) {
      o.line(this.center, cur.point, { color: '#555', width: 1, dash: [4, 3] });
    }
    drawInference(o, cur, this.last);
  }

  private update(): void {
    const e = this.last;
    if (!e) return;
    const ray = this.ctx.viewport.ray(e.ndc);
    if (this.stage === 'center') {
      hoverTarget(this.ctx, e);
      this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray });
      // The protractor lies on the face under the cursor unless an axis is locked.
      this.axis = this.lockedAxis ? AXIS_DIRS[this.lockedAxis] : (this.current.face?.normal ?? Vec3.Z);
      this.ctx.setMeasurement('Angle', '');
      return;
    }
    const center = this.center!;
    if (this.stage === 'angle') this.ctx.model.showPreview();
    this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray, from: center, plane: Plane.fromPointNormal(center, this.axis) });
    if (this.stage !== 'angle' || !this.reference) return;
    const dir = this.inPlane(this.current.point);
    if (!dir) return;
    let angle = Math.atan2(this.reference.cross(dir).dot(this.axis), this.reference.dot(dir));
    const snapped = Math.round(angle / SNAP_STEP) * SNAP_STEP;
    if (Math.abs(angle - snapped) < SNAP_RANGE) angle = snapped;
    this.angle = angle;
    const { targets, axis, copy } = this;
    this.ctx.model.showPreview((m, model) => apply(model, m, targets!, center, axis, angle, copy));
    this.ctx.setMeasurement('Angle', formatAngle(angle));
  }

  /** Unit direction from the center to p within the rotation plane, or null if p is on the axis. */
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
    const { targets, center, axis, copy } = this;
    this.ctx.model.endPreview();
    if (targets && center && Math.abs(angle) > 1e-9) this.run(targets, center, axis, angle, copy);
    this.reset();
  }

  private run(targets: Targets, center: Vec3, axis: Vec3, angle: number, copy: boolean): void {
    this.ctx.model.transact(copy ? 'Copy' : 'Rotate', (m, model) => apply(model, m, targets, center, axis, angle, copy));
    this.previous = { targets, center, axis, angle, copy };
    this.ctx.setMeasurement('Angle', formatAngle(angle));
  }

  private reset(): void {
    this.stage = 'center';
    this.center = null;
    this.reference = null;
    this.angle = 0;
    this.targets = null;
    const axis = this.lockedAxis ? ` (locked to ${AXIS_NAMES[this.lockedAxis]} axis)` : '';
    this.ctx.setStatus(`Click to place the protractor${axis}. Arrows pick an axis; Ctrl toggles copy.`);
  }
}

function apply(model: Model, m: Mesh, targets: Targets, center: Vec3, axis: Vec3, angle: number, copy: boolean): void {
  transformTargets(model, m, targets, Transform.rotation(center, axis, angle), copy);
}
