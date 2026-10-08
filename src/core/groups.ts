import { Transform } from './affine';
import { Vec3 } from './math';
import type { Edge, Face, Instance, Mesh, Vertex } from './Mesh';
import type { DefinitionKind, Model } from './Model';
import { copyGeometry } from './transform';

// Groups and components: making them from geometry, exploding them back, copying.

/**
 * Moves the given geometry (and instances) of `mesh` into a new group or component,
 * placed where it was. Edges shared with geometry left behind are kept on both
 * sides (as in SketchUp). Returns the new instance, or null if there was nothing.
 */
export function makeGroup(
  model: Model,
  mesh: Mesh,
  faces: readonly Face[],
  edges: readonly Edge[],
  instances: readonly Instance[],
  kind: DefinitionKind,
): Instance | null {
  const faceSet = new Set(faces.filter((f) => mesh.faces.has(f.id)));
  const edgeSet = new Set(edges.filter((e) => mesh.edges.has(e.id)));
  for (const f of faceSet) for (const e of mesh.faceEdges(f)) edgeSet.add(e);
  const insts = instances.filter((i) => mesh.instances.get(i.id) === i);
  if (faceSet.size === 0 && edgeSet.size === 0 && insts.length === 0) return null;

  // The group's own origin: the low corner of what goes into it.
  const corner = lowCorner(model, [...edgeSet].flatMap((e) => [e.v0.pos, e.v1.pos]), insts);
  const toLocal = Transform.translation(corner.negate());
  const def = model.addDefinition(kind);
  copyGeometry(mesh, faceSet, edgeSet, (p) => toLocal.apply(p), def.mesh);
  for (const i of insts) {
    def.mesh.addInstance(i.definition, toLocal.multiply(i.transform));
    mesh.instances.delete(i.id);
  }

  // Remove the originals: the faces, then edges that now bound nothing.
  const ends = new Set<Vertex>();
  for (const f of faceSet) mesh.removeFace(f);
  for (const e of edgeSet) {
    if (!mesh.edges.has(e.id) || e.faces.size > 0) continue;
    ends.add(e.v0);
    ends.add(e.v1);
    mesh.removeEdge(e);
  }
  for (const v of ends) if (mesh.vertices.has(v.id)) mesh.healVertex(v);

  return mesh.addInstance(def.id, Transform.translation(corner));
}

/** Replaces an instance with a copy of its geometry (and nested instances) in place. */
export function explode(model: Model, mesh: Mesh, instance: Instance): boolean {
  const def = model.definitions.get(instance.definition);
  if (!def || mesh.instances.get(instance.id) !== instance) return false;
  const t = instance.transform;
  const src = def.mesh;
  copyGeometry(src, src.faces.values(), src.edges.values(), (p) => t.apply(p), mesh);
  for (const inner of src.instances.values()) mesh.addInstance(inner.definition, t.multiply(inner.transform));
  mesh.instances.delete(instance.id);
  return true;
}

/**
 * Copies an instance with `transform` applied on top of its placement. A component
 * copy shares the definition; a group copy gets its own (groups are unique).
 */
export function copyInstance(model: Model, mesh: Mesh, instance: Instance, transform: Transform): Instance {
  const def = model.definitions.get(instance.definition);
  let defId = instance.definition;
  if (def && def.kind === 'group') {
    const clone = model.addDefinition('group', def.name);
    clone.mesh.load(def.mesh.toJSON());
    defId = clone.id;
  }
  return mesh.addInstance(defId, transform.multiply(instance.transform));
}

/** Corner (min x, y, z) of points plus the instances' world bounds. */
function lowCorner(model: Model, points: Vec3[], instances: readonly Instance[]): Vec3 {
  const all = [...points];
  for (const i of instances) {
    const b = instanceBounds(model, i);
    if (b) all.push(b.min, b.max);
  }
  if (all.length === 0) return Vec3.ZERO;
  return new Vec3(Math.min(...all.map((p) => p.x)), Math.min(...all.map((p) => p.y)), Math.min(...all.map((p) => p.z)));
}

/** Axis-aligned bounds of an instance's geometry, in its parent mesh's coordinates. */
export function instanceBounds(model: Model, instance: Instance): { min: Vec3; max: Vec3 } | null {
  const pts: Vec3[] = [];
  const collect = (mesh: Mesh, t: Transform, depth: number) => {
    if (depth > 32) return;
    for (const v of mesh.vertices.values()) pts.push(t.apply(v.pos));
    for (const inner of mesh.instances.values()) {
      const d = model.definitions.get(inner.definition);
      if (d) collect(d.mesh, t.multiply(inner.transform).multiply(d.frame ? d.frame.inverse() : Transform.IDENTITY), depth + 1);
    }
  };
  const def = model.definitions.get(instance.definition);
  if (!def) return null;
  collect(def.mesh, instance.transform.multiply(def.frame ? def.frame.inverse() : Transform.IDENTITY), 0);
  if (pts.length === 0) return null;
  return {
    min: new Vec3(Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)), Math.min(...pts.map((p) => p.z))),
    max: new Vec3(Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y)), Math.max(...pts.map((p) => p.z))),
  };
}
