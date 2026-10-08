import type { Edge } from '../core/Mesh';
import { eraseEdges } from '../core/ops';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

/**
 * Eraser: click an edge, or drag across several, to erase them (and the faces
 * they bound; coplanar faces merge). Shift hides edges instead; Ctrl softens and
 * smooths them; Ctrl+Shift un-softens.
 */
export class EraserTool implements Tool {
  readonly id = 'eraser';
  readonly name = 'Eraser';
  readonly shortcut = 'E';

  private ctx!: ToolContext;
  private marked: Set<number> | null = null;
  private hover: Edge | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    ctx.setCursor('crosshair');
    ctx.setStatus('Click or drag over edges to erase. Shift = hide, Ctrl = soften/smooth, Ctrl+Shift = unsoften.');
  }

  deactivate(): void {
    this.ctx.highlight();
  }

  cancel(): void {
    this.marked = null;
    this.ctx.highlight();
  }

  pointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.marked = new Set();
    this.mark(e);
  }

  pointerMove(e: ToolPointerEvent): void {
    this.mark(e);
  }

  pointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0 || !this.marked) return;
    const mesh = this.ctx.model.mesh;
    const ids = [...this.marked];
    this.marked = null;
    this.ctx.highlight();
    if (ids.length === 0) return;
    const edges = (m: typeof mesh) => ids.map((id) => m.edges.get(id)).filter((x): x is Edge => !!x);
    if (e.ctrlKey && e.shiftKey) {
      this.ctx.model.transact('Unsoften', (m) => edges(m).forEach((x) => Object.assign(x, { soft: false, smooth: false })));
    } else if (e.ctrlKey) {
      this.ctx.model.transact('Soften', (m) => edges(m).forEach((x) => Object.assign(x, { soft: true, smooth: true })));
    } else if (e.shiftKey) {
      this.ctx.model.transact('Hide', (m) => edges(m).forEach((x) => (x.hidden = true)));
    } else {
      this.ctx.model.transact('Erase', (m) => eraseEdges(m, edges(m)));
    }
  }

  private mark(e: ToolPointerEvent): void {
    const hit = this.ctx.inference.pick({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) }, 'edge');
    this.hover = hit?.edge ?? null;
    const mesh = this.ctx.model.mesh;
    // Erasing one segment of a curve erases the whole curve, as in SketchUp.
    const hovered = this.hover ? (this.hover.curve ? mesh.curveEdges(this.hover.curve) : [this.hover]) : [];
    if (this.marked) for (const e of hovered) this.marked.add(e.id);
    const shown = new Set<Edge>();
    for (const id of this.marked ?? []) {
      const edge = mesh.edges.get(id);
      if (edge) shown.add(edge);
    }
    for (const e of hovered) shown.add(e);
    this.ctx.highlight([], shown);
  }
}
