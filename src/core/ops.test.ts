import { describe, expect, it } from 'vitest';
import { newellNormal, Vec3 } from './math';
import { Mesh, type Face } from './Mesh';
import { Model } from './Model';
import { drawPolyline, drawSegments, eraseEdges, eraseFaces } from './ops';

const v = (x: number, y: number, z = 0) => new Vec3(x, y, z);

/** Axis-aligned rectangle corners on the ground (or at height z). */
const rect = (x0: number, y0: number, x1: number, y1: number, z = 0) => [v(x0, y0, z), v(x1, y0, z), v(x1, y1, z), v(x0, y1, z)];

/** Area of a face (outer minus holes). */
function area(f: Face): number {
  const a = (loop: { pos: Vec3 }[]) => newellNormal(loop.map((x) => x.pos)).length() / 2;
  return a(f.outer) - f.holes.reduce((s, h) => s + a(h), 0);
}

function expectValid(mesh: Mesh) {
  expect(mesh.validate()).toEqual([]);
}

const faces = (mesh: Mesh) => [...mesh.faces.values()];

describe('drawing edges', () => {
  it('a closed rectangle on the ground makes one downward face', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 20, 10), true);
    expectValid(mesh);
    expect(mesh.edges.size).toBe(4);
    expect(mesh.faces.size).toBe(1);
    const [f] = faces(mesh);
    expect(area(f!)).toBeCloseTo(200);
    expect(f!.normal.z).toBeCloseTo(-1); // ground faces face down, like SketchUp
  });

  it('only makes the face when the loop closes', () => {
    const mesh = new Mesh();
    const [a, b, c, d] = rect(0, 0, 10, 10);
    drawSegments(mesh, [[a!, b!]]);
    drawSegments(mesh, [[b!, c!]]);
    drawSegments(mesh, [[c!, d!]]);
    expect(mesh.faces.size).toBe(0);
    const res = drawSegments(mesh, [[d!, a!]]);
    expect(res.facesChanged).toBe(true);
    expect(mesh.faces.size).toBe(1);
    expectValid(mesh);
  });

  it('welds endpoints within tolerance', () => {
    const mesh = new Mesh();
    drawSegments(mesh, [[v(0, 0), v(10, 0)]]);
    drawSegments(mesh, [[v(10.0004, 0), v(10, 10)]]);
    expect(mesh.vertices.size).toBe(3);
    expectValid(mesh);
  });

  it('splits crossing edges', () => {
    const mesh = new Mesh();
    drawSegments(mesh, [[v(0, 5), v(10, 5)]]);
    drawSegments(mesh, [[v(5, 0), v(5, 10)]]);
    expect(mesh.vertices.size).toBe(5);
    expect(mesh.edges.size).toBe(4);
    expectValid(mesh);
  });

  it('merges overlapping collinear edges', () => {
    const mesh = new Mesh();
    drawSegments(mesh, [[v(0, 0), v(10, 0)]]);
    drawSegments(mesh, [[v(5, 0), v(15, 0)]]);
    const lengths = [...mesh.edges.values()].map((e) => e.length).sort((a, b) => a - b);
    expect(lengths).toEqual([5, 5, 5]);
    expectValid(mesh);
  });

  it('redrawing an existing edge changes nothing', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    const before = JSON.stringify(mesh.toJSON());
    drawSegments(mesh, [[v(0, 0), v(10, 0)]]);
    expect(JSON.stringify(mesh.toJSON())).toBe(before);
  });

  it('a line across a face splits it in two', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    const res = drawSegments(mesh, [[v(5, 0), v(5, 10)]]);
    expect(res.facesChanged).toBe(true);
    expect(mesh.faces.size).toBe(2);
    expect(faces(mesh).map(area)).toEqual([50, 50]);
    // New faces keep the original orientation.
    for (const f of faces(mesh)) expect(f.normal.z).toBeCloseTo(-1);
    expectValid(mesh);
  });

  it('a line overshooting a face on both sides still splits it', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    drawSegments(mesh, [[v(-5, 4), v(15, 4)]]);
    expect(faces(mesh).map(area).sort((a, b) => a - b)).toEqual([40, 60]);
    expectValid(mesh);
  });

  it('a dangling line on a face leaves it alone', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    const [face] = faces(mesh);
    drawSegments(mesh, [[v(0, 0), v(4, 6)]]);
    expect(faces(mesh)).toEqual([face]);
    expectValid(mesh);
  });

  it('a loop drawn inside a face cuts a hole and fills it with a new face', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    drawPolyline(mesh, rect(3, 3, 6, 6), true);
    expect(mesh.faces.size).toBe(2);
    const [outer, inner] = faces(mesh).sort((a, b) => b.outer.length + b.holes.length - (a.outer.length + a.holes.length));
    expect(outer!.holes).toHaveLength(1);
    expect(area(outer!)).toBeCloseTo(91);
    expect(area(inner!)).toBeCloseTo(9);
    expectValid(mesh);
  });

  it('a loop drawn around an existing face keeps it and adds a face with a hole', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(3, 3, 6, 6), true);
    const [small] = faces(mesh);
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    expect(mesh.faces.size).toBe(2);
    expect(mesh.faces.has(small!.id)).toBe(true);
    const big = faces(mesh).find((f) => f !== small)!;
    expect(area(big)).toBeCloseTo(91);
    expectValid(mesh);
  });

  it('a loop in an empty outline does not fill the outline', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    eraseFaces(mesh, faces(mesh));
    drawPolyline(mesh, rect(3, 3, 6, 6), true);
    expect(faces(mesh).map(area)).toEqual([9]);
    expectValid(mesh);
  });

  it('adjacent rectangles share an edge', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    drawPolyline(mesh, rect(10, 0, 20, 10), true);
    expect(mesh.faces.size).toBe(2);
    const shared = [...mesh.edges.values()].filter((e) => e.faces.size === 2);
    expect(shared).toHaveLength(1);
    expectValid(mesh);
  });

  it('a vertical rectangle faces the given direction', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, [v(0, 0, 0), v(10, 0, 0), v(10, 0, 10), v(0, 0, 10)], true, { facing: new Vec3(0, -1, 0) });
    expect(faces(mesh)[0]!.normal.y).toBeCloseTo(-1);
    expectValid(mesh);
  });

  it('twelve edges of a box make six consistently outward faces', () => {
    const mesh = new Mesh();
    const s = 10;
    drawPolyline(mesh, rect(0, 0, s, s, 0), true);
    drawPolyline(mesh, rect(0, 0, s, s, s), true, { facing: Vec3.Z });
    for (const [x, y] of [
      [0, 0],
      [s, 0],
      [s, s],
      [0, s],
    ] as const) {
      drawSegments(mesh, [[v(x, y, 0), v(x, y, s)]], { facing: new Vec3(1, -1, 1) });
    }
    expectValid(mesh);
    expect(mesh.faces.size).toBe(6);
    const center = new Vec3(s / 2, s / 2, s / 2);
    for (const f of faces(mesh)) {
      const toFace = f.outer[0]!.pos.sub(center);
      expect(f.normal.dot(toFace)).toBeGreaterThan(0);
    }
    for (const e of mesh.edges.values()) expect(e.faces.size).toBe(2);
  });
});

describe('erasing', () => {
  it('erasing a line between coplanar faces merges them and heals the outline', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    drawSegments(mesh, [[v(5, 0), v(5, 10)]]);
    const divider = [...mesh.edges.values()].find((e) => e.faces.size === 2)!;
    eraseEdges(mesh, [divider]);
    expect(mesh.faces.size).toBe(1);
    expect(area(faces(mesh)[0]!)).toBeCloseTo(100);
    expect(mesh.edges.size).toBe(4);
    expect(mesh.vertices.size).toBe(4);
    expectValid(mesh);
  });

  it('erasing an outline edge removes the face', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    eraseEdges(mesh, [[...mesh.edges.values()][0]!]);
    expect(mesh.faces.size).toBe(0);
    expect(mesh.edges.size).toBe(3);
    expectValid(mesh);
  });

  it('erasing a box edge removes its two faces', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10, 0), true);
    drawPolyline(mesh, rect(0, 0, 10, 10, 10), true);
    for (const [x, y] of [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as const)
      drawSegments(mesh, [[v(x, y, 0), v(x, y, 10)]]);
    const vertical = [...mesh.edges.values()].find((e) => e.direction.z !== 0)!;
    eraseEdges(mesh, [vertical]);
    expect(mesh.faces.size).toBe(4);
    expectValid(mesh);
  });

  it('erasing faces keeps their edges', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 10, 10), true);
    eraseFaces(mesh, faces(mesh));
    expect(mesh.faces.size).toBe(0);
    expect(mesh.edges.size).toBe(4);
    expectValid(mesh);
  });
});

describe('Model history', () => {
  it('undoes and redoes operations', () => {
    const model = new Model();
    model.transact('Rectangle', (m) => drawPolyline(m, rect(0, 0, 10, 10), true));
    model.transact('Line', (m) => drawSegments(m, [[v(5, 0), v(5, 10)]]));
    expect(model.mesh.faces.size).toBe(2);
    expect(model.undo()).toBe('Line');
    expect(model.mesh.faces.size).toBe(1);
    expectValid(model.mesh);
    expect(model.undo()).toBe('Rectangle');
    expect(model.mesh.isEmpty).toBe(true);
    expect(model.undo()).toBeNull();
    expect(model.redo()).toBe('Rectangle');
    expect(model.redo()).toBe('Line');
    expect(model.mesh.faces.size).toBe(2);
    expectValid(model.mesh);
  });

  it('does not record operations that change nothing', () => {
    const model = new Model();
    model.transact('Line', (m) => drawSegments(m, [[v(1, 1), v(1, 1)]]));
    expect(model.undoName).toBeNull();
  });

  it('restores the model if an operation throws', () => {
    const model = new Model();
    model.transact('Rectangle', (m) => drawPolyline(m, rect(0, 0, 10, 10), true));
    const before = JSON.stringify(model.mesh.toJSON());
    expect(() =>
      model.transact('Broken', (m) => {
        drawSegments(m, [[v(5, 0), v(5, 10)]]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(JSON.stringify(model.mesh.toJSON())).toBe(before);
  });

  it('new edits clear the redo stack', () => {
    const model = new Model();
    model.transact('A', (m) => drawSegments(m, [[v(0, 0), v(1, 0)]]));
    model.undo();
    model.transact('B', (m) => drawSegments(m, [[v(0, 0), v(0, 1)]]));
    expect(model.redoName).toBeNull();
  });
});

describe('stress', () => {
  it('a tic-tac-toe grid across a square makes nine faces', () => {
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 30, 30), true);
    for (const t of [10, 20]) {
      drawSegments(mesh, [[v(t, 0), v(t, 30)]]);
      drawSegments(mesh, [[v(0, t), v(30, t)]]);
    }
    expectValid(mesh);
    expect(faces(mesh).map(area)).toEqual(Array(9).fill(100));
  });

  it('random lines keep the mesh valid and the face area constant', () => {
    // Deterministic pseudo-random sequence.
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 40 - 5;
    const mesh = new Mesh();
    drawPolyline(mesh, rect(0, 0, 30, 30), true);
    for (let i = 0; i < 150; i++) {
      // Snap to a coarse grid half the time so lines hit existing vertices and overlap edges.
      const snap = i % 2 === 0 ? (x: number) => Math.round(x / 5) * 5 : (x: number) => x;
      drawSegments(mesh, [[v(snap(rand()), snap(rand())), v(snap(rand()), snap(rand()))]]);
      const problems = mesh.validate();
      if (problems.length) throw new Error(`after line ${i}: ${problems.join('; ')}`);
      // Lines only split the square's face; they never create or lose area inside it...
      const inside = faces(mesh).reduce((s, f) => s + area(f), 0);
      // ...but loops closed outside the square may add faces, so only check it never shrinks.
      expect(inside).toBeGreaterThanOrEqual(900 - 1e-6);
    }
  });
});
