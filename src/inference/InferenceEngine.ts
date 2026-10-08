import * as THREE from 'three';
import { closestLineParam, closestPointOnSegment, closestSegmentSegment, Plane, TOL, Vec3, type XYZ } from '../core/math';
import { faceContainsPoint, type Edge, type Face, type Guide, type Mesh, type Vertex } from '../core/Mesh';
import type { ForeignGeometry } from '../core/scene';
import type { CameraController } from '../viewport/CameraController';

// Inference ("snapping"): turns a cursor position into a meaningful 3D point.
//
// Priority, highest first (as in SketchUp):
//   1. A lock (arrow keys / Shift) constrains everything to a line or plane.
//   2. Points: endpoints, midpoints, centers of circles and arcs, intersections
//      (edge with edge, edge through face), the origin.
//   3. On an edge.
//   4. Along a red/green/blue axis from the start point.
//   5. On a face.
//   6. On a world axis.
//   7. A free point on the drawing plane.
// Geometry hidden behind the face under the cursor is ignored.
//
// With a line lock, hovering an edge or face stops the point exactly where the
// locked line meets it (draw "along red until that wall").

export type Axis = 'x' | 'y' | 'z';
export const AXIS_DIRS: Record<Axis, Vec3> = { x: Vec3.X, y: Vec3.Y, z: Vec3.Z };
export const AXIS_COLORS: Record<Axis, string> = { x: '#d42020', y: '#1f9d1f', z: '#2448d8' };
const AXIS_NAMES: Record<Axis, string> = { x: 'Red', y: 'Green', z: 'Blue' };

export type InferenceKind =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'intersection'
  | 'guide-point'
  | 'origin'
  | 'on-edge'
  | 'on-guide'
  | 'axis'
  | 'on-face'
  | 'on-axis'
  | 'free';

export interface Inference {
  point: Vec3;
  kind: InferenceKind;
  /** Tooltip text; empty for free points. */
  tooltip: string;
  vertex?: Vertex;
  edge?: Edge;
  face?: Face;
  guide?: Guide;
  /** For 'axis' / 'on-axis' and axis locks. */
  axis?: Axis;
  /** When a snapped point was projected onto a lock, the original point (drawn as a dotted guide). */
  ref?: Vec3;
  /** What `ref` was (e.g. "Endpoint"). */
  refTooltip?: string;
}

export type InferenceLock =
  | { kind: 'line'; origin: Vec3; dir: Vec3; axis?: Axis; tooltip: string }
  | { kind: 'plane'; plane: Plane; tooltip: string };

export interface InferenceQuery {
  /** Cursor position in viewport pixels. */
  x: number;
  y: number;
  ray: { origin: XYZ; direction: XYZ };
  /** Start point of the current operation; enables axis inference. */
  from?: Vec3;
  lock?: InferenceLock | null;
  /** Plane for free points (default: ground, or an axis plane through `from`). */
  plane?: Plane;
}

/** What the engine needs to know about the view. */
export interface InferenceView {
  /** Screen position in pixels, or null if not in front of the camera. */
  project(p: Vec3): { x: number; y: number } | null;
  readonly forward: Vec3;
  readonly position: Vec3;
  readonly focusDistance: number;
  readonly perspective: boolean;
}

/** Pick radii in pixels. */
const POINT_PX = 10;
const EDGE_PX = 7;
const AXIS_PX = 10;

export function viewFromCamera(camera: CameraController, size: () => { width: number; height: number }): InferenceView {
  const v = new THREE.Vector3();
  return {
    project(p) {
      if (camera.projection === 'perspective') {
        v.set(p.x, p.y, p.z);
        if (camera.depthOf(v) <= camera.perspective.near) return null;
      }
      v.set(p.x, p.y, p.z).project(camera.camera);
      const { width, height } = size();
      return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
    },
    get forward() {
      return Vec3.from(camera.forward);
    },
    get position() {
      return Vec3.from(camera.position);
    },
    get focusDistance() {
      return camera.distance;
    },
    get perspective() {
      return camera.projection === 'perspective';
    },
  };
}

export class InferenceEngine {
  /**
   * @param sources the mesh being edited, and (optionally) everything else in
   *   world coordinates — snapped to, but not edited (see core/scene.ts).
   */
  constructor(
    private readonly sources: () => { active: Mesh; foreign?: ForeignGeometry },
    private readonly view: InferenceView,
  ) {}

  /** Meshes to snap to: the active one first. */
  private meshes(): Mesh[] {
    const { active, foreign } = this.sources();
    return foreign ? [active, foreign.mesh] : [active];
  }

  /** True if a face/edge belongs to the mesh being edited (so tools may change it). */
  isActive(entity: Face | Edge): boolean {
    const m = this.sources().active;
    return 'outer' in entity ? m.faces.get(entity.id) === entity : m.edges.get(entity.id) === entity;
  }

  infer(q: InferenceQuery): Inference {
    const origin = Vec3.from(q.ray.origin);
    const dir = Vec3.from(q.ray.direction).normalize();
    const cursor = { x: q.x, y: q.y };
    this.cursorRay = { origin, dir };

    const faceHit = this.raycastFaces(origin, dir);
    const visible = notBehind(faceHit?.face, dir);

    const point = this.nearestPoint(cursor, visible);
    const edge = point ? null : this.nearestEdge(cursor, origin, dir, visible);

    if (q.lock) return this.constrain(q.lock, point ?? edge, faceHit?.face ?? null, origin, dir, q);
    if (point) return point;
    if (edge) return edge;
    if (q.from) {
      const axis = this.axisFrom(q.from, cursor, origin, dir, visible);
      if (axis) return axis;
    }
    if (faceHit) return { point: faceHit.point, kind: 'on-face', tooltip: 'On Face', face: faceHit.face };
    if (!q.from) {
      const onAxis = this.onWorldAxis(cursor, origin, dir);
      if (onAxis) return onAxis;
    }
    return this.free(q, origin, dir);
  }

  /**
   * The edge or face under the cursor, for selecting. Edges win when within a few
   * pixels; hidden geometry is ignored. `point` is where the cursor ray meets it.
   */
  pick(q: Pick<InferenceQuery, 'x' | 'y' | 'ray'>, only?: 'edge' | 'face'): PickResult | null {
    const origin = Vec3.from(q.ray.origin);
    const dir = Vec3.from(q.ray.direction).normalize();
    this.cursorRay = { origin, dir };
    const faceHit = this.raycastFaces(origin, dir);
    let hit: { edge?: Edge; face?: Face; point: Vec3 } | null = null;
    if (only !== 'face') {
      const edge = this.nearestEdge({ x: q.x, y: q.y }, origin, dir, notBehind(faceHit?.face, dir));
      if (edge?.edge) hit = { edge: edge.edge, point: edge.point };
    }
    if (!hit && faceHit && only !== 'edge') hit = { face: faceHit.face, point: faceHit.point };
    if (!hit) return null;
    const entity = (hit.edge ?? hit.face)!;
    if (this.isActive(entity)) return hit;
    // Foreign geometry: a group/component in the active mesh, or something outside the open group.
    const instance = this.sources().foreign?.owner.get(entity);
    return instance !== undefined ? { instance, point: hit.point } : { outside: true, point: hit.point };
  }

  /** Screen position (viewport pixels) of a world point, or null if behind the camera. */
  screen(p: Vec3): { x: number; y: number } | null {
    return this.view.project(p);
  }

  /** The axis-aligned plane through `p` that's most sensible to draw on from this view. */
  defaultPlane(p: Vec3): Plane {
    const f = this.view.forward;
    // Ground-parallel unless looking almost horizontally; then the wall facing the camera.
    if (Math.abs(f.z) >= 0.2) return Plane.fromPointNormal(p, Vec3.Z);
    return Plane.fromPointNormal(p, Math.abs(f.x) > Math.abs(f.y) ? Vec3.X : Vec3.Y);
  }

  // ---- Candidates ----------------------------------------------------------

  private nearestPoint(cursor: { x: number; y: number }, visible: (p: Vec3) => boolean): Inference | null {
    let best: Inference | null = null;
    let bestDist = POINT_PX;
    const consider = (p: Vec3, make: () => Inference) => {
      const s = this.view.project(p);
      if (!s) return;
      const d = Math.hypot(s.x - cursor.x, s.y - cursor.y);
      if (d < bestDist && visible(p)) {
        bestDist = d;
        best = make();
      }
    };
    for (const mesh of this.meshes()) {
      for (const v of mesh.vertices.values()) {
        if (![...v.edges].some(isVisibleEdge)) continue;
        consider(v.pos, () => ({ point: v.pos, kind: 'endpoint', tooltip: 'Endpoint', vertex: v }));
      }
      for (const e of mesh.edges.values()) {
        if (!isVisibleEdge(e)) continue;
        const m = e.midpoint;
        consider(m, () => ({ point: m, kind: 'midpoint', tooltip: 'Midpoint', edge: e }));
      }
      for (const c of mesh.curves.values()) {
        const center = c.center;
        if (center) consider(center, () => ({ point: center, kind: 'center', tooltip: 'Center' }));
      }
      for (const g of mesh.guides.values()) {
        if (g.kind === 'point') consider(g.point, () => ({ point: g.point, kind: 'guide-point', tooltip: 'Guide Point', guide: g }));
      }
    }
    consider(Vec3.ZERO, () => ({ point: Vec3.ZERO, kind: 'origin', tooltip: 'Origin' }));
    this.intersections(cursor, consider);
    return best;
  }

  /**
   * Intersection points near the cursor: edges and guide lines crossing each other
   * (geometry that wasn't drawn into each other, e.g. after a move, or guides
   * crossing edges), and edges or guides passing through faces.
   */
  private intersections(cursor: { x: number; y: number }, consider: (p: Vec3, make: () => Inference) => void): void {
    const near = this.linears().filter((l) => {
      const d = this.screenDistance(cursor, l);
      return d !== null && d < POINT_PX;
    });
    const isEnd = (p: Vec3, l: Linear) => l.segment && (p.equals(l.a) || p.equals(l.a.add(l.dir)));
    const hit = (p: Vec3, l: Linear): Inference => ({ point: p, kind: 'intersection', tooltip: 'Intersection', edge: l.edge, guide: l.guide });
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const a = near[i]!;
        const b = near[j]!;
        const p = meet(a, b);
        if (!p) continue;
        if (isEnd(p, a) && isEnd(p, b)) continue; // a shared corner is just an endpoint
        consider(p, () => hit(p, a));
      }
    }
    // Edges and guides passing through faces.
    const faces = this.meshes().flatMap((m) => [...m.faces.values()]);
    for (const l of near) {
      for (const f of faces) {
        const plane = f.plane;
        const denom = plane.normal.dot(l.dir);
        if (Math.abs(denom) < 1e-12) continue;
        const t = -plane.signedDistance(l.a) / denom;
        const p = l.a.addScaled(l.dir, t);
        if (l.segment && (p.distanceTo(l.a) <= TOL || p.distanceTo(l.a.add(l.dir)) <= TOL || t < 0 || t > 1)) continue;
        if (faceContainsPoint(f, p)) consider(p, () => hit(p, l));
      }
    }
  }

  /** Visible edges (segments) and guide lines (infinite), for line snapping. */
  private linears(): Linear[] {
    const out: Linear[] = [];
    for (const mesh of this.meshes()) {
      for (const e of mesh.edges.values()) {
        if (isVisibleEdge(e)) out.push({ a: e.v0.pos, dir: e.v1.pos.sub(e.v0.pos), segment: true, edge: e });
      }
      for (const g of mesh.guides.values()) {
        if (g.kind === 'line') out.push({ a: g.point, dir: g.dir, segment: false, guide: g });
      }
    }
    return out;
  }

  /** Screen distance from the cursor to an edge or guide line, or null if it's off screen. */
  private screenDistance(cursor: { x: number; y: number }, l: Linear): number | null {
    if (l.segment) {
      const a = this.view.project(l.a);
      const b = this.view.project(l.a.add(l.dir));
      return a && b ? distanceToSegment2D(cursor, a, b) : null;
    }
    // An infinite line: project a short piece of it around the point nearest the cursor.
    const around = l.a.addScaled(l.dir, this.lineParamNearCursor(l) ?? 0);
    const step = l.dir.normalize().scale(this.view.focusDistance * 0.05);
    const a = this.view.project(around.sub(step));
    const b = this.view.project(around.add(step));
    if (!a || !b) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(cursor.x - a.x, cursor.y - a.y);
    return Math.abs((cursor.x - a.x) * dy - (cursor.y - a.y) * dx) / len;
  }

  private cursorRay: { origin: Vec3; dir: Vec3 } | null = null;

  private lineParamNearCursor(l: Linear): number | null {
    const ray = this.cursorRay;
    return ray ? closestLineParam(l.a, l.dir, ray.origin, ray.dir) : null;
  }

  private nearestEdge(cursor: { x: number; y: number }, origin: Vec3, dir: Vec3, visible: (p: Vec3) => boolean): Inference | null {
    let best: Inference | null = null;
    let bestDist = EDGE_PX;
    for (const l of this.linears()) {
      const d = this.screenDistance(cursor, l);
      if (d === null || d >= bestDist) continue;
      // The 3D point on the edge / guide nearest the cursor ray.
      let s = closestLineParam(l.a, l.dir, origin, dir) ?? 0;
      if (l.segment) s = Math.min(1, Math.max(0, s));
      const p = l.a.addScaled(l.dir, s);
      if (!visible(p)) continue;
      bestDist = d;
      best = l.edge ? { point: p, kind: 'on-edge', tooltip: 'On Edge', edge: l.edge } : { point: p, kind: 'on-guide', tooltip: 'On Guide', guide: l.guide };
    }
    return best;
  }

  /** The guide (line or point) under the cursor, for erasing. */
  pickGuide(q: Pick<InferenceQuery, 'x' | 'y' | 'ray'>): Guide | null {
    const origin = Vec3.from(q.ray.origin);
    const dir = Vec3.from(q.ray.direction).normalize();
    this.cursorRay = { origin, dir };
    const cursor = { x: q.x, y: q.y };
    let best: Guide | null = null;
    let bestDist = EDGE_PX;
    for (const g of this.sources().active.guides.values()) {
      let d: number | null;
      if (g.kind === 'point') {
        const s = this.view.project(g.point);
        d = s ? Math.hypot(s.x - cursor.x, s.y - cursor.y) : null;
      } else {
        d = this.screenDistance(cursor, { a: g.point, dir: g.dir, segment: false, guide: g });
      }
      if (d !== null && d < bestDist) {
        bestDist = d;
        best = g;
      }
    }
    return best;
  }

  private axisFrom(from: Vec3, cursor: { x: number; y: number }, origin: Vec3, dir: Vec3, visible: (p: Vec3) => boolean): Inference | null {
    let best: Inference | null = null;
    let bestDist = AXIS_PX;
    for (const axis of ['x', 'y', 'z'] as const) {
      if (this.facesViewer(axis)) continue;
      const p = pointOnLineNearRay(from, AXIS_DIRS[axis], origin, dir);
      if (!p || p.distanceTo(from) <= TOL || !visible(p)) continue;
      const s = this.view.project(p);
      if (!s) continue;
      const d = Math.hypot(s.x - cursor.x, s.y - cursor.y);
      if (d < bestDist) {
        bestDist = d;
        best = { point: p, kind: 'axis', tooltip: `On ${AXIS_NAMES[axis]} Axis`, axis };
      }
    }
    return best;
  }

  /**
   * An axis pointing (nearly) straight at the viewer, like blue in Top view, shows
   * on screen as a short foreshortened stub; snapping to it would pull the cursor far
   * above or below the drawing plane. Skip it (arrow keys can still lock it).
   */
  private facesViewer(axis: Axis): boolean {
    return Math.abs(AXIS_DIRS[axis].dot(this.view.forward)) > 0.95;
  }

  private onWorldAxis(cursor: { x: number; y: number }, origin: Vec3, dir: Vec3): Inference | null {
    let best: Inference | null = null;
    let bestDist = EDGE_PX;
    for (const axis of ['x', 'y', 'z'] as const) {
      if (this.facesViewer(axis)) continue;
      const p = pointOnLineNearRay(Vec3.ZERO, AXIS_DIRS[axis], origin, dir);
      if (!p) continue;
      const s = this.view.project(p);
      if (!s) continue;
      const d = Math.hypot(s.x - cursor.x, s.y - cursor.y);
      if (d < bestDist) {
        bestDist = d;
        best = { point: p, kind: 'on-axis', tooltip: `On ${AXIS_NAMES[axis]} Axis`, axis };
      }
    }
    return best;
  }

  private constrain(lock: InferenceLock, snap: Inference | null, face: Face | null, origin: Vec3, dir: Vec3, q: InferenceQuery): Inference {
    if (lock.kind === 'line') {
      const ldir = lock.dir.normalize();
      const result = (p: Vec3, ref: Vec3 | undefined, refTooltip: string | undefined): Inference => ({
        point: p,
        kind: 'axis',
        tooltip: lock.tooltip,
        axis: lock.axis,
        ref: ref && !ref.equals(p) ? ref : undefined,
        refTooltip,
      });
      if (snap?.kind === 'on-edge' && snap.edge) {
        // Where the locked line passes closest to the edge (exactly through it if they meet).
        const e = snap.edge;
        const s = closestLineParam(lock.origin, ldir, e.v0.pos, e.v1.pos.sub(e.v0.pos));
        if (s !== null) {
          const p = lock.origin.addScaled(ldir, s);
          return result(p, closestPointOnSegment(p, e.v0.pos, e.v1.pos).point, 'On Edge');
        }
      }
      if (snap?.kind === 'on-guide' && snap.guide?.kind === 'line') {
        const g = snap.guide;
        const s = closestLineParam(lock.origin, ldir, g.point, g.dir);
        if (s !== null) return result(lock.origin.addScaled(ldir, s), undefined, 'On Guide');
      }
      if (snap) return result(lock.origin.addScaled(ldir, snap.point.sub(lock.origin).dot(ldir)), snap.point, snap.tooltip);
      if (face) {
        // Where the locked line pierces the face under the cursor (not its own start face).
        const t = face.plane.intersectRay(lock.origin, ldir);
        if (t !== null && Math.abs(t) > TOL) {
          const p = lock.origin.addScaled(ldir, t);
          if (faceContainsPoint(face, p)) return result(p, undefined, 'On Face');
        }
      }
      return result(pointOnLineNearRay(lock.origin, ldir, origin, dir) ?? lock.origin, undefined, undefined);
    }
    if (snap) {
      const p = lock.plane.projectPoint(snap.point);
      return { point: p, kind: 'on-face', tooltip: lock.tooltip, ref: snap.point.equals(p) ? undefined : snap.point, refTooltip: snap.tooltip };
    }
    const t = lock.plane.intersectRay(origin, dir);
    if (t === null) return this.free(q, origin, dir);
    return { point: origin.addScaled(dir, t), kind: 'on-face', tooltip: lock.tooltip };
  }

  private free(q: InferenceQuery, origin: Vec3, dir: Vec3): Inference {
    const plane = q.plane ?? (q.from ? this.defaultPlane(q.from) : Plane.fromPointNormal(Vec3.ZERO, Vec3.Z));
    const t = plane.intersectRay(origin, dir);
    if (t !== null && (t > 0 || !this.view.perspective)) {
      const p = origin.addScaled(dir, t);
      // Points near the horizon are too far away to be useful.
      if (Math.abs(p.sub(this.view.position).dot(this.view.forward)) < this.view.focusDistance * 100) {
        return { point: p, kind: 'free', tooltip: '' };
      }
    }
    // Fall back to a point at the depth of the start point (or the focus distance).
    const depth = q.from ? q.from.sub(this.view.position).dot(this.view.forward) : this.view.focusDistance;
    const along = dir.dot(this.view.forward);
    const originDepth = origin.sub(this.view.position).dot(this.view.forward);
    const s = Math.abs(along) < 1e-12 ? 0 : (depth - originDepth) / along;
    return { point: origin.addScaled(dir, s), kind: 'free', tooltip: '' };
  }

  /** Nearest face hit by the ray. */
  private raycastFaces(origin: Vec3, dir: Vec3): { face: Face; point: Vec3; t: number } | null {
    let best: { face: Face; point: Vec3; t: number } | null = null;
    for (const face of this.meshes().flatMap((m) => [...m.faces.values()])) {
      const t = face.plane.intersectRay(origin, dir);
      if (t === null || (this.view.perspective && t <= 0) || (best && t >= best.t)) continue;
      const p = origin.addScaled(dir, t);
      if (faceContainsPoint(face, p)) best = { face, point: p, t };
    }
    return best;
  }
}

/** Soft and hidden edges aren't drawn, so they aren't snapped to either. */
function isVisibleEdge(e: Edge): boolean {
  return !e.soft && !e.hidden;
}

/**
 * Visibility test for points near the cursor: hidden if behind the plane of the face
 * under the cursor. Points on that face (its edges and corners) stay visible.
 */
function notBehind(face: Face | undefined, rayDir: Vec3): (p: Vec3) => boolean {
  if (!face) return () => true;
  const plane = face.plane;
  // Sign of the side the viewer is on.
  const viewerSide = plane.normal.dot(rayDir) < 0 ? 1 : -1;
  return (p) => plane.signedDistance(p) * viewerSide >= -TOL * 10;
}

/** Point on the line (a, dir) closest to the ray, or null if they're parallel. */
function pointOnLineNearRay(a: Vec3, dir: Vec3, origin: Vec3, rayDir: Vec3): Vec3 | null {
  const s = closestLineParam(a, dir, origin, rayDir);
  return s === null ? null : a.addScaled(dir, s);
}

/**
 * What's under the cursor: an edge or face of the mesh being edited, a group or
 * component in it (by instance id), or something outside the group being edited.
 */
export interface PickResult {
  edge?: Edge;
  face?: Face;
  instance?: number;
  outside?: true;
  point: Vec3;
}

/** An edge (segment from a to a + dir) or a guide line (infinite through a along dir). */
interface Linear {
  a: Vec3;
  dir: Vec3;
  segment: boolean;
  edge?: Edge;
  guide?: Guide;
}

/** Where two edges / guide lines meet (within tolerance), or null. */
function meet(l1: Linear, l2: Linear): Vec3 | null {
  if (l1.segment && l2.segment) {
    const c = closestSegmentSegment(l1.a, l1.a.add(l1.dir), l2.a, l2.a.add(l2.dir));
    return c.distance <= TOL ? c.p.lerp(c.q, 0.5) : null;
  }
  const s = closestLineParam(l1.a, l1.dir, l2.a, l2.dir);
  const t = closestLineParam(l2.a, l2.dir, l1.a, l1.dir);
  if (s === null || t === null) return null;
  const inRange = (l: Linear, x: number) => !l.segment || (x >= -1e-9 && x <= 1 + 1e-9);
  if (!inRange(l1, s) || !inRange(l2, t)) return null;
  const p = l1.a.addScaled(l1.dir, s);
  const q = l2.a.addScaled(l2.dir, t);
  return p.distanceTo(q) <= TOL ? p.lerp(q, 0.5) : null;
}

function distanceToSegment2D(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
