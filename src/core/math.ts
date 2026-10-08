// Geometry math for the core. No three.js here: the core must stay renderer-independent.
// All lengths are millimetres.

/** Points closer than this are the same point; also the coplanarity tolerance. */
export const TOL = 1e-3;
/** Unit vectors whose cross product is shorter than this are parallel. */
export const PARALLEL_TOL = 1e-9;

export interface XYZ {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Immutable 3D vector. */
export class Vec3 implements XYZ {
  static readonly ZERO = new Vec3(0, 0, 0);
  static readonly X = new Vec3(1, 0, 0);
  static readonly Y = new Vec3(0, 1, 0);
  static readonly Z = new Vec3(0, 0, 1);

  constructor(
    readonly x = 0,
    readonly y = 0,
    readonly z = 0,
  ) {}

  static from(v: XYZ): Vec3 {
    return v instanceof Vec3 ? v : new Vec3(v.x, v.y, v.z);
  }

  add(v: XYZ): Vec3 {
    return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v: XYZ): Vec3 {
    return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  scale(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }

  /** this + v * s */
  addScaled(v: XYZ, s: number): Vec3 {
    return new Vec3(this.x + v.x * s, this.y + v.y * s, this.z + v.z * s);
  }

  negate(): Vec3 {
    return new Vec3(-this.x, -this.y, -this.z);
  }

  dot(v: XYZ): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: XYZ): Vec3 {
    return new Vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
  }

  lengthSq(): number {
    return this.dot(this);
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  /** Unit vector in the same direction, or the zero vector if this is zero. */
  normalize(): Vec3 {
    const len = this.length();
    return len > 0 ? this.scale(1 / len) : Vec3.ZERO;
  }

  distanceTo(v: XYZ): number {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  lerp(v: XYZ, t: number): Vec3 {
    return new Vec3(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t, this.z + (v.z - this.z) * t);
  }

  equals(v: XYZ, tol = TOL): boolean {
    return this.distanceTo(v) <= tol;
  }

  isParallelTo(v: Vec3): boolean {
    return this.normalize().cross(v.normalize()).length() < 1e-6;
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  toString(): string {
    return `(${this.x}, ${this.y}, ${this.z})`;
  }
}

export interface Vec2 {
  x: number;
  y: number;
}

/** Plane n·p = d with unit normal n. */
export class Plane {
  readonly normal: Vec3;
  readonly d: number;

  constructor(normal: Vec3, d: number) {
    this.normal = normal;
    this.d = d;
  }

  static fromPointNormal(point: XYZ, normal: Vec3): Plane {
    const n = normal.normalize();
    return new Plane(n, n.dot(point));
  }

  /** Plane through three points, or null if they're collinear. */
  static fromPoints(a: Vec3, b: Vec3, c: Vec3): Plane | null {
    const n = b.sub(a).cross(c.sub(a));
    if (n.length() < TOL * TOL) return null;
    return Plane.fromPointNormal(a, n);
  }

  signedDistance(p: XYZ): number {
    return this.normal.dot(p) - this.d;
  }

  contains(p: XYZ, tol = TOL): boolean {
    return Math.abs(this.signedDistance(p)) <= tol;
  }

  /** Same plane, ignoring which way the normal points. */
  coincides(other: Plane, tol = TOL): boolean {
    const dot = this.normal.dot(other.normal);
    if (Math.abs(dot) < 1 - PARALLEL_TOL) return false;
    return Math.abs(this.d - Math.sign(dot) * other.d) <= tol;
  }

  flipped(): Plane {
    return new Plane(this.normal.negate(), -this.d);
  }

  projectPoint(p: XYZ): Vec3 {
    return Vec3.from(p).addScaled(this.normal, -this.signedDistance(p));
  }

  /** Ray parameter t of the intersection, or null if the ray is parallel. */
  intersectRay(origin: XYZ, dir: XYZ): number | null {
    const denom = this.normal.dot(dir);
    if (Math.abs(denom) < 1e-12) return null;
    return (this.d - this.normal.dot(origin)) / denom;
  }

  /**
   * Orthonormal in-plane axes (u, v) with u × v = normal. Deterministic for a given
   * normal, so 2D projections of the same plane always agree.
   */
  basis(): { u: Vec3; v: Vec3 } {
    const n = this.normal;
    // Prefer world X (or Y if the normal is close to X) so axis-aligned planes get axis-aligned 2D coords.
    const ref = Math.abs(n.x) < 0.9 ? Vec3.X : Vec3.Y;
    const u = ref.sub(n.scale(n.dot(ref))).normalize();
    const v = n.cross(u);
    return { u, v };
  }
}

/** Projects 3D points in a plane to 2D coordinates in the plane's basis. */
export class PlaneProjector {
  private readonly u: Vec3;
  private readonly v: Vec3;

  constructor(readonly plane: Plane) {
    const { u, v } = plane.basis();
    this.u = u;
    this.v = v;
  }

  to2D(p: XYZ): Vec2 {
    return { x: this.u.dot(p), y: this.v.dot(p) };
  }

  to3D(p: Vec2): Vec3 {
    return this.plane.normal.scale(this.plane.d).addScaled(this.u, p.x).addScaled(this.v, p.y);
  }
}

/** Newell's method: robust normal of a (possibly slightly non-planar) polygon, length = 2 × area. */
export function newellNormal(points: readonly XYZ[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    x += (a.y - b.y) * (a.z + b.z);
    y += (a.z - b.z) * (a.x + b.x);
    z += (a.x - b.x) * (a.y + b.y);
  }
  return new Vec3(x, y, z);
}

/** Closest point on segment ab to p, with its parameter t in [0, 1]. */
export function closestPointOnSegment(p: XYZ, a: Vec3, b: Vec3): { point: Vec3; t: number } {
  const ab = b.sub(a);
  const len2 = ab.lengthSq();
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, Vec3.from(p).sub(a).dot(ab) / len2));
  return { point: a.addScaled(ab, t), t };
}

/** Distance from p to the infinite line through a with direction dir (any length). */
export function distanceToLine(p: XYZ, a: Vec3, dir: Vec3): number {
  const d = dir.normalize();
  const ap = Vec3.from(p).sub(a);
  return ap.sub(d.scale(ap.dot(d))).length();
}

/**
 * Closest points between segments p0p1 and q0q1. Returns parameters s, t in [0, 1]
 * and the points. (Ericson, Real-Time Collision Detection, 5.1.9.)
 */
export function closestSegmentSegment(
  p0: Vec3,
  p1: Vec3,
  q0: Vec3,
  q1: Vec3,
): { s: number; t: number; p: Vec3; q: Vec3; distance: number } {
  const d1 = p1.sub(p0);
  const d2 = q1.sub(q0);
  const r = p0.sub(q0);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s: number;
  let t: number;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));

  if (a <= 1e-18 && e <= 1e-18) {
    s = t = 0;
  } else if (a <= 1e-18) {
    s = 0;
    t = clamp(f / e);
  } else {
    const c = d1.dot(r);
    if (e <= 1e-18) {
      t = 0;
      s = clamp(-c / a);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > 1e-18 * a * e ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a);
      }
    }
  }
  const p = p0.addScaled(d1, s);
  const q = q0.addScaled(d2, t);
  return { s, t, p, q, distance: p.distanceTo(q) };
}

/**
 * Closest point on the infinite line (a, dir) to the infinite line (o, e).
 * Returns the parameter along the first line, or null if the lines are parallel.
 */
export function closestLineParam(a: Vec3, dir: Vec3, o: Vec3, e: Vec3): number | null {
  const w = a.sub(o);
  const aa = dir.dot(dir);
  const b = dir.dot(e);
  const c = e.dot(e);
  const d = dir.dot(w);
  const f = e.dot(w);
  const denom = aa * c - b * b;
  if (Math.abs(denom) < 1e-12 * aa * c) return null;
  return (b * f - c * d) / denom;
}

/** Signed area of a 2D polygon (positive = counter-clockwise). */
export function signedArea2D(pts: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/** Even-odd point-in-polygon test in 2D. Points exactly on the boundary may go either way. */
export function pointInPolygon2D(p: Vec2, pts: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
