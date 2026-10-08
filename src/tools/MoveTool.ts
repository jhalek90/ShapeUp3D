import { TOL, type Vec3 } from '../core/math';
import type { Mesh } from '../core/Mesh';
import { copyGeometry, transformVertices, translation, verticesOf } from '../core/transform';
import { AXIS_COLORS, type Inference } from '../inference/InferenceEngine';
import { parseArray } from '../units/angle';
import { formatLength, parseLength } from '../units/length';
import type { Overlay } from '../viewport/Overlay';
import { drawInference } from './drawInference';
import { CtrlTap, InferenceLocks } from './locks';
import { hoverTarget, resolveTargets, targetsAt, type Targets } from './targets';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const DRAG_PX = 6;

/**
 * Move / Copy: moves the selection (or the entity under the cursor) from one point
 * to another; connected geometry stretches. Ctrl toggles copying. Type a distance
 * for an exact move; after a copy, type "x5" for 5 copies or "/5" to divide.
 */
export class MoveTool implements Tool {
  readonly id = 'move';
  readonly name = 'Move';
  readonly shortcut = 'M';

  private ctx!: ToolContext;
  private start: Vec3 | null = null;
  private targets: Targets | null = null;
  private current: Inference | null = null;
  private copy = false;
  private readonly locks = new InferenceLocks();
  private readonly ctrl = new CtrlTap();
  private last: ToolPointerEvent | null = null;
  private press: { x: number; y: number } | null = null;
  private previous: { targets: Targets; offset: Vec3; copy: boolean } | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    ctx.setCursor('move');
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
    if (this.start) {
      this.update();
      return;
    }
    hoverTarget(this.ctx, e);
    this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) });
  }

  pointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.last = e;
    if (this.start) {
      if (this.current) this.commit(this.current.point.sub(this.start));
      return;
    }
    const targets = targetsAt(this.ctx, e);
    if (!targets) {
      this.ctx.setStatus('Nothing to move here. Select something, or click on an edge or face.');
      return;
    }
    this.current = this.ctx.inference.infer({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) });
    this.targets = targets;
    this.start = this.current.point;
    this.press = { x: e.x, y: e.y };
    this.ctx.highlight();
    this.ctx.model.beginPreview();
    this.prompt();
  }

  pointerUp(e: ToolPointerEvent): void {
    const press = this.press;
    if (e.button !== 0 || !press || !this.start) return;
    this.press = null;
    if (Math.hypot(e.x - press.x, e.y - press.y) > DRAG_PX && this.current) this.commit(this.current.point.sub(this.start));
  }

  keyDown(e: KeyboardEvent): boolean {
    this.ctrl.keyDown(e);
    if (!this.locks.keyDown(e, this.current, this.start)) return false;
    this.update();
    return true;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (this.ctrl.keyUp(e)) {
      this.copy = !this.copy;
      this.prompt();
      this.update();
      return true;
    }
    if (!this.locks.keyUp(e)) return false;
    this.update();
    return true;
  }

  enterMeasurement(text: string): void {
    const unit = this.ctx.format.unit;
    if (this.start && this.current) {
      const length = parseLength(text, unit);
      const dir = this.current.point.sub(this.start);
      if (length === null) this.ctx.setStatus(`Invalid distance: "${text}"`);
      else if (dir.length() <= TOL) this.ctx.setStatus('Move the cursor to choose a direction, then type the distance.');
      else this.commit(dir.normalize().scale(length));
      return;
    }
    // Right after a move or copy: change its distance, or turn a copy into an array.
    const prev = this.previous;
    if (!prev || this.ctx.model.undoName !== (prev.copy ? 'Copy' : 'Move')) {
      this.ctx.setStatus('Pick a point to move from first.');
      return;
    }
    const array = parseArray(text);
    if (array) {
      if (!prev.copy) {
        this.ctx.setStatus('Arrays work after a copy (hold Ctrl while moving).');
        return;
      }
      this.ctx.model.undo();
      this.ctx.model.transact('Copy', (m) => {
        const { faces, edges } = resolveTargets(m, prev.targets);
        for (let i = 1; i <= array.count; i++) {
          const k = array.mode === 'multiply' ? i : i / array.count;
          copyGeometry(m, faces, edges, translation(prev.offset.scale(k)));
        }
      });
      return;
    }
    const length = parseLength(text, unit);
    if (length === null) {
      this.ctx.setStatus(`Invalid distance: "${text}"`);
      return;
    }
    this.ctx.model.undo();
    this.run(prev.targets, prev.offset.normalize().scale(length), prev.copy);
  }

  draw(o: Overlay): void {
    const cur = this.current;
    if (!cur) return;
    if (this.start) {
      o.line(this.start, cur.point, { color: cur.axis ? AXIS_COLORS[cur.axis] : '#111', width: cur.axis ? 2 : 1.5, dash: [5, 3] });
    }
    drawInference(o, cur, this.last);
  }

  private update(): void {
    const e = this.last;
    const start = this.start;
    const targets = this.targets;
    if (!e || !start || !targets) return;
    // Infer against the model as it was, so the moving geometry doesn't snap to itself.
    this.ctx.model.showPreview();
    this.current = this.ctx.inference.infer({
      x: e.x,
      y: e.y,
      ray: this.ctx.viewport.ray(e.ndc),
      from: start,
      lock: this.locks.lock(start),
    });
    const offset = this.current.point.sub(start);
    const copy = this.copy;
    this.ctx.model.showPreview((m) => apply(m, targets, offset, copy));
    this.ctx.setMeasurement('Distance', formatLength(offset.length(), this.ctx.format));
  }

  private commit(offset: Vec3): void {
    const targets = this.targets;
    this.ctx.model.endPreview();
    if (targets && offset.length() > TOL) this.run(targets, offset, this.copy);
    this.reset();
  }

  private run(targets: Targets, offset: Vec3, copy: boolean): void {
    this.ctx.model.transact(copy ? 'Copy' : 'Move', (m) => apply(m, targets, offset, copy));
    this.previous = { targets, offset, copy };
    this.ctx.setMeasurement('Distance', formatLength(offset.length(), this.ctx.format));
  }

  private reset(): void {
    this.start = null;
    this.targets = null;
    this.press = null;
    this.locks.reset();
    this.prompt();
  }

  private prompt(): void {
    if (!this.start) {
      this.ctx.setStatus(`Pick a point to ${this.copy ? 'copy' : 'move'} from. Ctrl toggles copy.`);
    } else {
      this.ctx.setStatus(`Pick the destination or type a distance${this.copy ? ' (copying)' : ''}. Arrows lock an axis; Ctrl toggles copy.`);
    }
  }
}

function apply(m: Mesh, targets: Targets, offset: Vec3, copy: boolean): void {
  const { faces, edges } = resolveTargets(m, targets);
  if (copy) copyGeometry(m, faces, edges, translation(offset));
  else transformVertices(m, verticesOf(faces, edges), translation(offset));
}
