import { describe, expect, it } from 'vitest';
import { Transform } from './affine';
import { copyInstance, explode, instanceBounds, makeGroup } from './groups';
import { Vec3 } from './math';
import type { Mesh } from './Mesh';
import { Model } from './Model';
import { drawPolyline } from './ops';
import { pushPull } from './pushpull';
import { buildForeignGeometry } from './scene';

const v = (x: number, y: number, z = 0) => new Vec3(x, y, z);
const rect = (x0: number, y0: number, x1: number, y1: number, z = 0) => [v(x0, y0, z), v(x1, y0, z), v(x1, y1, z), v(x0, y1, z)];

/** A 10 mm cube at (x, y) in the active mesh. */
function cube(m: Mesh, x = 0, y = 0) {
  drawPolyline(m, rect(x, y, x + 10, y + 10), true);
  const base = [...m.faces.values()].find((f) => f.normal.z < -0.99 && f.outer.every((p) => p.pos.x >= x - 1e-9 && p.pos.x <= x + 10 + 1e-9))!;
  pushPull(m, base, -10);
}

/** World-space vertex positions of everything in the model. */
function worldPoints(model: Model): Vec3[] {
  const out: Vec3[] = [];
  model.traverse((mesh, t) => {
    for (const vert of mesh.vertices.values()) out.push(t.apply(vert.pos));
  });
  return out;
}

const sortKey = (pts: Vec3[]) => pts.map((p) => p.toArray().map((n) => n.toFixed(6)).join(',')).sort();

function groupAll(model: Model, kind: 'group' | 'component' = 'group') {
  return model.transact('Make Group', (m, mdl) => makeGroup(mdl, m, [...m.faces.values()], [...m.edges.values()], [...m.instances.values()], kind))!;
}

describe('groups', () => {
  it('making a group moves the geometry into it, in place', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m, 20, 30));
    const before = sortKey(worldPoints(model));
    const inst = groupAll(model);
    expect(model.mesh.faces.size).toBe(0);
    expect(model.mesh.edges.size).toBe(0);
    expect(model.mesh.instances.size).toBe(1);
    expect(model.definitions.get(inst.definition)!.mesh.faces.size).toBe(6);
    expect(sortKey(worldPoints(model))).toEqual(before);
    // The group's origin is its low corner.
    expect(inst.transform.apply(Vec3.ZERO).equals(v(20, 30, 0))).toBe(true);
  });

  it('grouping a face keeps the edges it shares with the rest', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m));
    const top = [...model.mesh.faces.values()].find((f) => f.normal.z > 0.99)!;
    model.transact('Group top', (m, mdl) => makeGroup(mdl, m, [top], [], [], 'group'));
    expect(model.mesh.faces.size).toBe(5);
    expect(model.mesh.edges.size).toBe(12); // the top's edges still bound the sides
    expect(model.mesh.validate()).toEqual([]);
  });

  it('entering moves geometry to world coordinates and exiting moves it back', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m, 20, 30));
    const inst = groupAll(model);
    const def = model.definitions.get(inst.definition)!;
    const local = JSON.stringify(def.mesh.toJSON());
    model.enter(inst.id);
    expect(model.active).toBe(def.mesh);
    expect(Math.min(...[...def.mesh.vertices.values()].map((p) => p.pos.x))).toBeCloseTo(20);
    // World positions are the same either way.
    expect(sortKey(worldPoints(model))).toEqual(sortKey([...def.mesh.vertices.values()].map((p) => p.pos)));
    model.exit();
    expect(model.active).toBe(model.mesh);
    expect(JSON.stringify(def.mesh.toJSON())).toBe(local);
  });

  it('editing inside a group (push/pull) changes only the group', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m));
    model.transact('Box 2', (m) => cube(m, 30, 0));
    // Group just the first box.
    const first = model.transact('Group', (m, mdl) =>
      makeGroup(mdl, m, [...m.faces.values()].filter((f) => f.outer.every((p) => p.pos.x <= 10 + 1e-9)), [], [], 'group'),
    )!;
    model.enter(first.id);
    model.transact('Taller', (m) => pushPull(m, [...m.faces.values()].find((f) => f.normal.z > 0.99)!, 5));
    model.exit();
    const zs = (mesh: Mesh) => Math.max(...[...mesh.vertices.values()].map((p) => p.pos.z));
    expect(zs(model.definitions.get(first.definition)!.mesh)).toBeCloseTo(15);
    expect(zs(model.mesh)).toBeCloseTo(10);
  });

  it('component copies share edits; group copies do not', () => {
    for (const kind of ['component', 'group'] as const) {
      const model = new Model();
      model.transact('Box', (m) => cube(m));
      const a = groupAll(model, kind);
      const b = model.transact('Copy', (m, mdl) => copyInstance(mdl, m, a, Transform.translation(v(50, 0, 0))));
      model.enter(b.id);
      model.transact('Taller', (m) => pushPull(m, [...m.faces.values()].find((f) => f.normal.z > 0.99)!, 5));
      model.exit();
      const top = (inst: typeof a) => instanceBounds(model, model.mesh.instances.get(inst.id)!)!.max.z;
      expect(top(b)).toBeCloseTo(15);
      expect(top(a)).toBeCloseTo(kind === 'component' ? 15 : 10);
    }
  });

  it('while editing one component copy, the others show the edit live', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m));
    const a = groupAll(model, 'component');
    model.transact('Copy', (m, mdl) => copyInstance(mdl, m, a, Transform.translation(v(50, 0, 0))));
    model.enter(a.id);
    model.transact('Taller', (m) => pushPull(m, [...m.faces.values()].find((f) => f.normal.z > 0.99)!, 5));
    // Still inside: the copy at x = 50 already sees the taller box.
    const copyTop = worldPoints(model).filter((p) => p.x > 45).reduce((z, p) => Math.max(z, p.z), 0);
    expect(copyTop).toBeCloseTo(15);
    model.exit();
  });

  it('explode puts the geometry back in place', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m, 5, 5));
    const before = sortKey(worldPoints(model));
    const inst = groupAll(model);
    model.transact('Move', (m) => {
      m.instances.get(inst.id)!.transform = Transform.translation(v(100, 0, 0)).multiply(inst.transform);
    });
    model.transact('Explode', (m, mdl) => explode(mdl, m, m.instances.get(inst.id)!));
    expect(model.mesh.instances.size).toBe(0);
    expect(model.mesh.faces.size).toBe(6);
    expect(model.mesh.validate()).toEqual([]);
    expect(sortKey(worldPoints(model))).toEqual(sortKey(before.map((k) => k.split(',').map(Number)).map(([x, y, z]) => v(x! + 100, y!, z!))));
  });

  it('nested groups keep their place through enter / exit and grouping', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m, 3, 4));
    const inner = groupAll(model);
    model.transact('Box 2', (m) => cube(m, 40, 0));
    const before = sortKey(worldPoints(model));
    const outer = groupAll(model);
    expect(model.definitions.get(outer.definition)!.mesh.instances.size).toBe(1);
    model.enter(outer.id);
    const innerInOuter = [...model.active.instances.values()][0]!;
    model.enter(innerInOuter.id);
    expect(sortKey(worldPoints(model))).toEqual(before);
    model.exitAll();
    expect(sortKey(worldPoints(model))).toEqual(before);
    expect(inner).toBeTruthy();
  });

  it('undo across entering and editing restores everything', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m));
    const inst = groupAll(model);
    const saved = JSON.stringify(model.toDocumentJSON());
    model.enter(inst.id);
    model.transact('Taller', (m) => pushPull(m, [...m.faces.values()].find((f) => f.normal.z > 0.99)!, 5));
    model.undo();
    expect(JSON.stringify(model.toDocumentJSON())).toBe(saved);
    model.exitAll();
    expect(JSON.stringify(model.toDocumentJSON())).toBe(saved);
  });

  it('a saved model has groups closed and unused definitions dropped', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m, 20, 0));
    const inst = groupAll(model);
    model.enter(inst.id);
    const doc = model.toDocumentJSON();
    expect(doc.editPath).toEqual([]);
    const def = doc.definitions.find((d) => d.id === inst.definition)!;
    expect(Math.min(...def.mesh.vertices.map((p) => p[1]))).toBeCloseTo(0); // local coordinates
    model.exitAll();
    model.transact('Delete', (m) => m.instances.clear());
    expect(model.toDocumentJSON().definitions).toEqual([]);
  });
});

describe('foreign geometry (for snapping)', () => {
  it('copies everything outside the open group into world coordinates, with owners', () => {
    const model = new Model();
    model.transact('Box', (m) => cube(m));
    const a = groupAll(model);
    model.transact('Copy', (m, mdl) => copyInstance(mdl, m, a, Transform.translation(v(50, 0, 0))));
    // At the top level: both groups are foreign, each owned by its instance.
    let foreign = buildForeignGeometry(model);
    expect(foreign.parts.reduce((n, p) => n + p.mesh.faces.size, 0)).toBe(12);
    expect(new Set(foreign.parts.map((p) => p.owner)).size).toBe(2);
    // Inside one group: only the other one is foreign, and it isn't selectable from in here.
    model.enter(a.id);
    foreign = buildForeignGeometry(model);
    const faces = foreign.parts.flatMap((p) => [...p.mesh.faces.values()]);
    expect(faces).toHaveLength(6);
    expect(foreign.parts.every((p) => p.owner === undefined)).toBe(true);
    expect(Math.min(...foreign.parts.flatMap((p) => [...p.mesh.vertices.values()].map((v) => v.pos.x)))).toBeCloseTo(50);
  });
});
