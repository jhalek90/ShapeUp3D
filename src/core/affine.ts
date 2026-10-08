import { Vec3, type XYZ } from './math';

/**
 * An affine transform (rotation/scale + translation), as a 3×4 row-major matrix:
 *   | m0 m1 m2  m3 |
 *   | m4 m5 m6  m7 |
 *   | m8 m9 m10 m11|
 * Used for group/component placements. Immutable.
 */
export class Transform {
  static readonly IDENTITY = new Transform([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);

  readonly m: readonly number[];

  constructor(m: readonly number[]) {
    if (m.length !== 12) throw new Error('Transform needs 12 numbers');
    this.m = m;
  }

  static translation(d: XYZ): Transform {
    return new Transform([1, 0, 0, d.x, 0, 1, 0, d.y, 0, 0, 1, d.z]);
  }

  /** Rotation by `angle` radians about the axis through `center` (right-hand rule). */
  static rotation(center: XYZ, axis: XYZ, angle: number): Transform {
    const k = Vec3.from(axis).normalize();
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const { x, y, z } = k;
    const r = new Transform([
      t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
      t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
      t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
    ]); // prettier-ignore
    return Transform.translation(center).multiply(r).multiply(Transform.translation(Vec3.from(center).negate()));
  }

  /** Per-axis scaling about `anchor`. */
  static scaling(anchor: XYZ, factors: XYZ): Transform {
    const s = new Transform([factors.x, 0, 0, 0, 0, factors.y, 0, 0, 0, 0, factors.z, 0]);
    return Transform.translation(anchor).multiply(s).multiply(Transform.translation(Vec3.from(anchor).negate()));
  }

  apply(p: XYZ): Vec3 {
    const m = this.m;
    return new Vec3(
      m[0]! * p.x + m[1]! * p.y + m[2]! * p.z + m[3]!,
      m[4]! * p.x + m[5]! * p.y + m[6]! * p.z + m[7]!,
      m[8]! * p.x + m[9]! * p.y + m[10]! * p.z + m[11]!,
    );
  }

  /** Applies only the linear part (for directions). */
  applyDir(v: XYZ): Vec3 {
    const m = this.m;
    return new Vec3(m[0]! * v.x + m[1]! * v.y + m[2]! * v.z, m[4]! * v.x + m[5]! * v.y + m[6]! * v.z, m[8]! * v.x + m[9]! * v.y + m[10]! * v.z);
  }

  /** this ∘ other: apply `other` first, then this. */
  multiply(other: Transform): Transform {
    const a = this.m;
    const b = other.m;
    const out: number[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        let v = a[r * 4]! * b[c]! + a[r * 4 + 1]! * b[4 + c]! + a[r * 4 + 2]! * b[8 + c]!;
        if (c === 3) v += a[r * 4 + 3]!;
        out.push(v);
      }
    }
    return new Transform(out);
  }

  determinant(): number {
    const m = this.m;
    return m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
  }

  inverse(): Transform {
    const m = this.m;
    const det = this.determinant();
    if (Math.abs(det) < 1e-15) throw new Error('Transform is not invertible');
    const inv = 1 / det;
    const a = [
      (m[5]! * m[10]! - m[6]! * m[9]!) * inv,
      (m[2]! * m[9]! - m[1]! * m[10]!) * inv,
      (m[1]! * m[6]! - m[2]! * m[5]!) * inv,
      (m[6]! * m[8]! - m[4]! * m[10]!) * inv,
      (m[0]! * m[10]! - m[2]! * m[8]!) * inv,
      (m[2]! * m[4]! - m[0]! * m[6]!) * inv,
      (m[4]! * m[9]! - m[5]! * m[8]!) * inv,
      (m[1]! * m[8]! - m[0]! * m[9]!) * inv,
      (m[0]! * m[5]! - m[1]! * m[4]!) * inv,
    ];
    const t = [m[3]!, m[7]!, m[11]!];
    const tx = -(a[0]! * t[0]! + a[1]! * t[1]! + a[2]! * t[2]!);
    const ty = -(a[3]! * t[0]! + a[4]! * t[1]! + a[5]! * t[2]!);
    const tz = -(a[6]! * t[0]! + a[7]! * t[1]! + a[8]! * t[2]!);
    return new Transform([a[0]!, a[1]!, a[2]!, tx, a[3]!, a[4]!, a[5]!, ty, a[6]!, a[7]!, a[8]!, tz]);
  }

  /** Uniform scale factor if the linear part is a rotation times a uniform scale, else null. */
  uniformScale(): number | null {
    const cols = [this.applyDir(Vec3.X), this.applyDir(Vec3.Y), this.applyDir(Vec3.Z)];
    const s = cols[0]!.length();
    const ok = cols.every((c) => Math.abs(c.length() - s) <= 1e-9 * Math.max(1, s)) && Math.abs(cols[0]!.dot(cols[1]!)) + Math.abs(cols[1]!.dot(cols[2]!)) + Math.abs(cols[0]!.dot(cols[2]!)) <= 1e-9 * Math.max(1, s * s);
    return ok ? s : null;
  }

  isIdentity(): boolean {
    return this.m.every((v, i) => Math.abs(v - Transform.IDENTITY.m[i]!) < 1e-12);
  }

  toArray(): number[] {
    return [...this.m];
  }
}
