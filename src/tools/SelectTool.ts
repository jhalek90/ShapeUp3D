import type { Entity } from '../app/Selection';
import type { Vec3 } from '../core/math';
import type { Edge, Face, Mesh } from '../core/Mesh';
import type { Overlay } from '../viewport/Overlay';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

const DRAG_PX = 4;

type Mode = 'replace' | 'add' | 'toggle' | 'remove';

/**
 * Select tool, as in SketchUp:
 * - click selects an edge or face; double-click adds its neighbours (face + its
 *   edges, or edge + its faces); triple-click selects everything connected;
 * - drag left→right selects what's fully inside the box (window), right→left what
 *   the box touches (crossing);
 * - Ctrl adds, Shift toggles, Ctrl+Shift removes; clicking empty space clears.
 */
export class SelectTool implements Tool {
  readonly id = 'select';
  readonly name = 'Select';
  readonly shortcut = 'Space';

  private ctx!: ToolContext;
  private press: { x: number; y: number; e: ToolPointerEvent } | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    ctx.setStatus('Click or drag to select. Ctrl = add, Shift = toggle, Ctrl+Shift = remove. Delete erases.');
  }

  cancel(): void {
    this.press = null;
    this.box = null;
  }

  keyDown(e: KeyboardEvent): boolean {
    // Esc abandons a drag, or else clears the selection. (Switching tools keeps it.)
    if (e.key !== 'Escape') return false;
    if (this.press || this.box) this.cancel();
    else this.ctx.selection.clear();
    return true;
  }

  pointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    // Double/triple clicks act immediately; single clicks wait to see if it's a drag.
    if (e.clicks >= 2) {
      this.press = null;
      this.clickSelect(e, e.clicks >= 3 ? 'connected' : 'neighbours');
      return;
    }
    this.press = { x: e.x, y: e.y, e };
  }

  pointerMove(e: ToolPointerEvent): void {
    const p = this.press;
    if (!p) return;
    if (this.box || Math.hypot(e.x - p.x, e.y - p.y) > DRAG_PX) this.box = { x0: p.x, y0: p.y, x1: e.x, y1: e.y };
  }

  pointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    const press = this.press;
    const box = this.box;
    this.press = null;
    this.box = null;
    if (box) this.boxSelect(box, mode(e));
    else if (press) this.clickSelect(press.e, 'single');
  }

  draw(o: Overlay): void {
    const b = this.box;
    if (!b) return;
    const crossing = b.x1 < b.x0;
    o.rect(b.x0, b.y0, b.x1, b.y1, { color: '#222', width: 1, dash: crossing ? [4, 3] : undefined });
  }

  private clickSelect(e: ToolPointerEvent, extent: 'single' | 'neighbours' | 'connected'): void {
    const hit = this.ctx.inference.pick({ x: e.x, y: e.y, ray: this.ctx.viewport.ray(e.ndc) });
    const m = mode(e);
    if (!hit) {
      if (m === 'replace') this.ctx.selection.clear();
      return;
    }
    const entity: Entity = (hit.edge ?? hit.face)!;
    const mesh = this.ctx.model.mesh;
    // An edge of a circle or arc stands for the whole curve.
    const base: Entity[] = hit.edge?.curve ? mesh.curveEdges(hit.edge.curve) : [entity];
    const entities =
      extent === 'single' ? base : extent === 'neighbours' ? [...new Set(base.flatMap((x) => neighbours(mesh, x)))] : connected(mesh, entity);
    // A double-click's first click already selected (or toggled) the entity; don't undo that.
    apply(this.ctx, extent !== 'single' && m === 'toggle' ? 'add' : m, entities);
  }

  private boxSelect(b: { x0: number; y0: number; x1: number; y1: number }, m: Mode): void {
    const crossing = b.x1 < b.x0;
    const r = { x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1) };
    const screen = (p: Vec3) => this.ctx.inference.screen(p);
    const mesh = this.ctx.model.mesh;
    const picked: Entity[] = [];
    for (const e of mesh.edges.values()) {
      if (e.hidden) continue;
      const a = screen(e.v0.pos);
      const c = screen(e.v1.pos);
      if (!a || !c) continue;
      if (crossing ? segmentTouchesRect(a, c, r) : inRect(a, r) && inRect(c, r)) picked.push(e);
    }
    for (const f of mesh.faces.values()) {
      const pts = f.outer.map((v) => screen(v.pos));
      if (pts.some((p) => !p)) continue;
      const poly = pts as { x: number; y: number }[];
      const touches = () =>
        poly.some((p) => inRect(p, r)) ||
        poly.some((p, i) => segmentTouchesRect(p, poly[(i + 1) % poly.length]!, r)) ||
        pointInPoly({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }, poly);
      if (crossing ? touches() : poly.every((p) => inRect(p, r))) picked.push(f);
    }
    if (picked.length === 0 && m === 'replace') this.ctx.selection.clear();
    else apply(this.ctx, m, picked);
  }
}

function mode(e: ToolPointerEvent): Mode {
  if (e.ctrlKey && e.shiftKey) return 'remove';
  if (e.ctrlKey) return 'add';
  if (e.shiftKey) return 'toggle';
  return 'replace';
}

function apply(ctx: ToolContext, m: Mode, entities: Entity[]): void {
  const s = ctx.selection;
  if (m === 'replace') s.set(entities);
  else if (m === 'add') s.add(entities);
  else if (m === 'toggle') s.toggle(entities);
  else s.remove(entities);
}

/** Double-click: a face with its edges, or an edge with its faces. */
function neighbours(mesh: Mesh, entity: Entity): Entity[] {
  if ('outer' in entity) return [entity, ...mesh.faceEdges(entity)];
  return [entity, ...entity.faces];
}

/**
 * Triple-click: everything connected to the entity, through shared vertices or
 * through faces (a face links its outline to the loops of its holes).
 */
export function connected(mesh: Mesh, entity: Entity): Entity[] {
  const edges = new Set<Edge>();
  const faces = new Set<Face>();
  const stack = 'outer' in entity ? mesh.faceEdges(entity) : [entity];
  while (stack.length > 0) {
    const e = stack.pop()!;
    if (edges.has(e)) continue;
    edges.add(e);
    for (const f of e.faces) {
      if (faces.has(f)) continue;
      faces.add(f);
      for (const fe of mesh.faceEdges(f)) if (!edges.has(fe)) stack.push(fe);
    }
    for (const v of [e.v0, e.v1]) for (const n of v.edges) if (!edges.has(n)) stack.push(n);
  }
  return [...faces, ...edges];
}

type P = { x: number; y: number };
type R = { x0: number; y0: number; x1: number; y1: number };

function inRect(p: P, r: R): boolean {
  return p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
}

function segmentTouchesRect(a: P, b: P, r: R): boolean {
  if (inRect(a, r) || inRect(b, r)) return true;
  const corners: P[] = [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
  return corners.some((c, i) => segmentsCross(a, b, c, corners[(i + 1) % 4]!));
}

function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const cross = (o: P, p: P, q: P) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function pointInPoly(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
