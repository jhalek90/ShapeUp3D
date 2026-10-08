import { TOL, Vec3 } from '../core/math';
import { scaling, transformVertices, verticesOf } from '../core/transform';
import type { Inference } from '../inference/InferenceEngine';
import { formatLength, parseLengthList } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import { CtrlTap } from './locks';
import { connected } from './SelectTool';
import { resolveTargets, type Targets } from './targets';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const GRIP_PX = 10;

interface Grip {
  /** Position as fractions of the bounding box (0, 0.5 or 1 per axis). */
  at: [number, number, number];
  /** Axes this grip scales (corner: 3, edge: 2, face: 1). */
  axes: [boolean, boolean, boolean];
}

interface Box {
  min: Vec3;
  max: Vec3;
}

/**
 * Scale: grips on the selection's bounding box. Corners scale uniformly, edge
 * midpoints in two directions, face centers in one. Drag (or click, move, click),
 * or type a factor ("2"), per-axis factors ("2,1,1"), or a size ("50mm") for a
 * face grip. Scales about the opposite grip; Ctrl toggles scaling about the center.
 * With nothing selected, click an object to select it.
 */
export class ScaleTool implements Tool {
  readonly id = 'scale';
  readonly name = 'Scale';
  readonly shortcut = 'S';

  private ctx!: ToolContext;
  private targets: Targets | null = null;
  private box: Box | null = null;
  private hover: Grip | null = null;
  private drag: { grip: Grip; factor: number } | null = null;
  private aboutCenter = false;
  private readonly ctrl = new CtrlTap();
  private current: Inference | null = null;
  private last: ToolPointerEvent | null = null;
  private press: { x: number; y: number } | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    ctx.setCursor('default');
    this.loadSelection();
  }

  cancel(): void {
    this.ctx.model.endPreview();
    this.drag = null;
    this.loadSelection();
  }

  pointerMove(e: ToolPointerEvent): void {
    this.last = e;
    if (this.drag) {
      this.updateDrag();
      return;
    }
    // Keep up with selection / model changes (undo, selecting with the mouse).
    if (this.ctx.selection.size !== (this.targets ? this.targets.faceIds.length + this.targets.edgeIds.length : 0)) this.loadSelection();
    else if (this.targets) this.box = this.computeBox();
    this.hover = this.gripAt(e);
  }

  pointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.last = e;
    if (this.drag) {
      this.commit(this.drag.factor);
      return;
    }
    if (!this.targets) {
      // Nothing selected: select the object under the cursor.
      const hit = this.ctx.inference.pick({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) });
      const entity = hit?.face ?? hit?.edge;
      if (entity) this.ctx.selection.set(connected(this.ctx.model.mesh, entity));
      this.loadSelection();
      return;
    }
    const grip = this.gripAt(e);
    if (!grip) return;
    this.drag = { grip, factor: 1 };
    this.press = { x: e.x, y: e.y };
    this.ctx.model.beginPreview();
    this.ctx.setStatus('Move to scale, then click — or type a factor (2), factors (2,1,1) or a size (50mm). Ctrl: about center.');
  }

  pointerUp(e: ToolPointerEvent): void {
    const press = this.press;
    this.press = null;
    if (e.button !== 0 || !press || !this.drag) return;
    if (Math.hypot(e.x - press.x, e.y - press.y) > 6) this.commit(this.drag.factor);
  }

  keyDown(e: KeyboardEvent): boolean {
    this.ctrl.keyDown(e);
    return false;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (!this.ctrl.keyUp(e)) return false;
    this.aboutCenter = !this.aboutCenter;
    if (this.drag) this.updateDrag();
    this.ctx.setStatus(this.aboutCenter ? 'Scaling about the center.' : 'Scaling about the opposite grip.');
    return true;
  }

  enterMeasurement(text: string): void {
    const drag = this.drag;
    if (!drag || !this.box) {
      this.ctx.setStatus('Pick a grip first, then type the scale.');
      return;
    }
    const { grip } = drag;
    const size = this.box.max.sub(this.box.min);
    const sizes = [size.x, size.y, size.z];
    const active = [0, 1, 2].filter((i) => grip.axes[i]);
    let factors: [number, number, number] | null = null;

    const parts = text.split(/[,;]/).map((t) => t.trim());
    const plain = parts.every((t) => /^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(t));
    if (plain && parts.length === 1) {
      const f = Number(parts[0]);
      factors = [0, 1, 2].map((i) => (grip.axes[i] ? f : 1)) as [number, number, number];
    } else if (plain && parts.length === active.length) {
      factors = [1, 1, 1];
      active.forEach((axis, k) => (factors![axis] = Number(parts[k])));
    } else if (active.length === 1) {
      // A size along the one axis this grip scales.
      const lengths = parseLengthList(text, this.ctx.format.unit);
      const length = lengths?.[0];
      const axis = active[0]!;
      if (lengths && lengths.length === 1 && length != null && sizes[axis]! > TOL) {
        factors = [1, 1, 1];
        factors[axis] = length / sizes[axis]!;
      }
    }
    if (!factors) {
      this.ctx.setStatus(`Enter a factor like "2"${active.length > 1 ? ` or ${active.length} factors like "${active.map(() => '1.5').join(',')}"` : ' or a size like "50mm"'}.`);
      return;
    }
    if (factors.some((f) => !(f > 0))) {
      this.ctx.setStatus('Scale factors must be positive (mirroring is not supported yet).');
      return;
    }
    this.commitFactors(new Vec3(...factors));
  }

  draw(o: Overlay): void {
    const box = this.box;
    if (!box) return;
    // Bounding box outline.
    const c = (i: number, j: number, k: number) => this.point([i, j, k]);
    const corners = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
    const style = { color: '#2f6fde', width: 1, dash: [4, 3] };
    for (let i = 0; i < 4; i++) {
      o.line(corners[i]!, corners[(i + 1) % 4]!, style);
      o.line(corners[i + 4]!, corners[((i + 1) % 4) + 4]!, style);
      o.line(corners[i]!, corners[i + 4]!, style);
    }
    const active = this.drag?.grip ?? this.hover;
    for (const g of this.grips()) {
      o.marker(this.point(g.at), 'square', active && sameGrip(g, active) ? '#e02424' : '#2f6fde');
    }
    if (this.current && this.drag) drawInference(o, this.current, this.last);
  }

  // ---- internals ------------------------------------------------------------

  private loadSelection(): void {
    const sel = this.ctx.selection;
    if (sel.isEmpty) {
      this.targets = null;
      this.box = null;
      this.ctx.setStatus('Click an object to scale it (or select first).');
      return;
    }
    this.targets = { faceIds: sel.faces.map((f) => f.id), edgeIds: sel.edges.map((e) => e.id) };
    this.box = this.computeBox();
    this.ctx.setStatus('Drag a grip to scale. Corners: uniform; edges: two directions; face centers: one.');
    this.ctx.setMeasurement('Scale', '');
  }

  private computeBox(): Box | null {
    const { faces, edges } = resolveTargets(this.ctx.model.mesh, this.targets!);
    const verts = [...verticesOf(faces, edges)];
    if (verts.length === 0) return null;
    const xs = verts.map((v) => v.pos.x);
    const ys = verts.map((v) => v.pos.y);
    const zs = verts.map((v) => v.pos.z);
    return { min: new Vec3(Math.min(...xs), Math.min(...ys), Math.min(...zs)), max: new Vec3(Math.max(...xs), Math.max(...ys), Math.max(...zs)) };
  }

  /** Grips, skipping directions the box is flat in. */
  private grips(): Grip[] {
    const box = this.box;
    if (!box) return [];
    const size = box.max.sub(box.min);
    const flat = [size.x, size.y, size.z].map((s) => s <= TOL);
    const out: Grip[] = [];
    const steps = [0, 0.5, 1];
    for (const i of steps)
      for (const j of steps)
        for (const k of steps) {
          const at: [number, number, number] = [i, j, k];
          if (at.some((t, axis) => flat[axis] && t !== 0)) continue; // collapse flat directions
          const axes = at.map((t, axis) => t !== 0.5 && !flat[axis]) as [boolean, boolean, boolean];
          if (!axes.some(Boolean)) continue; // the center
          out.push({ at, axes });
        }
    return out;
  }

  private point(at: readonly number[]): Vec3 {
    const { min, max } = this.box!;
    return new Vec3(min.x + (max.x - min.x) * at[0]!, min.y + (max.y - min.y) * at[1]!, min.z + (max.z - min.z) * at[2]!);
  }

  private anchor(grip: Grip): Vec3 {
    if (this.aboutCenter) return this.point([0.5, 0.5, 0.5]);
    return this.point(grip.at.map((t, axis) => (grip.axes[axis] ? 1 - t : t)));
  }

  private gripAt(e: ToolPointerEvent): Grip | null {
    let best: Grip | null = null;
    let bestPx = GRIP_PX;
    for (const g of this.grips()) {
      const s = this.ctx.inference.screen(this.point(g.at));
      if (!s) continue;
      const d = Math.hypot(s.x - e.x, s.y - e.y);
      if (d < bestPx) {
        bestPx = d;
        best = g;
      }
    }
    return best;
  }

  private updateDrag(): void {
    const drag = this.drag;
    const e = this.last;
    if (!drag || !e) return;
    const anchor = this.anchor(drag.grip);
    const handle = this.point(drag.grip.at).sub(anchor);
    if (handle.length() <= TOL) return;
    this.ctx.model.showPreview();
    // Snap along the line from the anchor through the grip.
    const inf = this.ctx.inference.infer({
      x: e.x,
      y: e.y,
      ray: this.ctx.viewport.ray(e.ndc),
      lock: { kind: 'line', origin: anchor, dir: handle, tooltip: '' },
    });
    this.current = { ...inf, tooltip: inf.refTooltip ?? '', refTooltip: undefined };
    let factor = inf.point.sub(anchor).dot(handle) / handle.lengthSq();
    factor = Math.max(factor, 0.001);
    // Gentle snapping to tidy factors.
    const tidy = Math.round(factor * 10) / 10;
    if (Math.abs(factor - tidy) < 0.02) factor = tidy;
    drag.factor = factor;
    const factors = this.factorsFor(drag.grip, factor);
    const { targets } = this;
    this.ctx.model.showPreview((m) => {
      const { faces, edges } = resolveTargets(m, targets!);
      transformVertices(m, verticesOf(faces, edges), scaling(anchor, factors));
    });
    this.ctx.setMeasurement('Scale', factor.toFixed(2));
  }

  private factorsFor(grip: Grip, f: number): Vec3 {
    return new Vec3(grip.axes[0] ? f : 1, grip.axes[1] ? f : 1, grip.axes[2] ? f : 1);
  }

  private commit(factor: number): void {
    if (!this.drag) return;
    this.commitFactors(this.factorsFor(this.drag.grip, factor));
  }

  private commitFactors(factors: Vec3): void {
    const drag = this.drag!;
    const anchor = this.anchor(drag.grip);
    const targets = this.targets!;
    this.ctx.model.endPreview();
    this.drag = null;
    if (Math.abs(factors.x - 1) > 1e-9 || Math.abs(factors.y - 1) > 1e-9 || Math.abs(factors.z - 1) > 1e-9) {
      this.ctx.model.transact('Scale', (m) => {
        const { faces, edges } = resolveTargets(m, targets);
        transformVertices(m, verticesOf(faces, edges), scaling(anchor, factors));
      });
    }
    this.loadSelection();
    const box = this.box;
    if (box) {
      const s = box.max.sub(box.min);
      const fmt = (n: number) => formatLength(n, this.ctx.format);
      this.ctx.setStatus(`Scaled. Size now ${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)}.`);
    }
    this.ctx.setMeasurement('Scale', [factors.x, factors.y, factors.z].filter((f) => f !== 1).map((f) => +f.toFixed(4)).join(', ') || '1');
  }
}

function sameGrip(a: Grip, b: Grip): boolean {
  return a.at.every((t, i) => t === b.at[i]);
}
