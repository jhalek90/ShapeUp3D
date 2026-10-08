import { PlaneProjector, Plane, pointInPolygon2D, TOL, type Vec2, type Vec3 } from './math';
import type { Mesh, Vertex } from './Mesh';
import { findRegions } from './planar';
import type { Triangle } from './stl';
import { interiorPoint2D } from './triangulate';

// Turning a triangle soup (STL) into editable SketchUp-style geometry: duplicate
// points weld together, coplanar neighbouring triangles merge into real faces
// (a cube comes in as 6 faces, not 12 triangles), and the edges between gently
// curving facets are softened so curved surfaces read as one surface.

/** Edges between faces meeting at less than this angle are softened. */
const SOFTEN_DEGREES = 20;

export interface ImportStats {
  triangles: number;
  faces: number;
  /** Degenerate (zero-area) triangles that were skipped. */
  skipped: number;
}

export function buildFromTriangles(mesh: Mesh, triangles: readonly Triangle[], scale = 1): ImportStats {
  // 1. Weld points and drop degenerate triangles.
  const tris: { v: [Vertex, Vertex, Vertex]; n: Vec3; d: number }[] = [];
  let skipped = 0;
  for (const t of triangles) {
    const v = t.map((p) => mesh.addVertex(p.scale(scale))) as [Vertex, Vertex, Vertex];
    const nRaw = v[1].pos.sub(v[0].pos).cross(v[2].pos.sub(v[0].pos));
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2] || nRaw.length() < TOL * TOL) {
      skipped++;
      continue;
    }
    const n = nRaw.normalize();
    tris.push({ v, n, d: n.dot(v[0].pos) });
  }

  // 2. Group coplanar, consistently wound neighbours into patches (union-find).
  const parent = tris.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const byEdge = new Map<string, { tri: number; from: Vertex }[]>();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = t.v[k]!;
      const b = t.v[(k + 1) % 3]!;
      const key = a.id < b.id ? `${a.id},${b.id}` : `${b.id},${a.id}`;
      (byEdge.get(key) ?? byEdge.set(key, []).get(key)!).push({ tri: i, from: a });
    }
  });
  for (const uses of byEdge.values()) {
    if (uses.length !== 2) continue;
    const [p, q] = uses as [{ tri: number; from: Vertex }, { tri: number; from: Vertex }];
    const a = tris[p.tri]!;
    const b = tris[q.tri]!;
    // Same plane, same facing, and running the shared edge in opposite directions.
    if (p.from !== q.from && a.n.dot(b.n) > 1 - 1e-9 && Math.abs(a.d - b.d) <= TOL) parent[find(p.tri)] = find(q.tri);
  }

  // 3. Each patch becomes one face (or a few, if it's not simply connected), from its outline.
  const patches = new Map<number, number[]>();
  tris.forEach((_, i) => {
    const r = find(i);
    (patches.get(r) ?? patches.set(r, []).get(r)!).push(i);
  });
  let faces = 0;
  for (const members of patches.values()) {
    const first = tris[members[0]!]!;
    const count = new Map<string, [Vertex, Vertex]>();
    const uses = new Map<string, number>();
    for (const i of members) {
      const t = tris[i]!;
      for (let k = 0; k < 3; k++) {
        const a = t.v[k]!;
        const b = t.v[(k + 1) % 3]!;
        const key = a.id < b.id ? `${a.id},${b.id}` : `${b.id},${a.id}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
        count.set(key, [a, b]);
      }
    }
    const outline = [...uses].filter(([, n]) => n === 1).map(([key]) => count.get(key)!);
    const plane = Plane.fromPointNormal(first.v[0].pos, first.n);
    const proj = new PlaneProjector(plane);
    const pts = new Map<number, Vec2>();
    for (const [a, b] of outline) {
      pts.set(a.id, proj.to2D(a.pos));
      pts.set(b.id, proj.to2D(b.pos));
    }
    const regions = findRegions(
      pts,
      outline.map(([a, b]) => [a.id, b.id] as const),
    );
    const vert = (id: number) => mesh.vertices.get(id)!;
    // Only regions the patch's triangles actually cover (not, e.g., the hole inside a ring).
    const triangles2D = members.map((i) => tris[i]!.v.map((x) => proj.to2D(x.pos)));
    const covered = (r: (typeof regions)[number]) => {
      const p = interiorPoint2D(
        r.outer.map((id) => pts.get(id)!),
        r.holes.map((h) => h.map((id) => pts.get(id)!)),
      );
      return triangles2D.some((t) => pointInPolygon2D(p, t));
    };
    let added = 0;
    for (const r of regions.filter(covered)) {
      try {
        mesh.addFace(r.outer.map(vert), r.holes.map((h) => h.map(vert)), first.n);
        added++;
      } catch {
        // fall through to triangles below
      }
    }
    if (added === 0) {
      // Couldn't make clean outlines (odd patch): keep its triangles as they are.
      for (const i of members) {
        try {
          mesh.addFace([...tris[i]!.v], [], tris[i]!.n);
          added++;
        } catch {
          skipped++;
        }
      }
    }
    faces += added;
  }

  // 4. Points only used inside merged patches (e.g. fan centres) are no longer needed.
  for (const v of [...mesh.vertices.values()]) mesh.pruneVertex(v);
  // Straight-through outline points left by the triangulation can go too.
  for (const v of [...mesh.vertices.values()]) if (mesh.vertices.has(v.id)) mesh.healVertex(v);

  // 5. Soften edges between gently angled faces (curved surfaces).
  const cos = Math.cos((SOFTEN_DEGREES * Math.PI) / 180);
  for (const e of mesh.edges.values()) {
    if (e.faces.size !== 2) continue;
    const [f, g] = [...e.faces];
    if (f!.normal.dot(g!.normal) > cos) {
      e.soft = true;
      e.smooth = true;
    }
  }
  return { triangles: triangles.length, faces, skipped };
}
