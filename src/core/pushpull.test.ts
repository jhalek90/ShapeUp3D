import { describe, expect, it } from 'vitest';
import { Vec3 } from './math';
import { Mesh, type Face } from './Mesh';
import { drawPolyline } from './ops';
import { pushPull } from './pushpull';
import { copyGeometry, rotation, transformVertices, translation } from './transform';
import { triangulateFace } from './triangulate';

const v = (x: number, y: number, z = 0) => new Vec3(x, y, z);
const rect = (x0: number, y0: number, x1: number, y1: number, z = 0) => [v(x0, y0, z), v(x1, y0, z), v(x1, y1, z), v(x0, y1, z)];

/** Signed volume enclosed by all faces (positive when they all face outward). */
function volume(mesh: Mesh): number {
  let vol = 0;
  for (const f of mesh.faces.values()) {
    for (const [a, b, c] of triangulateFace(f)) vol += a.dot(b.cross(c)) / 6;
  }
  return vol;
}

/** Every edge borders exactly two faces: a closed, watertight shell. */
function isClosed(mesh: Mesh): boolean {
  return [...mesh.edges.values()].every((e) => e.faces.size === 2);
}

function expectValid(mesh: Mesh) {
  expect(mesh.validate()).toEqual([]);
}

/** Face whose outer loop lies entirely at height z with an upward or downward normal. */
function faceAtZ(mesh: Mesh, z: number, up: boolean): Face {
  const f = [...mesh.faces.values()].find((f) => f.outer.every((x) => Math.abs(x.pos.z - z) < 1e-9) && (up ? f.normal.z > 0.99 : f.normal.z < -0.99));
  if (!f) throw new Error(`no face at z=${z}`);
  return f;
}

/** A 10 mm cube made the SketchUp way: rectangle on the ground pulled up. */
function cube(): Mesh {
  const mesh = new Mesh();
  drawPolyline(mesh, rect(0, 0, 10, 10), true);
  const ground = faceAtZ(mesh, 0, false);
  pushPull(mesh, ground, -10); // ground faces face down, so "up" is against the normal
  return mesh;
}

describe('pushPull', () => {
  it('pulls a free rectangle into a closed, outward-facing box', () => {
    const mesh = cube();
    expectValid(mesh);
    expect(mesh.faces.size).toBe(6);
    expect(mesh.edges.size).toBe(12);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(1000);
  });

  it('pulling a free face along its normal also makes an outward box', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    pushPull(mesh, faceAtZ(mesh, 0, false), 4); // down, below the ground
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(400);
  });

  it('pulling the top of a box stretches it without new geometry', () => {
    const mesh = cube();
    pushPull(mesh, faceAtZ(mesh, 10, true), 5);
    expectValid(mesh);
    expect(mesh.faces.size).toBe(6);
    expect(mesh.edges.size).toBe(12);
    expect(volume(mesh)).toBeCloseTo(1500);
  });

  it('pushing the top of a box down shortens it', () => {
    const mesh = cube();
    pushPull(mesh, faceAtZ(mesh, 10, true), -4);
    expectValid(mesh);
    expect(volume(mesh)).toBeCloseTo(600);
  });

  it('refuses to push a box top through its bottom', () => {
    const mesh = cube();
    const before = JSON.stringify(mesh.toJSON());
    expect(pushPull(mesh, faceAtZ(mesh, 10, true), -10)).toBe(false);
    expect(JSON.stringify(mesh.toJSON())).toBe(before);
  });

  it('pushing a rectangle drawn on a face cuts a pocket', () => {
    const mesh = cube();
    drawPolyline(mesh, rect(3, 3, 6, 6, 10), true, { facing: Vec3.Z });
    const inner = [...mesh.faces.values()].find((f) => f.normal.z > 0.99 && f.holes.length === 0 && f.outer.length === 4 && f.outer.every((x) => x.pos.x >= 3 && x.pos.x <= 6))!;
    pushPull(mesh, inner, -4);
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(mesh.faces.size).toBe(11);
    expect(volume(mesh)).toBeCloseTo(1000 - 3 * 3 * 4);
  });

  it('pulling a rectangle drawn on a face makes a boss', () => {
    const mesh = cube();
    drawPolyline(mesh, rect(3, 3, 6, 6, 10), true, { facing: Vec3.Z });
    const inner = [...mesh.faces.values()].find((f) => f.normal.z > 0.99 && f.holes.length === 0 && f.outer.every((x) => x.pos.x >= 3 && x.pos.x <= 6))!;
    pushPull(mesh, inner, 2);
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(1000 + 3 * 3 * 2);
  });

  it('pushing a pocket all the way through punches a hole', () => {
    const mesh = cube();
    drawPolyline(mesh, rect(3, 3, 6, 6, 10), true, { facing: Vec3.Z });
    const inner = [...mesh.faces.values()].find((f) => f.normal.z > 0.99 && f.holes.length === 0 && f.outer.every((x) => x.pos.x >= 3 && x.pos.x <= 6))!;
    pushPull(mesh, inner, -10);
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(1000 - 3 * 3 * 10);
    // Top and bottom each have a hole; 4 outer sides; 4 walls through the hole.
    expect(mesh.faces.size).toBe(10);
    expect([...mesh.faces.values()].filter((f) => f.holes.length === 1)).toHaveLength(2);
  });

  it('pushing an existing pocket further, down to the bottom, punches through', () => {
    const mesh = cube();
    drawPolyline(mesh, rect(3, 3, 6, 6, 10), true, { facing: Vec3.Z });
    const inner = () => [...mesh.faces.values()].find((f) => f.normal.z > 0.99 && f.holes.length === 0 && f.outer.every((x) => x.pos.x >= 3 && x.pos.x <= 6))!;
    pushPull(mesh, inner(), -4);
    const floor = [...mesh.faces.values()].find((f) => f.normal.z > 0.99 && Math.abs(f.outer[0]!.pos.z - 6) < 1e-9)!;
    pushPull(mesh, floor, -6);
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(1000 - 3 * 3 * 10);
    // A real hole: no floor left lying on the bottom face.
    expect(mesh.faces.size).toBe(10);
    expect([...mesh.faces.values()].filter((f) => f.holes.length === 1)).toHaveLength(2);
  });

  it('pushing an edge strip all the way down cuts it off', () => {
    const mesh = cube();
    drawPolyline(mesh, [v(4, 0, 10), v(4, 10, 10)], false);
    const strip = [...mesh.faces.values()].find((f) => f.normal.z > 0.99 && f.outer.every((x) => x.pos.x <= 4 + 1e-9))!;
    pushPull(mesh, strip, -10);
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(600);
    expect(mesh.faces.size).toBe(6);
  });

  it('pushing a strip at the edge of a face notches the solid', () => {
    const mesh = cube();
    // Divide the top along x = 4, then push the x < 4 strip down.
    drawPolyline(mesh, [v(4, 0, 10), v(4, 10, 10)], false);
    const strip = [...mesh.faces.values()].find((f) => f.normal.z > 0.99 && f.outer.every((x) => x.pos.x <= 4 + 1e-9))!;
    pushPull(mesh, strip, -3);
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(1000 - 4 * 10 * 3);
    // The notched sides are single L-shaped faces, not stacks of pieces.
    expect(mesh.faces.size).toBe(8);
  });

  it('pulling a strip at the edge of a face extends the side faces', () => {
    const mesh = cube();
    drawPolyline(mesh, [v(4, 0, 10), v(4, 10, 10)], false);
    const strip = [...mesh.faces.values()].find((f) => f.normal.z > 0.99 && f.outer.every((x) => x.pos.x <= 4 + 1e-9))!;
    pushPull(mesh, strip, 3);
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(1000 + 4 * 10 * 3);
    expect(mesh.faces.size).toBe(8);
  });

  it('a face with a hole extrudes into a tube', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    drawPolyline(mesh, rect(3, 3, 7, 7), true);
    const inner = [...mesh.faces.values()].find((f) => f.holes.length === 0 && f.outer.every((x) => x.pos.x >= 3 && x.pos.x <= 7))!;
    mesh.removeFace(inner);
    const ring = [...mesh.faces.values()][0]!;
    pushPull(mesh, ring, -5);
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo((100 - 16) * 5);
  });

  it('keepBase leaves the original face and stacks a new box', () => {
    const mesh = cube();
    pushPull(mesh, faceAtZ(mesh, 10, true), 5, { keepBase: true });
    expectValid(mesh);
    expect(mesh.faces.size).toBe(11);
  });
});

describe('transforms', () => {
  it('moving a whole box keeps its shape', () => {
    const mesh = cube();
    transformVertices(mesh, mesh.vertices.values(), translation(v(20, 5, 3)));
    expectValid(mesh);
    expect(volume(mesh)).toBeCloseTo(1000);
    expect(Math.min(...[...mesh.vertices.values()].map((x) => x.pos.x))).toBeCloseTo(20);
  });

  it('rotating a box keeps it valid and closed', () => {
    const mesh = cube();
    transformVertices(mesh, mesh.vertices.values(), rotation(v(5, 5, 0), v(1, 1, 0), Math.PI / 5));
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(1000);
  });

  it('moving one top corner up folds the top into triangles', () => {
    const mesh = cube();
    const corner = mesh.vertexAt(v(10, 10, 10))!;
    transformVertices(mesh, [corner], translation(v(0, 0, 4)));
    expectValid(mesh);
    expect(isClosed(mesh)).toBe(true);
    const folds = [...mesh.edges.values()].filter((e) => e.soft);
    expect(folds.length).toBeGreaterThanOrEqual(1);
  });

  it('moving a vertex onto another welds them', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, [v(0, 0), v(10, 0)], false);
    drawPolyline(mesh, [v(20, 0), v(20, 10)], false);
    transformVertices(mesh, [mesh.vertexAt(v(10, 0))!], translation(v(10, 0, 0)));
    expectValid(mesh);
    expect(mesh.vertices.size).toBe(3);
    expect(mesh.edges.size).toBe(2);
  });

  it('copying a box makes a second identical box', () => {
    const mesh = cube();
    copyGeometry(mesh, [...mesh.faces.values()], [], translation(v(30, 0, 0)));
    expectValid(mesh);
    expect(mesh.faces.size).toBe(12);
    expect(isClosed(mesh)).toBe(true);
    expect(volume(mesh)).toBeCloseTo(2000);
  });

  it('a copy that touches the original welds to it', () => {
    const mesh = cube();
    copyGeometry(mesh, [...mesh.faces.values()], [], translation(v(10, 0, 0)));
    expectValid(mesh);
    // The shared wall's vertices are reused.
    expect(mesh.vertices.size).toBe(12);
  });
});
