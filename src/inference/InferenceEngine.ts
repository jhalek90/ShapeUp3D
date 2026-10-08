import * as THREE from 'three';
import {
  closestLineParam,
  Plane,
  PlaneProjector,
  pointInPolygon2D,
  TOL,
  Vec3,
  type XYZ,
} from '../core/math';
import type { Edge, Face, Mesh, Vertex } from '../core/Mesh';
import type { CameraController } from '../viewport/CameraController';

// Inference ("snapping"): turns a cursor position into a meaningful 3D point.
//
// Priority, highest first (as in SketchUp):
//   1. A lock (arrow keys / Shift) constrains everything to a line or plane.
//   2. Points: endpoints, midpoints, the origin.
//   3. On an edge.
//   4. Along a red/green/blue axis from the start point.
//   5. On a face.
//   6. On a world axis.
//   7. A free point on the drawing plane.
// Geometry hidden behind the face under the cursor is ignored.

export type Axis = 'x' | 'y' | 'z';
export const AXIS_DIRS: Record<Axis, Vec3> = { x: Vec3.X, y: Vec3.Y, z: Vec3.Z };
export const AXIS_COLORS: Record<Axis, string> = { x: '#d42020', y: '#1f9d1f', z: '#2448d8' };
const AXIS_NAMES: Record<Axis, string> = { x: 'Red', y: 'Green', z: 'Blue' };

export type InferenceKind = 'endpoint' | 'midpoint' | 'origin' | 'on-edge' | 'axis' | 'on-face' | 'on-axis' | 'free';

export interface Inference {
  point: Vec3;
  kind: InferenceKind;
  /** Tooltip text; empty for free points. */
  tooltip: string;
  vertex?: Vertex;
  edge?: Edge;
  face?: Face;
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
  constructor(
    private readonly mesh: Mesh,
    private readonly view: InferenceView,
  ) {}

  infer(q: InferenceQuery): Inference {
    const origin = Vec3.from(q.ray.origin);
    const dir = Vec3.from(q.ray.direction).normalize();
    const cursor = { x: q.x, y: q.y };

    const faceHit = this.raycastFaces(origin, dir);
    const visible = notBehind(faceHit?.face, dir);

    const point = this.nearestPoint(cursor, visible);
    const edge = point ? null : this.nearestEdge(cursor, origin, dir, visible);

    if (q.lock) return this.constrain(q.lock, point ?? edge, origin, dir, q);
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
  pick(q: Pick<InferenceQuery, 'x' | 'y' | 'ray'>, only?: 'edge' | 'face'): { edge?: Edge; face?: Face; point: Vec3 } | null {
    const origin = Vec3.from(q.ray.origin);
    const dir = Vec3.from(q.ray.direction).normalize();
    const faceHit = this.raycastFaces(origin, dir);
    if (only !== 'face') {
      const edge = this.nearestEdge({ x: q.x, y: q.y }, origin, dir, notBehind(faceHit?.face, dir));
      if (edge?.edge) return { edge: edge.edge, point: edge.point };
    }
    if (faceHit && only !== 'edge') return { face: faceHit.face, point: faceHit.point };
    return null;
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
    for (const v of this.mesh.vertices.values()) {
      consider(v.pos, () => ({ point: v.pos, kind: 'endpoint', tooltip: 'Endpoint', vertex: v }));
    }
    for (const e of this.mesh.edges.values()) {
      const m = e.midpoint;
      consider(m, () => ({ point: m, kind: 'midpoint', tooltip: 'Midpoint', edge: e }));
    }
    consider(Vec3.ZERO, () => ({ point: Vec3.ZERO, kind: 'origin', tooltip: 'Origin' }));
    return best;
  }

  private nearestEdge(cursor: { x: number; y: number }, origin: Vec3, dir: Vec3, visible: (p: Vec3) => boolean): Inference | null {
    let best: Inference | null = null;
    let bestDist = EDGE_PX;
    for (const e of this.mesh.edges.values()) {
      const a = this.view.project(e.v0.pos);
      const b = this.view.project(e.v1.pos);
      if (!a || !b) continue;
      const d = distanceToSegment2D(cursor, a, b);
      if (d >= bestDist) continue;
      // The 3D point on the edge nearest the cursor ray.
      const edgeDir = e.v1.pos.sub(e.v0.pos);
      const s = closestLineParam(e.v0.pos, edgeDir, origin, dir);
      const p = e.v0.pos.lerp(e.v1.pos, Math.min(1, Math.max(0, s ?? 0)));
      if (!visible(p)) continue;
      bestDist = d;
      best = { point: p, kind: 'on-edge', tooltip: 'On Edge', edge: e };
    }
    return best;
  }

  private axisFrom(from: Vec3, cursor: { x: number; y: number }, origin: Vec3, dir: Vec3, visible: (p: Vec3) => boolean): Inference | null {
    let best: Inference | null = null;
    let bestDist = AXIS_PX;
    for (const axis of ['x', 'y', 'z'] as const) {
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

  private onWorldAxis(cursor: { x: number; y: number }, origin: Vec3, dir: Vec3): Inference | null {
    let best: Inference | null = null;
    let bestDist = EDGE_PX;
    for (const axis of ['x', 'y', 'z'] as const) {
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

  private constrain(lock: InferenceLock, snap: Inference | null, origin: Vec3, dir: Vec3, q: InferenceQuery): Inference {
    if (lock.kind === 'line') {
      const ldir = lock.dir.normalize();
      const p = snap
        ? lock.origin.addScaled(ldir, snap.point.sub(lock.origin).dot(ldir))
        : (pointOnLineNearRay(lock.origin, ldir, origin, dir) ?? lock.origin);
      const ref = snap && !snap.point.equals(p) ? snap.point : undefined;
      return { point: p, kind: 'axis', tooltip: lock.tooltip, axis: lock.axis, ref, refTooltip: snap?.tooltip };
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
    for (const face of this.mesh.faces.values()) {
      const plane = face.plane;
      const t = plane.intersectRay(origin, dir);
      if (t === null || (this.view.perspective && t <= 0) || (best && t >= best.t)) continue;
      const p = origin.addScaled(dir, t);
      const proj = new PlaneProjector(plane);
      const p2 = proj.to2D(p);
      if (!pointInPolygon2D(p2, face.outer.map((v) => proj.to2D(v.pos)))) continue;
      if (face.holes.some((h) => pointInPolygon2D(p2, h.map((v) => proj.to2D(v.pos))))) continue;
      best = { face, point: p, t };
    }
    return best;
  }
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

function distanceToSegment2D(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
