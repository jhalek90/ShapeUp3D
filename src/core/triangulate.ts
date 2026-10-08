import earcut from 'earcut';
import { PlaneProjector, type Vec2, Vec3 } from './math';
import type { Face } from './Mesh';

/**
 * Triangulates a 2D polygon with holes. Returns index triples into the
 * concatenation [...outer, ...holes[0], ...holes[1], ...].
 */
export function triangulate2D(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): number[] {
  const coords: number[] = [];
  const holeStarts: number[] = [];
  for (const p of outer) coords.push(p.x, p.y);
  for (const h of holes) {
    holeStarts.push(coords.length / 2);
    for (const p of h) coords.push(p.x, p.y);
  }
  return earcut(coords, holeStarts);
}

/** A point strictly inside a polygon with holes (centroid of its largest triangle). */
export function interiorPoint2D(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[] = []): Vec2 {
  const all = [...outer, ...holes.flat()];
  const tris = triangulate2D(outer, holes);
  let best: Vec2 | null = null;
  let bestArea = -1;
  for (let i = 0; i < tris.length; i += 3) {
    const a = all[tris[i]!]!;
    const b = all[tris[i + 1]!]!;
    const c = all[tris[i + 2]!]!;
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
    if (area > bestArea) {
      bestArea = area;
      best = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    }
  }
  if (best) return best;
  // Degenerate polygon: fall back to the vertex average.
  const n = outer.length || 1;
  return { x: outer.reduce((s, p) => s + p.x, 0) / n, y: outer.reduce((s, p) => s + p.y, 0) / n };
}

/** Triangles of a face as world-space vertex triples, wound counter-clockwise around its normal. */
export function triangulateFace(face: Face): [Vec3, Vec3, Vec3][] {
  const proj = new PlaneProjector(face.plane);
  const loops3 = face.loops.map((l) => l.map((v) => v.pos));
  const all3 = loops3.flat();
  const [outer2, ...holes2] = loops3.map((l) => l.map((p) => proj.to2D(p)));
  const tris = triangulate2D(outer2!, holes2);
  const out: [Vec3, Vec3, Vec3][] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = all3[tris[i]!]!;
    const b = all3[tris[i + 1]!]!;
    const c = all3[tris[i + 2]!]!;
    const n = b.sub(a).cross(c.sub(a));
    out.push(n.dot(face.normal) >= 0 ? [a, b, c] : [a, c, b]);
  }
  return out;
}
