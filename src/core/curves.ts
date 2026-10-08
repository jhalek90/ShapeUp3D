import { Plane, PlaneProjector, signedArea2D, TOL, type Vec2, Vec3, type XYZ } from './math';
import type { CurveInfo, Face, Mesh } from './Mesh';
import { drawPolyline, drawSegments, edgesOnSegments, type DrawOptions, type DrawResult } from './ops';
import { rotation } from './transform';

// Circles, polygons and arcs (as SketchUp makes them: chains of straight edges that
// share a curve id), and Offset.

/**
 * Vertices of a regular polygon / circle approximation around `center` in the
 * plane with `normal`. The first vertex points along `start` (default: the
 * plane's first in-plane axis, i.e. red for flat circles).
 */
export function circlePoints(center: Vec3, normal: Vec3, radius: number, segments: number, start?: Vec3): Vec3[] {
  const n = normal.normalize();
  let u = start ? start.sub(n.scale(start.dot(n))) : Plane.fromPointNormal(center, n).basis().u;
  if (u.length() < 1e-9) u = Plane.fromPointNormal(center, n).basis().u;
  u = u.normalize();
  const v = n.cross(u);
  const pts: Vec3[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push(center.addScaled(u, Math.cos(t) * radius).addScaled(v, Math.sin(t) * radius));
  }
  return pts;
}

export interface Arc {
  center: Vec3;
  radius: number;
  /** Rotation axis: points go from start around this axis by `sweep` radians. */
  axis: Vec3;
  sweep: number;
  start: Vec3;
  end: Vec3;
}

/**
 * The arc from a to b bulging `bulge` (the sagitta) to one side, in the plane with
 * `normal`. Positive bulge is toward normal × (b − a). Null if the bulge is ~0.
 */
export function arcFromBulge(a: Vec3, b: Vec3, bulge: number, normal: Vec3): Arc | null {
  const chord = b.sub(a);
  const c = chord.length();
  if (c <= TOL || Math.abs(bulge) <= TOL) return null;
  const n = normal.sub(chord.scale(normal.dot(chord) / (c * c))).normalize();
  const side = n.cross(chord.scale(1 / c));
  const r = (c * c) / 4 / (2 * Math.abs(bulge)) + Math.abs(bulge) / 2;
  const mid = a.lerp(b, 0.5);
  const center = mid.addScaled(side, bulge - Math.sign(bulge) * r);
  const apex = mid.addScaled(side, bulge);
  const minor = 2 * Math.asin(Math.min(1, c / (2 * r)));
  const sweep = Math.abs(bulge) > r ? Math.PI * 2 - minor : minor;
  // Pick the rotation direction that passes through the apex.
  const halfway = rotation(center, n, sweep / 2)(a);
  const axis = halfway.distanceTo(apex) < halfway.distanceTo(rotation(center, n.negate(), sweep / 2)(a)) ? n : n.negate();
  return { center, radius: r, axis, sweep, start: a, end: b };
}

/** The arc around `center` from `start` turning `sweep` radians about `axis`. */
export function arcAround(center: Vec3, start: Vec3, axis: Vec3, sweep: number): Arc {
  return { center, radius: start.distanceTo(center), axis: axis.normalize(), sweep, start, end: rotation(center, axis, sweep)(start) };
}

/** segments + 1 points along an arc, ending exactly on its end point. */
export function arcPoints(arc: Arc, segments: number): Vec3[] {
  const rot = (t: number) => rotation(arc.center, arc.axis, t)(arc.start);
  const pts = [arc.start];
  for (let i = 1; i < segments; i++) pts.push(rot((arc.sweep * i) / segments));
  pts.push(arc.end);
  return pts;
}

/** Draws a chain of edges as one curve (selects and erases together). */
export function drawCurve(mesh: Mesh, points: readonly XYZ[], closed: boolean, info: CurveInfo, opts: DrawOptions = {}): DrawResult & { curve: number } {
  const result = drawPolyline(mesh, points, closed, opts);
  const curve = mesh.addCurve(info);
  for (const e of result.edges) e.curve = curve;
  return { ...result, curve };
}

// ---- Offset --------------------------------------------------------------------

/**
 * Offsets a 2D loop by d to its left (into the face for SketchUp-ordered loops:
 * outer loops shrink and holes grow for d > 0). Corners are mitred. Returns null
 * if the offset is too large (an edge would vanish or flip).
 */
export function offsetLoop2D(pts: readonly Vec2[], d: number): Vec2[] | null {
  const n = pts.length;
  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % n]!;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len === 0) return null;
    normals.push({ x: -(q.y - p.y) / len, y: (q.x - p.x) / len });
  }
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const n1 = normals[(i - 1 + n) % n]!;
    const n2 = normals[i]!;
    const denom = 1 + n1.x * n2.x + n1.y * n2.y;
    if (denom < 1e-6) return null; // a spike folding back on itself
    const p = pts[i]!;
    out.push({ x: p.x + ((n1.x + n2.x) * d) / denom, y: p.y + ((n1.y + n2.y) * d) / denom });
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    const c = out[i]!;
    const e = out[(i + 1) % n]!;
    if ((e.x - c.x) * (b.x - a.x) + (e.y - c.y) * (b.y - a.y) <= TOL * TOL) return null;
  }
  if (Math.sign(signedArea2D(out)) !== Math.sign(signedArea2D(pts))) return null;
  return out;
}

/** The face's loops offset by d (positive = into the face), or null if too far. */
export function offsetFaceLoops(face: Face, d: number): Vec3[][] | null {
  const proj = new PlaneProjector(face.plane);
  const out: Vec3[][] = [];
  for (const loop of face.loops) {
    // Loops are CCW around the face normal; the projector's plane uses the same normal,
    // so the face interior is to the left of every loop in 2D.
    const off = offsetLoop2D(
      loop.map((v) => proj.to2D(v.pos)),
      d,
    );
    if (!off) return null;
    out.push(off.map((p) => proj.to3D(p)));
  }
  return out;
}

/**
 * SketchUp's Offset on a face: draws copies of its loops d inside it (d < 0:
 * outside), splitting it. Curves stay curves (a circle offsets to a circle).
 */
export function offsetFace(mesh: Mesh, face: Face, d: number, opts: DrawOptions = {}): boolean {
  if (Math.abs(d) <= TOL) return false;
  const loops = offsetFaceLoops(face, d);
  if (!loops) return false;
  // Remember which curve each original edge belonged to.
  const curvesOf = face.loops.map((loop) => loop.map((v, i) => mesh.edgeBetween(v, loop[(i + 1) % loop.length]!)?.curve ?? 0));
  const segments: [Vec3, Vec3][] = [];
  const segmentCurves: number[] = [];
  loops.forEach((loop, li) => {
    for (let i = 0; i < loop.length; i++) {
      segments.push([loop[i]!, loop[(i + 1) % loop.length]!]);
      segmentCurves.push(curvesOf[li]![i]!);
    }
  });
  drawSegments(mesh, segments, opts);
  // New curves for offset copies of curved edges.
  const remap = new Map<number, number>();
  segments.forEach((seg, i) => {
    const old = segmentCurves[i]!;
    if (!old) return;
    let id = remap.get(old);
    if (id === undefined) {
      const info = mesh.curves.get(old);
      id = mesh.addCurve(info ? offsetCurveInfo(info, seg[0]) : { kind: 'arc' });
      remap.set(old, id);
    }
    for (const e of edgesOnSegments(mesh, [seg])) e.curve = id;
  });
  return true;
}

function offsetCurveInfo(info: CurveInfo, onCurve: Vec3): CurveInfo {
  if (!info.center) return { kind: info.kind };
  return { kind: info.kind, center: info.center, normal: info.normal, radius: info.center.distanceTo(onCurve) };
}
