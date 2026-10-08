import { Plane, PlaneProjector, pointInPolygon2D, TOL, type Vec3 } from './math';
import type { Edge, Face, Mesh } from './Mesh';
import { eraseEdges, insertSegment, rebuildPlane, type CoverShape } from './ops';
import { transformVertices } from './transform';
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
  const n = face.normal;
  const D = n.scale(distance);
  const dir = distance > 0 ? n : n.negate();
  const outline = mesh.faceEdges(face);
  const others = (e: Edge) => [...e.faces].filter((g) => g !== face);

  const slides = outline.every((e) => others(e).some((g) => Math.abs(g.normal.dot(n)) < 1e-6));
  if (slides && !opts.keepBase) {
    if (wouldCollapse(face, dir, Math.abs(distance))) return false;
    transformVertices(mesh, face.vertices, (p) => p.add(D));
    // Deepening a pocket down onto the far side of the solid punches through.
    if (mesh.faces.has(face.id)) {
      const shape: CoverShape = { normal: face.normal, outer: face.outer.map((v) => v.pos), holes: face.holes.map((h) => h.map((v) => v.pos)) };
      const plane = face.plane;
      if (landsOnOpposingFace(mesh, face, plane, shape)) {
        mesh.removeFace(face);
        rebuildPlane(mesh, plane, { cuts: [shape] });
      }
    }
    return true;
  }

  const free = outline.every((e) => others(e).length === 0);
  const keepBase = !!opts.keepBase || free;
  const flip = !free && distance < 0 ? -1 : 1;
  const loops = face.loops.map((l) => l.map((v) => v.pos));

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

  // Tidy up: edges of this operation left bounding nothing go away (e.g. the cut-off
  // part of a box corner in a notch), and coplanar faces that now meet edge-to-edge merge.
  const baseEdges = [...mesh.edges.values()].filter((e) => baseSegments.some(([a, b]) => onSegment(e, a, b)));
  for (const e of [...baseEdges, ...created]) if (mesh.edges.has(e.id) && e.faces.size === 0) mesh.removeEdge(e);
  const mergeable = [...baseEdges, ...created].filter((e) => mesh.edges.has(e.id) && isMergeable(e));
  eraseEdges(mesh, mergeable);
  return true;
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
