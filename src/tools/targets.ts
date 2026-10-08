import type { Transform } from '../core/affine';
import { copyInstance } from '../core/groups';
import type { Edge, Face, Instance, Mesh } from '../core/Mesh';
import type { Model } from '../core/Model';
import { copyGeometry, transformVertices, verticesOf } from '../core/transform';
import type { ToolContext, ToolPointerEvent } from './Tool';

/** What a Move/Rotate/Scale acts on, by id so it survives live previews. */
export interface Targets {
  faceIds: number[];
  edgeIds: number[];
  instanceIds: number[];
}

/** The selection, or (if nothing is selected) the edge, face or group under the cursor. */
export function targetsAt(ctx: ToolContext, e: ToolPointerEvent): Targets | null {
  const s = ctx.selection;
  if (!s.isEmpty) return { faceIds: s.faces.map((f) => f.id), edgeIds: s.edges.map((x) => x.id), instanceIds: s.instances.map((i) => i.id) };
  const hit = ctx.inference.pick({ x: e.x, y: e.y, ray: ctx.viewport.ray(e.ndc) });
  if (hit?.face) return { faceIds: [hit.face.id], edgeIds: [], instanceIds: [] };
  if (hit?.edge) return { faceIds: [], edgeIds: [hit.edge.id], instanceIds: [] };
  if (hit?.instance !== undefined) return { faceIds: [], edgeIds: [], instanceIds: [hit.instance] };
  return null;
}

export function resolveTargets(mesh: Mesh, t: Targets): { faces: Face[]; edges: Edge[]; instances: Instance[] } {
  return {
    faces: t.faceIds.map((id) => mesh.faces.get(id)).filter((f): f is Face => !!f),
    edges: t.edgeIds.map((id) => mesh.edges.get(id)).filter((e): e is Edge => !!e),
    instances: t.instanceIds.map((id) => mesh.instances.get(id)).filter((i): i is Instance => !!i),
  };
}

/**
 * Moves (or copies) targets through a transform: geometry vertex by vertex (so
 * connected geometry stretches), groups/components by changing their placement.
 */
export function transformTargets(model: Model, mesh: Mesh, targets: Targets, t: Transform, copy: boolean): void {
  const { faces, edges, instances } = resolveTargets(mesh, targets);
  const map = (p: Parameters<Transform['apply']>[0]) => t.apply(p);
  if (copy) {
    if (faces.length || edges.length) copyGeometry(mesh, faces, edges, map);
    for (const inst of instances) copyInstance(model, mesh, inst, t);
  } else {
    if (faces.length || edges.length) transformVertices(mesh, verticesOf(faces, edges), map);
    for (const inst of instances) inst.transform = t.multiply(inst.transform);
  }
}

/** Highlights what the tool would act on when nothing is selected. */
export function hoverTarget(ctx: ToolContext, e: ToolPointerEvent): void {
  if (!ctx.selection.isEmpty) {
    ctx.highlight();
    return;
  }
  const hit = ctx.inference.pick({ x: e.x, y: e.y, ray: ctx.viewport.ray(e.ndc) });
  const inst = hit?.instance !== undefined ? ctx.model.active.instances.get(hit.instance) : undefined;
  ctx.highlight(hit?.face ? [hit.face] : [], hit?.edge ? [hit.edge] : [], inst ? [inst] : []);
}
