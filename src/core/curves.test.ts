import { describe, expect, it } from 'vitest';
import { arcFromBulge, arcPoints, circlePoints, drawCurve, offsetFace } from './curves';
import { newellNormal, Vec3 } from './math';
import { Mesh, type Face } from './Mesh';
import { drawPolyline } from './ops';
import { pushPull } from './pushpull';
import { copyGeometry, transformVertices, translation } from './transform';
import { triangulateFace } from './triangulate';

const v = (x: number, y: number, z = 0) => new Vec3(x, y, z);
const rect = (x0: number, y0: number, x1: number, y1: number, z = 0) => [v(x0, y0, z), v(x1, y0, z), v(x1, y1, z), v(x0, y1, z)];

function area(f: Face): number {
  const a = (loop: { pos: Vec3 }[]) => newellNormal(loop.map((x) => x.pos)).length() / 2;
  return a(f.outer) - f.holes.reduce((s, h) => s + a(h), 0);
}

function volume(mesh: Mesh): number {
  let vol = 0;
  for (const f of mesh.faces.values()) for (const [a, b, c] of triangulateFace(f)) vol += a.dot(b.cross(c)) / 6;
  return vol;
}

const isClosed = (m: Mesh) => [...m.edges.values()].every((e) => e.faces.size === 2);
const polygonArea = (r: number, n: number) => (n * r * r * Math.sin((2 * Math.PI) / n)) / 2;

function circle(mesh: Mesh, center: Vec3, r: number, n = 24, normal = Vec3.Z) {
  return drawCurve(mesh, circlePoints(center, normal, r, n), true, { kind: 'circle', center, normal, radius: r }, { facing: Vec3.Z });
}

describe('curve geometry', () => {
  it('circle points are evenly spaced on the circle, starting on the red axis', () => {
    const pts = circlePoints(v(5, 5), Vec3.Z, 10, 24);
    expect(pts).toHaveLength(24);
    for (const p of pts) expect(p.distanceTo(v(5, 5))).toBeCloseTo(10);
    expect(pts[0]!.equals(v(15, 5))).toBe(true);
  });

  it('a 2-point arc with bulge half the chord is a semicircle', () => {
    const arc = arcFromBulge(v(0, 0), v(10, 0), 5, Vec3.Z)!;
    expect(arc.center.equals(v(5, 0))).toBe(true);
    expect(arc.radius).toBeCloseTo(5);
    expect(arc.sweep).toBeCloseTo(Math.PI);
    const pts = arcPoints(arc, 12);
    expect(pts).toHaveLength(13);
    expect(pts[6]!.equals(v(5, 5))).toBe(true); // through the apex, on the +green side
    expect(pts[12]!.equals(v(10, 0))).toBe(true);
  });

  it('a bulge larger than the radius makes the major arc', () => {
    const arc = arcFromBulge(v(0, 0), v(10, 0), 8, Vec3.Z)!;
    expect(arc.sweep).toBeGreaterThan(Math.PI);
    const pts = arcPoints(arc, 24);
    for (const p of pts) expect(p.distanceTo(arc.center)).toBeCloseTo(arc.radius);
    expect(pts.some((p) => p.equals(v(5, 8), 1e-2))).toBe(true);
  });

  it('a negative bulge goes to the other side', () => {
    const pts = arcPoints(arcFromBulge(v(0, 0), v(10, 0), -3, Vec3.Z)!, 12);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(-3);
  });
});

describe('curves in the mesh', () => {
  it('a drawn circle is one face whose edges share a curve', () => {
    const mesh = new Mesh();
    const { curve } = circle(mesh, v(0, 0), 10);
    expect(mesh.validate()).toEqual([]);
    expect(mesh.faces.size).toBe(1);
    expect(mesh.curveEdges(curve)).toHaveLength(24);
    expect(mesh.curves.get(curve)?.radius).toBe(10);
  });

  it('curves survive a save/load round trip', () => {
    const mesh = new Mesh();
    const { curve } = circle(mesh, v(0, 0), 10);
    const copy = new Mesh();
    copy.load(mesh.toJSON());
    expect(copy.curveEdges(curve)).toHaveLength(24);
    expect(copy.curves.get(curve)?.center?.equals(v(0, 0))).toBe(true);
  });

  it('pulling a circle makes a cylinder with soft, smooth sides', () => {
    const mesh = new Mesh();
    const { curve } = circle(mesh, v(0, 0), 10);
    const disc = [...mesh.faces.values()][0]!;
    pushPull(mesh, disc, disc.normal.z < 0 ? -15 : 15);
    expect(mesh.validate()).toEqual([]);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(polygonArea(10, 24) * 15);
    const vertical = [...mesh.edges.values()].filter((e) => Math.abs(e.direction.z) > 0.99);
    expect(vertical).toHaveLength(24);
    expect(vertical.every((e) => e.soft && e.smooth)).toBe(true);
    // The top circle is a curve of its own, centred 15 up.
    const top = [...mesh.edges.values()].find((e) => e.v0.pos.z > 14 && e.curve)!;
    expect(top.curve).not.toBe(curve);
    expect(mesh.curves.get(top.curve)?.center?.equals(v(0, 0, 15))).toBe(true);
  });

  it('a polygon extrusion keeps hard edges', () => {
    const mesh = new Mesh();
    const pts = circlePoints(v(0, 0), Vec3.Z, 10, 6);
    drawCurve(mesh, pts, true, { kind: 'polygon', center: v(0, 0), normal: Vec3.Z, radius: 10 });
    pushPull(mesh, [...mesh.faces.values()][0]!, -5);
    expect(isClosed(mesh)).toBe(true);
    expect([...mesh.edges.values()].some((e) => e.soft)).toBe(false);
  });

  it('a circle pushed through a block makes a round hole', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(-20, -20, 20, 20), true);
    pushPull(mesh, [...mesh.faces.values()][0]!, -10);
    circle(mesh, v(0, 0, 10), 5);
    const disc = [...mesh.faces.values()].find((f) => f.holes.length === 0 && f.outer.length === 24)!;
    pushPull(mesh, disc, -10);
    expect(mesh.validate()).toEqual([]);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(40 * 40 * 10 - polygonArea(5, 24) * 10);
    expect([...mesh.edges.values()].filter((e) => e.soft)).toHaveLength(24);
  });

  it('moving a whole circle moves its center; bending it drops the center', () => {
    const mesh = new Mesh();
    const { curve } = circle(mesh, v(0, 0), 10);
    transformVertices(mesh, mesh.vertices.values(), translation(v(5, 0, 0)));
    expect(mesh.curves.get(curve)?.center?.equals(v(5, 0))).toBe(true);
    transformVertices(mesh, [[...mesh.vertices.values()][0]!], translation(v(0, 0, 3)));
    expect(mesh.curves.get(curve)?.center).toBeUndefined();
  });

  it('copying a circle gives the copy its own curve', () => {
    const mesh = new Mesh();
    const { curve } = circle(mesh, v(0, 0), 10);
    copyGeometry(mesh, [...mesh.faces.values()], [], translation(v(30, 0, 0)));
    const copies = new Set([...mesh.edges.values()].map((e) => e.curve));
    expect(copies.size).toBe(2);
    const other = [...copies].find((c) => c !== curve)!;
    expect(mesh.curves.get(other)?.center?.equals(v(30, 0))).toBe(true);
  });
});

describe('offsetFace', () => {
  it('offsets a rectangle inward, splitting it', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 20, 10), true);
    expect(offsetFace(mesh, [...mesh.faces.values()][0]!, 2)).toBe(true);
    expect(mesh.validate()).toEqual([]);
    expect([...mesh.faces.values()].map(area).sort((a, b) => a - b)).toEqual([16 * 6, 200 - 16 * 6]);
  });

  it('offsets outward, adding a ring around the face', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 20, 10), true);
    expect(offsetFace(mesh, [...mesh.faces.values()][0]!, -2)).toBe(true);
    expect(mesh.validate()).toEqual([]);
    expect([...mesh.faces.values()].map(area).sort((a, b) => a - b)).toEqual([24 * 14 - 200, 200]);
  });

  it('offsets an L-shape with a concave corner', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, [v(0, 0), v(20, 0), v(20, 10), v(10, 10), v(10, 20), v(0, 20)], true);
    expect(offsetFace(mesh, [...mesh.faces.values()][0]!, 1)).toBe(true);
    expect(mesh.validate()).toEqual([]);
    const inner = [...mesh.faces.values()].find((f) => f.holes.length === 0)!;
    // L of 18 × 8 + 8 × 10 after shrinking by 1 all round.
    expect(area(inner)).toBeCloseTo(18 * 8 + 8 * 10);
  });

  it('a circle offsets to a smaller circle with the same center', () => {
    const mesh = new Mesh();
    const { curve } = circle(mesh, v(0, 0), 10);
    offsetFace(mesh, [...mesh.faces.values()][0]!, 3);
    const curves = [...new Set([...mesh.edges.values()].map((e) => e.curve))].filter((c) => c !== curve);
    expect(curves).toHaveLength(1);
    const info = mesh.curves.get(curves[0]!)!;
    expect(info.center?.equals(v(0, 0))).toBe(true);
    expect(info.radius).toBeLessThan(10);
  });

  it('refuses an offset that would turn the face inside out', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 20, 10), true);
    const before = JSON.stringify(mesh.toJSON());
    expect(offsetFace(mesh, [...mesh.faces.values()][0]!, 6)).toBe(false);
    expect(JSON.stringify(mesh.toJSON())).toBe(before);
  });
});

describe('scaling curves', () => {
  it('a uniformly scaled circle stays a circle with the new radius; a stretched one does not', async () => {
    const { scaling } = await import('./transform');
    const mesh = new Mesh();
    const { curve } = circle(mesh, v(0, 0), 10);
    transformVertices(mesh, mesh.vertices.values(), scaling(v(0, 0), new Vec3(2, 2, 2)));
    expect(mesh.curves.get(curve)?.radius).toBeCloseTo(20);
    transformVertices(mesh, mesh.vertices.values(), scaling(v(0, 0), new Vec3(2, 1, 1)));
    expect(mesh.curves.get(curve)?.center).toBeUndefined();
    expect(mesh.validate()).toEqual([]);
  });
});
