import type { Transform } from './affine';
import { Mesh, type Edge, type Face, type Vertex } from './Mesh';
import type { Model } from './Model';

/**
 * Everything outside the active (edited) mesh, copied into one world-coordinate
 * mesh, so snapping and picking can see it without knowing about transforms.
 * `owner` tells which instance in the active mesh a face/edge belongs to (that's
 * what clicking it selects); geometry with no owner is outside the open group.
 */
export interface ForeignGeometry {
  mesh: Mesh;
  owner: Map<Face | Edge, number>;
}

export function buildForeignGeometry(model: Model): ForeignGeometry {
  const out = new Mesh();
  const owner = new Map<Face | Edge, number>();
  const active = model.active;
  const path = model.editPath;

  model.traverse((mesh, toWorld, instances) => {
    if (mesh === active) return;
    // Owned if it's inside one of the active mesh's instances.
    const inside = instances.length > path.length && path.every((id, i) => instances[i]!.id === id);
    const ownerId = inside ? instances[path.length]!.id : undefined;
    copyWorld(mesh, toWorld, out, (entity) => {
      if (ownerId !== undefined) owner.set(entity, ownerId);
    });
  });
  return { mesh: out, owner };
}

function copyWorld(src: Mesh, t: Transform, dst: Mesh, own: (e: Face | Edge) => void): void {
  const copies = new Map<Vertex, Vertex>();
  const dup = (v: Vertex) => {
    let c = copies.get(v);
    if (!c) {
      c = dst.addVertex(t.apply(v.pos));
      copies.set(v, c);
    }
    return c;
  };
  for (const e of src.edges.values()) {
    const a = dup(e.v0);
    const b = dup(e.v1);
    if (a === b) continue;
    const ne = dst.addEdge(a, b);
    ne.soft = e.soft;
    ne.hidden = e.hidden;
    own(ne);
  }
  for (const f of src.faces.values()) {
    try {
      const nf = dst.addFace(f.outer.map(dup), f.holes.map((h) => h.map(dup)), t.applyDir(f.normal));
      own(nf);
    } catch {
      // Degenerate after transforming (e.g. scaled flat): nothing to snap to.
    }
  }
  for (const g of src.guides.values()) {
    if (g.kind === 'line') dst.addGuideLine(t.apply(g.point), t.applyDir(g.dir));
    else dst.addGuidePoint(t.apply(g.point));
  }
  for (const [, c] of src.curves) {
    if (c.center && c.normal) dst.addCurve({ kind: c.kind, center: t.apply(c.center), normal: t.applyDir(c.normal).normalize(), radius: c.radius });
  }
  for (const v of copies.values()) dst.pruneVertex(v);
}
