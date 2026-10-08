import {
  closestSegmentSegment,
  distanceToLine,
  Plane,
  PlaneProjector,
  pointInPolygon2D,
  TOL,
  Vec3,
  type Vec2,
  type XYZ,
} from './math';
import type { Edge, Face, Mesh, Vertex } from './Mesh';
import { findRegions } from './planar';
import { interiorPoint2D } from './triangulate';

// SketchUp-style modeling operations on a Mesh.
//
// Faces are maintained per plane: after edges change, every plane they could
// bound a face in is "rebuilt" — the enclosed regions of all edges in that plane
// are found (planar.ts) and reconciled with the faces already there:
//   - a region identical to an existing face keeps that face untouched;
//   - a region inside an existing face (because new edges split it) replaces it,
//     inheriting its orientation;
//   - an empty region becomes a new face only if one of the newly drawn edges is on
//     its outline — so closing a loop makes a face, but drawing near a hole the user
//     deliberately left open doesn't refill it.

export interface DrawOptions {
  /** Which way new faces should face when nothing else decides (usually toward the camera). */
  facing?: Vec3;
}

export interface DrawResult {
  /** Edges now covering the drawn segments. */
  edges: Edge[];
  /** True if any face was created, split or replaced. */
  facesChanged: boolean;
}

/** Draws line segments, then updates faces. */
export function drawSegments(mesh: Mesh, segments: readonly (readonly [XYZ, XYZ])[], opts: DrawOptions = {}): DrawResult {
  const facesBefore = new Set(mesh.faces.values());
  const welded: [Vec3, Vec3][] = [];
  for (const [p, q] of segments) {
    const edges = insertSegment(mesh, p, q);
    if (edges.length > 0) welded.push([edges[0]!.v0.pos, edges[edges.length - 1]!.v1.pos]);
  }
  // Later segments may have split earlier ones, so look the edges up again.
  const edges = edgesOnSegments(mesh, welded);
  updateFaces(mesh, edges, opts);
  const facesChanged = mesh.faces.size !== facesBefore.size || [...mesh.faces.values()].some((f) => !facesBefore.has(f));
  return { edges, facesChanged };
}

/** Draws a connected chain of segments through `points` (closed adds the last→first segment). */
export function drawPolyline(mesh: Mesh, points: readonly XYZ[], closed: boolean, opts: DrawOptions = {}): DrawResult {
  const segments: [XYZ, XYZ][] = [];
  for (let i = 0; i + 1 < points.length; i++) segments.push([points[i]!, points[i + 1]!]);
  if (closed && points.length > 2) segments.push([points[points.length - 1]!, points[0]!]);
  return drawSegments(mesh, segments, opts);
}

/**
 * Inserts the segment p→q: endpoints weld to nearby vertices, the segment is split
 * wherever it passes through existing vertices or crosses existing edges (which are
 * split too), and overlaps with collinear edges reuse them. Doesn't touch faces.
 * Returns the edges covering the segment, in order from p to q.
 */
export function insertSegment(mesh: Mesh, p: XYZ, q: XYZ): Edge[] {
  const a = mesh.addVertex(p);
  const b = mesh.addVertex(q);
  if (a === b) {
    mesh.pruneVertex(a);
    return [];
  }
  const A = a.pos;
  const B = b.pos;
  const len = A.distanceTo(B);
  const dir = B.sub(A).scale(1 / len);

  /** Vertices along the new segment and their distance from A. */
  const along = new Map<Vertex, number>([
    [a, 0],
    [b, len],
  ]);
  const splits = new Map<Edge, Set<Vertex>>();
  const splitAt = (e: Edge, v: Vertex) => {
    if (e.has(v)) return;
    (splits.get(e) ?? splits.set(e, new Set()).get(e)!).add(v);
  };

  for (const e of [...mesh.edges.values()]) {
    const P0 = e.v0.pos;
    const P1 = e.v1.pos;
    const c = closestSegmentSegment(A, B, P0, P1);
    if (c.distance > TOL) continue;

    if (distanceToLine(P0, A, dir) <= TOL && distanceToLine(P1, A, dir) <= TOL) {
      // Collinear overlap: each segment is split at the other's endpoints that fall inside it.
      for (const w of [e.v0, e.v1]) {
        const t = w.pos.sub(A).dot(dir);
        if (w !== a && w !== b && t > TOL && t < len - TOL) along.set(w, t);
      }
      const eLen = e.length;
      const eDir = P1.sub(P0).scale(1 / eLen);
      for (const w of [a, b]) {
        const s = w.pos.sub(P0).dot(eDir);
        if (s > TOL && s < eLen - TOL) splitAt(e, w);
      }
      continue;
    }

    // Crossing or touching at one point. Put the vertex on the existing edge so it stays straight.
    const X = c.q;
    const v =
      X.distanceTo(A) <= TOL ? a
      : X.distanceTo(B) <= TOL ? b
      : X.distanceTo(P0) <= TOL ? e.v0
      : X.distanceTo(P1) <= TOL ? e.v1
      : mesh.addVertex(X); // prettier-ignore
    splitAt(e, v);
    if (v !== a && v !== b) along.set(v, v.pos.sub(A).dot(dir));
  }

  for (const [e, verts] of splits) splitEdgeAt(mesh, e, [...verts]);

  const chain = [...along].sort((x, y) => x[1] - y[1]).map(([v]) => v);
  const out: Edge[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    if (chain[i] !== chain[i + 1]) out.push(mesh.addEdge(chain[i]!, chain[i + 1]!));
  }
  return out;
}

/** Splits an edge at several vertices lying on it. */
function splitEdgeAt(mesh: Mesh, e: Edge, verts: Vertex[]): void {
  const start = e.v0.pos;
  verts.sort((x, y) => x.pos.distanceTo(start) - y.pos.distanceTo(start));
  let current = e;
  for (const v of verts) {
    if (current.has(v)) continue;
    current = mesh.splitEdge(current, v)[1];
  }
}

/** All edges lying along any of the given segments. */
function edgesOnSegments(mesh: Mesh, segments: [Vec3, Vec3][]): Edge[] {
  const out: Edge[] = [];
  for (const e of mesh.edges.values()) {
    for (const [a, b] of segments) {
      const dir = b.sub(a);
      const len = dir.length();
      const onSeg = (p: Vec3) => {
        const t = p.sub(a).dot(dir) / (len * len);
        return t >= -TOL / len && t <= 1 + TOL / len && distanceToLine(p, a, dir) <= TOL;
      };
      if (onSeg(e.v0.pos) && onSeg(e.v1.pos)) {
        out.push(e);
        break;
      }
    }
  }
  return out;
}

// ---- Faces -------------------------------------------------------------------

/** A polygon in a plane: a face outline captured before removal, or a face to be. */
export interface CoverShape {
  normal: Vec3;
  outer: Vec3[];
  holes: Vec3[][];
}

/** Updates faces in every plane the given edges could bound a face in. */
export function updateFaces(mesh: Mesh, edges: readonly Edge[], opts: DrawOptions = {}): void {
  const touched = new Set(edges);
  for (const plane of candidatePlanes(edges)) rebuildPlane(mesh, plane, { touched, opts });
}

/**
 * Planes an edge could share a face in: those spanned by the edge and each
 * non-collinear edge connected to it (following straight continuations).
 */
function candidatePlanes(edges: readonly Edge[]): Plane[] {
  const planes: Plane[] = [];
  const add = (plane: Plane) => {
    if (!planes.some((p) => p.coincides(plane))) planes.push(plane);
  };
  for (const e of edges) {
    const dir = e.direction;
    for (const start of [e.v0, e.v1]) {
      const seen = new Set<Edge>([e]);
      const stack = [start];
      while (stack.length > 0) {
        const v = stack.pop()!;
        for (const f of v.edges) {
          if (seen.has(f)) continue;
          seen.add(f);
          const n = dir.cross(f.direction);
          if (n.length() < 1e-6) stack.push(f.other(v)); // straight continuation: keep walking
          else add(Plane.fromPointNormal(e.v0.pos, n));
        }
      }
    }
  }
  return planes;
}

export interface RebuildOptions {
  /** Newly drawn edges: an empty region outlined by one of these becomes a face. */
  touched?: Set<Edge>;
  opts?: DrawOptions;
  /** Extra shapes that make regions inside them faces (with the shape's normal). */
  covers?: CoverShape[];
  /** Shapes whose regions must have no face, overriding everything else. */
  cuts?: CoverShape[];
}

/**
 * Re-derives the faces of one plane from its edges (see the comment at the top).
 * Existing faces in the plane take priority over `covers`; `cuts` override both.
 */
export function rebuildPlane(mesh: Mesh, plane: Plane, options: RebuildOptions = {}): void {
  const { touched = new Set<Edge>(), opts = {}, covers: extraCovers = [], cuts: cutShapes = [] } = options;
  const proj = new PlaneProjector(plane);
  const edges = mesh.edgesInPlane(plane);

  const faces = new Set<Face>();
  for (const e of edges) for (const f of e.faces) if (f.plane.coincides(plane)) faces.add(f);

  const pts = new Map<number, Vec2>();
  for (const e of edges) {
    pts.set(e.v0.id, proj.to2D(e.v0.pos));
    pts.set(e.v1.id, proj.to2D(e.v1.pos));
  }
  const regions = edges.length >= 3 ? findRegions(pts, edges.map((e) => [e.v0.id, e.v1.id] as const)) : [];

  const to2D = (loop: readonly XYZ[]) => loop.map((p) => proj.to2D(p));
  const covers = [
    ...[...faces].map((f) => ({ normal: f.normal, outer: to2D(f.outer.map((v) => v.pos)), holes: f.holes.map((h) => to2D(h.map((v) => v.pos))) })),
    ...extraCovers.map((s) => ({ normal: s.normal, outer: to2D(s.outer), holes: s.holes.map(to2D) })),
  ];
  const cuts = cutShapes.map((s) => ({ outer: to2D(s.outer), holes: s.holes.map(to2D) }));
  const inside = (p: Vec2, c: { outer: Vec2[]; holes: Vec2[][] }) =>
    pointInPolygon2D(p, c.outer) && !c.holes.some((h) => pointInPolygon2D(p, h));

  const vert = (id: number) => mesh.vertices.get(id)!;
  const byBoundary = new Map<string, Face>();
  for (const f of faces) byBoundary.set(boundaryKey(mesh.faceEdges(f)), f);
  const keep = new Set<Face>();
  const create: { outer: Vertex[]; holes: Vertex[][]; normal: Vec3 }[] = [];

  for (const r of regions) {
    const outer = r.outer.map(vert);
    const holes = r.holes.map((h) => h.map(vert));
    const sample = interiorPoint2D(
      r.outer.map((id) => pts.get(id)!),
      r.holes.map((h) => h.map((id) => pts.get(id)!)),
    );
    if (cuts.some((c) => inside(sample, c))) continue;
    const same = byBoundary.get(boundaryKey([outer, ...holes].flatMap((l) => loopEdges(mesh, l))));
    if (same) {
      keep.add(same);
      continue;
    }
    const cover = covers.find((c) => inside(sample, c));
    if (cover) {
      create.push({ outer, holes, normal: cover.normal });
    } else if (loopEdges(mesh, outer).some((e) => touched.has(e))) {
      create.push({ outer, holes, normal: chooseNormal(mesh, plane, outer, opts) });
    }
  }

  for (const f of faces) if (!keep.has(f)) mesh.removeFace(f);
  for (const c of create) mesh.addFace(c.outer, c.holes, c.normal);
}

function loopEdges(mesh: Mesh, loop: readonly Vertex[]): Edge[] {
  const out: Edge[] = [];
  for (let i = 0; i < loop.length; i++) {
    const e = mesh.edgeBetween(loop[i]!, loop[(i + 1) % loop.length]!);
    if (e) out.push(e);
  }
  return out;
}

/** Identifies a face by the set of edges bounding it. */
function boundaryKey(edges: readonly Edge[]): string {
  return edges
    .map((e) => e.id)
    .sort((a, b) => a - b)
    .join(',');
}

/**
 * Orientation for a brand-new face whose outer loop runs counter-clockwise around
 * plane.normal: agree with neighbouring faces across shared edges (so closed shells
 * face consistently), else ground faces face down (as in SketchUp, so push/pull up
 * gives an outward-facing solid), else face `opts.facing`.
 */
function chooseNormal(mesh: Mesh, plane: Plane, outer: readonly Vertex[], opts: DrawOptions): Vec3 {
  const n = plane.normal;
  let votes = 0;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i]!;
    const b = outer[(i + 1) % outer.length]!;
    const e = mesh.edgeBetween(a, b);
    if (!e) continue;
    for (const g of e.faces) {
      if (g.plane.coincides(plane)) continue;
      // A consistent neighbour runs this edge the opposite way (b→a).
      votes += loopDirection(g, a, b) === -1 ? 1 : -1;
    }
  }
  if (votes !== 0) return votes > 0 ? n : n.negate();
  if (Math.abs(n.z) > 1 - 1e-9 && plane.contains(Vec3.ZERO)) return new Vec3(0, 0, -1);
  if (opts.facing && n.dot(opts.facing) < 0) return n.negate();
  return n;
}

/** +1 if a face loop runs a→b, -1 if b→a, 0 if the face doesn't use that edge. */
function loopDirection(face: Face, a: Vertex, b: Vertex): number {
  for (const loop of face.loops) {
    for (let i = 0; i < loop.length; i++) {
      const x = loop[i]!;
      const y = loop[(i + 1) % loop.length]!;
      if (x === a && y === b) return 1;
      if (x === b && y === a) return -1;
    }
  }
  return 0;
}

// ---- Erasing -----------------------------------------------------------------

/**
 * Erases edges like SketchUp's Eraser: an edge between two coplanar faces merges
 * them; any other edge takes its faces with it. Leftover straight-through vertices
 * are healed away.
 */
export function eraseEdges(mesh: Mesh, edges: Iterable<Edge>): void {
  const ends = new Set<Vertex>();
  for (const e of edges) {
    if (!mesh.edges.has(e.id)) continue;
    ends.add(e.v0);
    ends.add(e.v1);
    const [f, g, ...rest] = [...e.faces];
    if (f && g && rest.length === 0 && f.plane.coincides(g.plane) && f.normal.dot(g.normal) > 0) {
      const plane = f.plane;
      const shapes = [f, g].map((x) => ({
        normal: x.normal,
        outer: x.outer.map((v) => v.pos),
        holes: x.holes.map((h) => h.map((v) => v.pos)),
      }));
      mesh.removeEdge(e);
      rebuildPlane(mesh, plane, { covers: shapes });
    } else {
      mesh.removeEdge(e);
    }
  }
  for (const v of ends) if (mesh.vertices.has(v.id)) mesh.healVertex(v);
}

/** Erases faces only; their edges stay. */
export function eraseFaces(mesh: Mesh, faces: Iterable<Face>): void {
  for (const f of faces) if (mesh.faces.has(f.id)) mesh.removeFace(f);
}
