import { Plane, PlaneProjector, pointInPolygon2D, TOL, type Vec3 } from './math';
import { faceContainsPoint, isSmoothCurve, type Edge, type Face, type Mesh, type Vertex } from './Mesh';
import { edgesOnSegments, eraseEdges, insertSegment, rebuildPlane, type CoverShape } from './ops';
import { mapCurveInfo, transformVertices, translation } from './transform';
import { interiorPoint2D } from './triangulate';

// Push/Pull, following SketchUp's behaviour:
//
// - If every outline edge of the face can slide along a neighbouring face (the top of
//   a box), the face just moves and its neighbours stretch.
// - Otherwise the face is extruded: a cap at the new position plus a side face per
//   outline segment.
//   * A free-standing face stays behind as the base (pull a rectangle into a box).
//   * A face attached to other geometry is consumed (it's moved, not copied), unless
//     `keepBase` (Ctrl in SketchUp) asks to keep it.
//   * Pushing an attached face backwards carves into the solid behind it, so the new
//     faces face into the void (pockets).
//   * A side face lying in the plane of a neighbouring face either merges with it
//     (extending it) or, if it lies over it, cuts that part away (notches).
//   * If the cap lands on a face facing the other way (pushing a pocket down to the
//     far side of the solid), that area is cut out of both: a hole through.
//
// Afterwards `tidy` makes the result clean: vertices that landed on edges are joined
// into them, faces of the planes involved are re-derived (so a face cut in two by a
// slot becomes two faces), and edges left bounding nothing are removed.

export interface PushPullOptions {
  /** Keep the original face and extrude a new one from it (Ctrl). */
  keepBase?: boolean;
}

/**
 * Pushes or pulls a face by `distance` along its normal (negative = against it).
 * Returns false if nothing was done (zero distance, or the move would collapse geometry).
 */
export function pushPull(mesh: Mesh, face: Face, distance: number, opts: PushPullOptions = {}): boolean {
  if (Math.abs(distance) <= TOL || !mesh.faces.has(face.id)) return false;
  const before = snapshotEdges(mesh);
  const n = face.normal;
  const D = n.scale(distance);
  const dir = distance > 0 ? n : n.negate();
  const outline = mesh.faceEdges(face);
  const others = (e: Edge) => [...e.faces].filter((g) => g !== face);

  const slides = outline.every((e) => others(e).some((g) => Math.abs(g.normal.dot(n)) < 1e-6));
  if (slides && !opts.keepBase) {
    if (wouldCollapse(face, dir, Math.abs(distance))) return false;
    const moved = face.vertices;
    transformVertices(mesh, moved, (p) => p.add(D));
    // Deepening a pocket down onto the far side of the solid punches through.
    if (mesh.faces.has(face.id)) {
      const shape: CoverShape = { normal: face.normal, outer: face.outer.map((v) => v.pos), holes: face.holes.map((h) => h.map((v) => v.pos)) };
      const plane = face.plane;
      if (landsOnOpposingFace(mesh, face, plane, shape)) {
        mesh.removeFace(face);
        rebuildPlane(mesh, plane, { cuts: [shape] });
      }
    }
    tidy(mesh, moved, before);
    return true;
  }

  const free = outline.every((e) => others(e).length === 0);
  const keepBase = !!opts.keepBase || free;
  const flip = !free && distance < 0 ? -1 : 1;
  const loops = face.loops.map((l) => l.map((v) => v.pos));
  // Curve of each outline segment (segment i runs from vertex i to i+1).
  const segmentCurves = face.loops.map((l) => l.map((v, i) => mesh.edgeBetween(v, l[(i + 1) % l.length]!)?.curve ?? 0));

  // Shapes of the new faces, grouped by plane.
  const groups: { plane: Plane; covers: CoverShape[]; cuts: CoverShape[] }[] = [];
  const group = (plane: Plane) => {
    let g = groups.find((x) => x.plane.coincides(plane));
    if (!g) groups.push((g = { plane, covers: [], cuts: [] }));
    return g;
  };

  const capNormal = dir.scale(flip);
  const capLoops = loops.map((l) => l.map((p) => p.add(D)));
  const capPlane = Plane.fromPointNormal(capLoops[0]![0]!, capNormal);
  const cap: CoverShape = { normal: capNormal, outer: capLoops[0]!, holes: capLoops.slice(1) };
  const punches = landsOnOpposingFace(mesh, face, capPlane, cap);
  (punches ? group(capPlane).cuts : group(capPlane).covers).push(cap);

  const baseSegments: [Vec3, Vec3][] = [];
  const sideSign = (distance < 0 ? 1 : -1) * flip;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      baseSegments.push([a, b]);
      const normal = dir.cross(b.sub(a).normalize()).scale(sideSign);
      const shape: CoverShape = { normal, outer: [a, b, b.add(D), a.add(D)], holes: [] };
      const plane = Plane.fromPointNormal(a, normal);
      // A neighbouring face in this plane that the side face would lie on top of gets cut instead.
      const overlaps = neighboursInPlane(face, a, b, plane).some((g) => interiorSide(g, a, b).dot(dir) > 0);
      (overlaps ? group(plane).cuts : group(plane).covers).push(shape);
    }
  }

  if (!keepBase) mesh.removeFace(face);
  else if (free && distance > 0) mesh.reverseFace(face); // the base now faces out of the new solid

  const created: Edge[] = [];
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      created.push(...insertSegment(mesh, a.add(D), b.add(D)), ...insertSegment(mesh, a, a.add(D)));
    }
  }
  for (const g of groups) rebuildPlane(mesh, g.plane, { covers: g.covers, cuts: g.cuts });

  // Curves: the cap's copy of a curve is a curve too, and the side edges between
  // segments of a circle or arc are softened so the extrusion reads as one smooth surface.
  const capCurves = new Map<number, number>();
  loops.forEach((loop, li) => {
    const curves = segmentCurves[li]!;
    for (let i = 0; i < loop.length; i++) {
      const c = curves[i]!;
      if (c) {
        let capCurve = capCurves.get(c);
        if (capCurve === undefined) {
          const info = mesh.curves.get(c);
          capCurve = mesh.addCurve(info ? mapCurveInfo(info, translation(D)) : { kind: 'arc' });
          capCurves.set(c, capCurve);
        }
        for (const e of edgesOnSegments(mesh, [[loop[i]!.add(D), loop[(i + 1) % loop.length]!.add(D)]])) e.curve = capCurve;
      }
      const before = curves[(i - 1 + loop.length) % loop.length]!;
      if (c && c === before && isSmoothCurve(mesh.curves.get(c)?.kind)) {
        for (const e of edgesOnSegments(mesh, [[loop[i]!, loop[i]!.add(D)]])) {
          e.soft = true;
          e.smooth = true;
        }
      }
    }
  });

  // Tidy up: edges of this operation left bounding nothing go away (e.g. the cut-off
  // part of a box corner in a notch), and coplanar faces that now meet edge-to-edge merge.
  const baseEdges = [...mesh.edges.values()].filter((e) => baseSegments.some(([a, b]) => onSegment(e, a, b)));
  for (const e of [...baseEdges, ...created]) if (mesh.edges.has(e.id) && e.faces.size === 0) mesh.removeEdge(e);
  const mergeable = [...baseEdges, ...created].filter((e) => mesh.edges.has(e.id) && isMergeable(e));
  eraseEdges(mesh, mergeable);
  const involved = loops.flatMap((l) => l.flatMap((p) => [mesh.vertexAt(p), mesh.vertexAt(p.add(D))]));
  tidy(mesh, involved.filter((x): x is Vertex => !!x), before);
  return true;
}

interface EdgeSnapshot {
  ids: Set<number>;
  withFaces: Set<number>;
}

function snapshotEdges(mesh: Mesh): EdgeSnapshot {
  const ids = new Set<number>();
  const withFaces = new Set<number>();
  for (const e of mesh.edges.values()) {
    ids.add(e.id);
    if (e.faces.size > 0) withFaces.add(e.id);
  }
  return { ids, withFaces };
}

/**
 * Cleans up after a push/pull around the vertices it moved or created:
 * 1. a vertex lying on another edge is joined into it (no T-junctions);
 * 2. faces of every plane touching those vertices are re-derived, so a face that
 *    now runs around both sides of a slot becomes the separate faces it should be;
 * 3. edges that used to bound faces (or are new) but now bound nothing are removed
 *    (the "leftover lines"), and the vertices they leave behind are healed.
 */
function tidy(mesh: Mesh, vertices: Iterable<Vertex>, before: EdgeSnapshot): void {
  const verts = [...new Set(vertices)].filter((v) => mesh.vertices.has(v.id));

  for (const v of verts) {
    for (const e of [...mesh.edges.values()]) {
      if (!mesh.edges.has(e.id) || e.has(v)) continue;
      const ab = e.v1.pos.sub(e.v0.pos);
      const t = v.pos.sub(e.v0.pos).dot(ab) / ab.lengthSq();
      if (t <= 0 || t >= 1) continue;
      if (e.v0.pos.lerp(e.v1.pos, t).distanceTo(v.pos) > TOL) continue;
      if (v.pos.distanceTo(e.v0.pos) <= TOL || v.pos.distanceTo(e.v1.pos) <= TOL) continue;
      mesh.splitEdge(e, v);
    }
  }

  const planes: Plane[] = [];
  for (const v of verts) {
    if (!mesh.vertices.has(v.id)) continue;
    for (const e of v.edges) {
      for (const f of e.faces) {
        const p = f.plane;
        if (!planes.some((x) => x.coincides(p))) planes.push(p);
      }
    }
  }
  for (const p of planes) rebuildPlane(mesh, p);

  const ends = new Set<Vertex>();
  for (const e of [...mesh.edges.values()]) {
    if (e.faces.size > 0) continue;
    if (before.ids.has(e.id) && !before.withFaces.has(e.id)) continue; // a loose line the user drew
    ends.add(e.v0);
    ends.add(e.v1);
    mesh.removeEdge(e);
  }
  for (const v of ends) if (mesh.vertices.has(v.id)) mesh.healVertex(v);
}

/**
 * Push/pull distances at which the face would land exactly in the plane of another
 * face lying in line with it (parallel, and overlapping when seen along the normal),
 * e.g. the bottom of a block when pushing a pocket down. Sorted, without duplicates.
 * `through` is a point on the face (where it was clicked).
 */
export function alignedFaceDistances(mesh: Mesh, face: Face, through: Vec3): number[] {
  const n = face.normal;
  const proj = new PlaneProjector(face.plane);
  const samples = [
    through,
    proj.to3D(interiorPoint2D(face.outer.map((v) => proj.to2D(v.pos)), face.holes.map((h) => h.map((v) => proj.to2D(v.pos))))),
  ];
  const out: number[] = [];
  for (const g of mesh.faces.values()) {
    if (g === face || Math.abs(g.normal.dot(n)) < 1 - 1e-9) continue;
    const d = g.outer[0]!.pos.sub(through).dot(n);
    if (Math.abs(d) <= TOL || out.some((x) => Math.abs(x - d) <= TOL)) continue;
    if (samples.some((p) => faceContainsPoint(g, p.addScaled(n, d)))) out.push(d);
  }
  return out.sort((a, b) => a - b);
}

/** True if the cap lies on an existing face in its plane that faces the opposite way. */
function landsOnOpposingFace(mesh: Mesh, face: Face, plane: Plane, cap: CoverShape): boolean {
  const proj = new PlaneProjector(plane);
  const to2D = (loop: readonly Vec3[]) => loop.map((p) => proj.to2D(p));
  const sample = interiorPoint2D(to2D(cap.outer), cap.holes.map(to2D));
  for (const g of mesh.faces.values()) {
    if (g === face || !g.plane.coincides(plane) || g.normal.dot(cap.normal) >= 0) continue;
    const outer = to2D(g.outer.map((v) => v.pos));
    const holes = g.holes.map((h) => to2D(h.map((v) => v.pos)));
    if (pointInPolygon2D(sample, outer) && !holes.some((h) => pointInPolygon2D(sample, h))) return true;
  }
  return false;
}

/** True if moving the face would shrink an attached edge to nothing or past it. */
function wouldCollapse(face: Face, dir: Vec3, distance: number): boolean {
  const own = new Set(face.vertices);
  for (const v of own) {
    for (const e of v.edges) {
      const w = e.other(v);
      if (own.has(w)) continue;
      const along = w.pos.sub(v.pos).dot(dir);
      if (along > TOL && distance >= along - TOL) return true;
    }
  }
  return false;
}

/** Faces other than `face`, in `plane`, using an edge along segment a–b. */
function neighboursInPlane(face: Face, a: Vec3, b: Vec3, plane: Plane): Face[] {
  const out = new Set<Face>();
  for (const v of face.vertices) {
    for (const e of v.edges) {
      if (!onSegment(e, a, b)) continue;
      for (const g of e.faces) if (g !== face && g.plane.coincides(plane)) out.add(g);
    }
  }
  return [...out];
}

/** Unit vector from segment a–b into the interior of face g (which has an edge along it). */
function interiorSide(g: Face, a: Vec3, b: Vec3): Vec3 {
  // Direction g's loop runs along the segment; the interior is on its left.
  for (const loop of g.loops) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i]!.pos;
      const q = loop[(i + 1) % loop.length]!.pos;
      if (pointOnSegment(p, a, b) && pointOnSegment(q, a, b)) return g.normal.cross(q.sub(p).normalize());
    }
  }
  return g.normal.cross(b.sub(a).normalize());
}

function pointOnSegment(p: Vec3, a: Vec3, b: Vec3): boolean {
  const ab = b.sub(a);
  const len2 = ab.lengthSq();
  const t = p.sub(a).dot(ab) / len2;
  return t >= -1e-9 && t <= 1 + 1e-9 && a.addScaled(ab, t).distanceTo(p) <= TOL;
}

function onSegment(e: Edge, a: Vec3, b: Vec3): boolean {
  return pointOnSegment(e.v0.pos, a, b) && pointOnSegment(e.v1.pos, a, b);
}

/** Two coplanar faces facing the same way meet along this edge. */
function isMergeable(e: Edge): boolean {
  const [f, g, ...rest] = [...e.faces];
  return !!f && !!g && rest.length === 0 && f.plane.coincides(g.plane) && f.normal.dot(g.normal) > 0;
}
