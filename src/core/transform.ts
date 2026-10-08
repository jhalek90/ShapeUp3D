import { Plane, PlaneProjector, Vec3 } from './math';
import type { CurveInfo, Edge, Face, Mesh, Vertex } from './Mesh';
import { triangulate2D } from './triangulate';

/** A point-to-point mapping used to move, rotate or copy geometry. */
export type PointMap = (p: Vec3) => Vec3;

export function translation(d: Vec3): PointMap {
  return (p) => p.add(d);
}

/** Rotation by `angle` radians about the axis through `center` (right-hand rule). */
export function rotation(center: Vec3, axis: Vec3, angle: number): PointMap {
  const k = axis.normalize();
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (p) => {
    // Rodrigues' rotation formula.
    const v = p.sub(center);
    return center.add(
      v
        .scale(cos)
        .add(k.cross(v).scale(sin))
        .add(k.scale(k.dot(v) * (1 - cos))),
    );
  };
}

/** A curve's info carried through a rigid transform. */
export function mapCurveInfo(info: CurveInfo, map: PointMap): CurveInfo {
  if (!info.center || !info.normal) return { ...info };
  const center = map(info.center);
  return { kind: info.kind, center, normal: map(info.center.add(info.normal)).sub(center).normalize(), radius: info.radius };
}

/** Scaling by per-axis factors about `anchor`. */
export function scaling(anchor: Vec3, factors: Vec3): PointMap {
  return (p) => {
    const d = p.sub(anchor);
    return anchor.add(new Vec3(d.x * factors.x, d.y * factors.y, d.z * factors.z));
  };
}

/** Keeps a curve's center/radius only if its vertices really are on a circle around it. */
function refitCurve(mesh: Mesh, id: number): void {
  const info = mesh.curves.get(id);
  if (!info?.center) return;
  const pts = new Set<Vertex>();
  for (const e of mesh.curveEdges(id)) pts.add(e.v0).add(e.v1);
  const radii = [...pts].map((v) => v.pos.distanceTo(info.center!));
  const min = Math.min(...radii);
  const max = Math.max(...radii);
  if (radii.length > 0 && max - min <= 1e-6 * Math.max(1, max)) mesh.curves.set(id, { ...info, radius: (min + max) / 2 });
  else mesh.curves.set(id, { kind: info.kind });
}

/** All vertices used by the given faces and edges. */
export function verticesOf(faces: Iterable<Face>, edges: Iterable<Edge>): Set<Vertex> {
  const out = new Set<Vertex>();
  for (const f of faces) for (const v of f.vertices) out.add(v);
  for (const e of edges) {
    out.add(e.v0);
    out.add(e.v1);
  }
  return out;
}

/**
 * Moves vertices through `map`. Connected geometry stretches to follow (as in
 * SketchUp). Vertices landing on other vertices weld to them, faces left with no
 * area are removed, and faces bent out of plane are folded into triangles.
 */
export function transformVertices(mesh: Mesh, vertices: Iterable<Vertex>, map: PointMap): void {
  const moved = [...new Set(vertices)];
  const movedSet = new Set(moved);
  const faces = new Set<Face>();
  const curves = new Set<number>();
  for (const v of moved) {
    for (const e of v.edges) {
      for (const f of e.faces) faces.add(f);
      if (e.curve) curves.add(e.curve);
    }
  }
  // A curve moved as a whole keeps its center (checked again below, since e.g. a
  // non-uniform scale turns a circle into an ellipse); one partly moved is distorted.
  const wholeCurves: number[] = [];
  for (const id of curves) {
    const info = mesh.curves.get(id);
    if (!info) continue;
    const whole = mesh.curveEdges(id).every((e) => movedSet.has(e.v0) && movedSet.has(e.v1));
    if (whole) wholeCurves.push(id);
    mesh.curves.set(id, whole ? mapCurveInfo(info, map) : { kind: info.kind });
  }

  const targets = moved.map((v) => map(v.pos));
  moved.forEach((v, i) => mesh.moveVertex(v, targets[i]!));

  for (const v of moved) {
    if (!mesh.vertices.has(v.id)) continue;
    const other = mesh.vertexAt(v.pos, v);
    if (other) mesh.weldVertex(v, other);
  }

  for (const id of wholeCurves) refitCurve(mesh, id);

  for (const f of faces) {
    if (!mesh.faces.has(f.id)) continue;
    if (!mesh.updateFaceNormal(f)) {
      mesh.removeFace(f);
      continue;
    }
    if (!mesh.isPlanar(f)) foldFace(mesh, f);
  }
}

/**
 * Replaces a non-planar face with triangles. The new fold edges are soft and smooth,
 * so the surface still reads as one piece (SketchUp does the same).
 */
export function foldFace(mesh: Mesh, f: Face): void {
  const n = f.normal;
  const all = f.vertices;
  const centroid = all.reduce((s, v) => s.add(v.pos), new Vec3()).scale(1 / all.length);
  const proj = new PlaneProjector(Plane.fromPointNormal(centroid, n));
  const [outer2, ...holes2] = f.loops.map((l) => l.map((v) => proj.to2D(v.pos)));
  const tris = triangulate2D(outer2!, holes2);
  mesh.removeFace(f);
  for (let i = 0; i < tris.length; i += 3) {
    const tri = [all[tris[i]!]!, all[tris[i + 1]!]!, all[tris[i + 2]!]!];
    const fresh = tri.map((v, j) => !mesh.edgeBetween(v, tri[(j + 1) % 3]!));
    const tn = tri[1]!.pos.sub(tri[0]!.pos).cross(tri[2]!.pos.sub(tri[0]!.pos));
    if (tn.length() < 1e-12) continue;
    mesh.addFace(tri, [], tn.dot(n) >= 0 ? tn : tn.negate());
    tri.forEach((v, j) => {
      if (!fresh[j]) return;
      const e = mesh.edgeBetween(v, tri[(j + 1) % 3]!)!;
      e.soft = true;
      e.smooth = true;
    });
  }
}

/**
 * Copies faces and edges through `map` (a rigid transform). Copies weld to
 * whatever geometry they land on, like SketchUp's loose geometry.
 */
export function copyGeometry(mesh: Mesh, faces: Iterable<Face>, edges: Iterable<Edge>, map: PointMap): void {
  const faceList = [...faces];
  const edgeSet = new Set(edges);
  for (const f of faceList) for (const e of mesh.faceEdges(f)) edgeSet.add(e);
  // Capture everything before adding geometry (copies may weld onto the originals).
  const edgeData = [...edgeSet].map((e) => ({ v0: e.v0, v1: e.v1, soft: e.soft, smooth: e.smooth, hidden: e.hidden, curve: e.curve }));
  const curveCopies = new Map<number, number>();
  const copyCurve = (id: number) => {
    if (!id) return 0;
    let c = curveCopies.get(id);
    if (c === undefined) {
      const info = mesh.curves.get(id);
      c = info ? mesh.addCurve(mapCurveInfo(info, map)) : 0;
      curveCopies.set(id, c);
    }
    return c;
  };
  const faceData = faceList.map((f) => ({ outer: [...f.outer], holes: f.holes.map((h) => [...h]), normal: f.normal, anchor: f.outer[0]!.pos }));

  const copies = new Map<Vertex, Vertex>();
  const dup = (v: Vertex) => {
    let c = copies.get(v);
    if (!c) {
      c = mesh.addVertex(map(v.pos));
      copies.set(v, c);
    }
    return c;
  };
  for (const e of edgeData) {
    const a = dup(e.v0);
    const b = dup(e.v1);
    if (a === b) continue;
    const existed = mesh.edgeBetween(a, b);
    const ne = existed ?? mesh.addEdge(a, b);
    ne.soft ||= e.soft;
    ne.smooth ||= e.smooth;
    ne.hidden ||= e.hidden;
    if (!existed) ne.curve = copyCurve(e.curve);
  }
  for (const f of faceData) {
    const normal = map(f.anchor.add(f.normal)).sub(map(f.anchor)).normalize();
    try {
      mesh.addFace(f.outer.map(dup), f.holes.map((h) => h.map(dup)), normal);
    } catch {
      // The copy collapsed (e.g. welded onto itself); skip it.
    }
  }
  for (const v of copies.values()) mesh.pruneVertex(v);
}
