import type { Edge, Face, Mesh } from '../core/Mesh';
import type { ToolContext, ToolPointerEvent } from './Tool';

/** What a Move/Rotate acts on, by id so it survives live previews. */
export interface Targets {
  faceIds: number[];
  edgeIds: number[];
}

/** The selection, or (if nothing is selected) the edge or face under the cursor. */
export function targetsAt(ctx: ToolContext, e: ToolPointerEvent): Targets | null {
  if (!ctx.selection.isEmpty) {
    return { faceIds: ctx.selection.faces.map((f) => f.id), edgeIds: ctx.selection.edges.map((x) => x.id) };
  }
  const hit = ctx.inference.pick({ x: e.x, y: e.y, ray: ctx.viewport.ray(e.ndc) });
  if (hit?.face) return { faceIds: [hit.face.id], edgeIds: [] };
  if (hit?.edge) return { faceIds: [], edgeIds: [hit.edge.id] };
  return null;
}

export function resolveTargets(mesh: Mesh, t: Targets): { faces: Face[]; edges: Edge[] } {
  return {
    faces: t.faceIds.map((id) => mesh.faces.get(id)).filter((f): f is Face => !!f),
    edges: t.edgeIds.map((id) => mesh.edges.get(id)).filter((e): e is Edge => !!e),
  };
}

/** Highlights what the tool would act on when nothing is selected. */
export function hoverTarget(ctx: ToolContext, e: ToolPointerEvent): void {
  if (!ctx.selection.isEmpty) {
    ctx.highlight();
    return;
  }
  const hit = ctx.inference.pick({ x: e.x, y: e.y, ray: ctx.viewport.ray(e.ndc) });
  ctx.highlight(hit?.face ? [hit.face] : [], hit?.edge ? [hit.edge] : []);
}
