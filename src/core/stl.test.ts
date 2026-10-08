import { describe, expect, it } from 'vitest';
import { Transform } from './affine';
import { circlePoints, drawCurve } from './curves';
import { makeGroup } from './groups';
import { buildFromTriangles } from './importMesh';
import { Vec3 } from './math';
import { Mesh } from './Mesh';
import { Model } from './Model';
import { drawPolyline } from './ops';
import { pushPull } from './pushpull';
import { analyzeMesh, analyzeModel, isWatertight, modelTriangles, orientFaces } from './solid';
import { parseSTL, writeAsciiSTL, writeBinarySTL, type Triangle } from './stl';

const v = (x: number, y: number, z = 0) => new Vec3(x, y, z);
const rect = (x0: number, y0: number, x1: number, y1: number, z = 0) => [v(x0, y0, z), v(x1, y0, z), v(x1, y1, z), v(x0, y1, z)];

function box(m: Mesh, x0 = 0, y0 = 0, w = 10, d = 10, h = 10) {
  drawPolyline(m, rect(x0, y0, x0 + w, y0 + d), true);
  const base = [...m.faces.values()].find((f) => f.normal.z < -0.99 && f.outer.every((p) => p.pos.x >= x0 - 1e-9 && p.pos.x <= x0 + w + 1e-9))!;
  pushPull(m, base, -h);
}

function boxModel(): Model {
  const model = new Model();
  model.transact('Box', (m) => box(m, 0, 0, 20, 10, 5));
  return model;
}

const volumeOf = (tris: Triangle[]) => tris.reduce((s, [a, b, c]) => s + a.dot(b.cross(c)) / 6, 0);
const toArrayBuffer = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('STL files', () => {
  it('binary round trip keeps every triangle (to float precision)', () => {
    const tris = modelTriangles(boxModel());
    expect(tris).toHaveLength(12);
    const back = parseSTL(writeBinarySTL(tris));
    expect(back).toHaveLength(12);
    back.forEach((t, i) => t.forEach((p, k) => expect(p.distanceTo(tris[i]![k]!)).toBeLessThan(1e-5)));
    expect(volumeOf(back)).toBeCloseTo(1000, 3);
  });

  it('ASCII round trip', () => {
    const tris = modelTriangles(boxModel());
    const text = writeAsciiSTL(tris, 'box');
    expect(text.startsWith('solid box')).toBe(true);
    expect(volumeOf(parseSTL(toArrayBuffer(text)))).toBeCloseTo(1000, 6);
  });

  it('reads binary files whose header starts with "solid"', () => {
    const tris = modelTriangles(boxModel());
    expect(parseSTL(writeBinarySTL(tris, 'solid but actually binary'))).toHaveLength(12);
  });

  it('rejects junk', () => {
    expect(() => parseSTL(toArrayBuffer('hello world'))).toThrow(/not an STL/);
    const buf = writeBinarySTL(modelTriangles(boxModel())).slice(0, 200);
    expect(() => parseSTL(buf)).toThrow(/damaged/);
  });

  it('exports groups in their placed position', () => {
    const model = boxModel();
    const inst = model.transact('Group', (m, mdl) => makeGroup(mdl, m, [...m.faces.values()], [], [], 'group'))!;
    model.transact('Move', (m) => {
      m.instances.get(inst.id)!.transform = Transform.translation(v(100, 0, 0)).multiply(inst.transform);
    });
    const tris = modelTriangles(model);
    expect(Math.min(...tris.flat().map((p) => p.x))).toBeCloseTo(100);
    expect(volumeOf(tris)).toBeCloseTo(1000);
  });

  it('exports only the selection when asked', () => {
    const model = new Model();
    model.transact('Boxes', (m) => {
      box(m, 0);
      box(m, 50);
    });
    const left = new Set([...model.mesh.faces.values()].filter((f) => f.outer.every((p) => p.pos.x < 20)).map((f) => f.id));
    const tris = modelTriangles(model, { faceIds: left, instanceIds: new Set() });
    expect(tris).toHaveLength(12);
    expect(Math.max(...tris.flat().map((p) => p.x))).toBeCloseTo(10);
  });
});

describe('importing STL', () => {
  it('a cube comes in as 6 editable faces, closed and outward', () => {
    const mesh = new Mesh();
    const stats = buildFromTriangles(mesh, modelTriangles(boxModel()));
    expect(stats.faces).toBe(6);
    expect(mesh.faces.size).toBe(6);
    expect(mesh.edges.size).toBe(12);
    expect(mesh.validate()).toEqual([]);
    const report = analyzeMesh(mesh);
    expect(isWatertight(report)).toBe(true);
    expect(report.volume).toBeCloseTo(1000);
    // And it can be push/pulled like anything drawn here.
    pushPull(mesh, [...mesh.faces.values()].find((f) => f.normal.z > 0.99)!, 5);
    expect(analyzeMesh(mesh).volume).toBeCloseTo(2000);
  });

  it('a box with a hole through it keeps the hole as a face hole', () => {
    const model = boxModel();
    model.transact('Hole', (m) => {
      drawPolyline(m, rect(8, 3, 12, 7, 5), true, { facing: Vec3.Z });
      const sq = [...m.faces.values()].find((f) => f.normal.z > 0.99 && f.outer.length === 4 && f.outer.every((p) => p.pos.x >= 8 && p.pos.x <= 12))!;
      pushPull(m, sq, -5);
    });
    const mesh = new Mesh();
    buildFromTriangles(mesh, modelTriangles(model));
    expect(mesh.validate()).toEqual([]);
    expect([...mesh.faces.values()].filter((f) => f.holes.length === 1)).toHaveLength(2);
    expect(analyzeMesh(mesh).volume).toBeCloseTo(1000 - 16 * 5);
    expect(isWatertight(analyzeMesh(mesh))).toBe(true);
  });

  it('a cylinder comes in with soft, smooth sides', () => {
    const src = new Mesh();
    drawCurve(src, circlePoints(v(0, 0), Vec3.Z, 10, 24), true, { kind: 'circle', center: v(0, 0), normal: Vec3.Z, radius: 10 });
    pushPull(src, [...src.faces.values()][0]!, -20);
    const model = new Model();
    model.replace({ root: src.toJSON(), definitions: [], nextDefinitionId: 1, editPath: [] });
    const mesh = new Mesh();
    buildFromTriangles(mesh, modelTriangles(model));
    expect(mesh.faces.size).toBe(26);
    expect([...mesh.edges.values()].filter((e) => e.soft)).toHaveLength(24);
    expect(isWatertight(analyzeMesh(mesh))).toBe(true);
  });

  it('applies the unit scale (inches to mm)', () => {
    const mesh = new Mesh();
    buildFromTriangles(mesh, modelTriangles(boxModel()), 25.4);
    expect(analyzeMesh(mesh).volume).toBeCloseTo(1000 * 25.4 ** 3, 0);
  });

  it('skips degenerate triangles', () => {
    const mesh = new Mesh();
    const tris = modelTriangles(boxModel());
    tris.push([v(1, 1), v(1, 1), v(2, 2)]);
    expect(buildFromTriangles(mesh, tris).skipped).toBe(1);
    expect(mesh.faces.size).toBe(6);
  });
});

describe('solid checks', () => {
  it('a box is watertight; one missing face shows 4 open edges', () => {
    const mesh = new Mesh();
    box(mesh);
    expect(isWatertight(analyzeMesh(mesh))).toBe(true);
    mesh.removeFace([...mesh.faces.values()][0]!);
    const r = analyzeMesh(mesh);
    expect(r.openEdges).toHaveLength(4);
    expect(isWatertight(r)).toBe(false);
  });

  it('finds reversed faces and orientFaces fixes them', () => {
    const mesh = new Mesh();
    box(mesh);
    const faces = [...mesh.faces.values()];
    mesh.reverseFace(faces[0]!);
    mesh.reverseFace(faces[3]!);
    expect(analyzeMesh(mesh).reversedEdges.length).toBeGreaterThan(0);
    expect(orientFaces(mesh)).toBe(2);
    const r = analyzeMesh(mesh);
    expect(r.reversedEdges).toHaveLength(0);
    expect(r.volume).toBeCloseTo(1000);
  });

  it('orientFaces turns a fully inside-out box the right way out', () => {
    const mesh = new Mesh();
    box(mesh);
    for (const f of mesh.faces.values()) mesh.reverseFace(f);
    expect(analyzeMesh(mesh).volume).toBeCloseTo(-1000);
    expect(orientFaces(mesh)).toBe(6);
    expect(analyzeMesh(mesh).volume).toBeCloseTo(1000);
  });

  it('reports each part of a model separately', () => {
    const model = new Model();
    model.transact('Boxes', (m) => {
      box(m, 0);
      box(m, 50);
    });
    model.transact('Group', (m, mdl) => makeGroup(mdl, m, [...m.faces.values()].filter((f) => f.outer.every((p) => p.pos.x > 40)), [], [], 'group'));
    const parts = analyzeModel(model);
    expect(parts.map((p) => p.name).sort()).toEqual(['Group 1', 'Model']);
    expect(parts.every(isWatertight)).toBe(true);
  });
});
