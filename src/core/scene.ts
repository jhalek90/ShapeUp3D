import type { Transform } from './affine';
import { Vec3 } from './math';
import { Mesh, type Vertex } from './Mesh';
import type { Model } from './Model';

/**
 * Everything outside the active (edited) mesh, as world-coordinate meshes, so
 * snapping and picking can see it without knowing about transforms. Each part is
 * one placed mesh; `owner` is the instance in the active mesh it belongs to (what
 * clicking it selects). Parts without an owner are outside the open group.
 */
export interface ForeignPart {
  mesh: Mesh;
  owner?: number;
  /** World-space bounds, for skipping parts far from the cursor. */
  min: Vec3;
  max: Vec3;
}

export interface ForeignGeometry {
  parts: ForeignPart[];
}

/**
 * Builds ForeignGeometry, reusing parts between calls: a placed mesh is copied to
 * world space once and kept while the model's epoch is unchanged (only the active
 * mesh changes within an epoch). Meshes placed without any transform are used
 * directly, with no copy.
 */
export class ForeignCache {
  private epoch = -1;
  private parts = new Map<string, ForeignPart>();
  private readonly meshIds = new WeakMap<Mesh, number>();
  private nextMeshId = 1;

  build(model: Model): ForeignGeometry {
    if (model.epoch !== this.epoch) {
      this.parts.clear();
      this.epoch = model.epoch;
    }
    const active = model.active;
    const path = model.editPath;
    const used = new Map<string, ForeignPart>();
    model.traverse((mesh, toWorld, instances) => {
      if (mesh === active) return;
      const inside = instances.length > path.length && path.every((id, i) => instances[i]!.id === id);
      const owner = inside ? instances[path.length]!.id : undefined;
      const key = `${this.meshId(mesh)}|${owner ?? ''}|${toWorld.toArray().join(',')}`;
      let part = this.parts.get(key);
      if (!part) {
        const world = toWorld.isIdentity() ? mesh : copyWorld(mesh, toWorld);
        part = { mesh: world, owner, ...bounds(world) };
      }
      used.set(key, part);
    });
    this.parts = used;
    return { parts: [...used.values()] };
  }

  private meshId(mesh: Mesh): number {
    let id = this.meshIds.get(mesh);
    if (id === undefined) {
      id = this.nextMeshId++;
      this.meshIds.set(mesh, id);
    }
    return id;
  }
}

/** One-off build without caching (tests and simple callers). */
export function buildForeignGeometry(model: Model): ForeignGeometry {
  return new ForeignCache().build(model);
}

function bounds(mesh: Mesh): { min: Vec3; max: Vec3 } {
  let min = new Vec3(Infinity, Infinity, Infinity);
  let max = new Vec3(-Infinity, -Infinity, -Infinity);
  const grow = (p: Vec3) => {
    min = new Vec3(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
    max = new Vec3(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
  };
  for (const v of mesh.vertices.values()) grow(v.pos);
  for (const c of mesh.curves.values()) if (c.center) grow(c.center);
  for (const g of mesh.guides.values()) if (g.kind === 'point') grow(g.point);
  return { min, max };
}

function copyWorld(src: Mesh, t: Transform): Mesh {
  const dst = new Mesh();
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
  }
  for (const f of src.faces.values()) {
    try {
      dst.addFace(f.outer.map(dup), f.holes.map((h) => h.map(dup)), t.applyDir(f.normal));
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
  return dst;
}
