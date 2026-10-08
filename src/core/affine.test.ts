import { describe, expect, it } from 'vitest';
import { Transform } from './affine';
import { Vec3 } from './math';
import { rotation } from './transform';

const close = (a: Vec3, b: Vec3) => expect(a.distanceTo(b)).toBeLessThan(1e-9);

describe('Transform', () => {
  it('translates, rotates and scales points', () => {
    close(Transform.translation(new Vec3(1, 2, 3)).apply(new Vec3(1, 1, 1)), new Vec3(2, 3, 4));
    close(Transform.rotation(new Vec3(5, 0, 0), Vec3.Z, Math.PI / 2).apply(new Vec3(6, 0, 0)), new Vec3(5, 1, 0));
    close(Transform.scaling(new Vec3(1, 1, 1), new Vec3(2, 3, 4)).apply(new Vec3(2, 2, 2)), new Vec3(3, 4, 5));
  });

  it('matches the Rodrigues rotation used for geometry', () => {
    const c = new Vec3(3, -2, 7);
    const axis = new Vec3(1, 2, -1);
    const p = new Vec3(4, 5, 6);
    close(Transform.rotation(c, axis, 0.7).apply(p), rotation(c, axis, 0.7)(p));
  });

  it('composes in the right order (apply right-hand side first)', () => {
    const t = Transform.translation(new Vec3(10, 0, 0));
    const r = Transform.rotation(Vec3.ZERO, Vec3.Z, Math.PI / 2);
    close(t.multiply(r).apply(new Vec3(1, 0, 0)), new Vec3(10, 1, 0));
    close(r.multiply(t).apply(new Vec3(1, 0, 0)), new Vec3(0, 11, 0));
  });

  it('inverts', () => {
    const t = Transform.translation(new Vec3(4, 5, 6))
      .multiply(Transform.rotation(new Vec3(1, 1, 1), new Vec3(0, 1, 1), 1.1))
      .multiply(Transform.scaling(Vec3.ZERO, new Vec3(2, 3, 0.5)));
    const p = new Vec3(-3, 8, 2);
    close(t.inverse().apply(t.apply(p)), p);
    expect(t.multiply(t.inverse()).isIdentity()).toBe(true);
  });

  it('detects uniform scale', () => {
    expect(Transform.rotation(Vec3.ZERO, Vec3.X, 0.3).uniformScale()).toBeCloseTo(1);
    expect(Transform.scaling(Vec3.ZERO, new Vec3(2, 2, 2)).uniformScale()).toBeCloseTo(2);
    expect(Transform.scaling(Vec3.ZERO, new Vec3(2, 1, 1)).uniformScale()).toBeNull();
  });
});
