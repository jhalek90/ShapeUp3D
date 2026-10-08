import { describe, expect, it } from 'vitest';
import { Transform } from './affine';
import { copyInstance, makeGroup } from './groups';
import { Vec3 } from './math';
import type { Mesh } from './Mesh';
import { Model, type ModelJSON } from './Model';
import { drawPolyline } from './ops';
import { pushPull } from './pushpull';

const v = (x: number, y: number, z = 0) => new Vec3(x, y, z);
const rect = (x0: number, y0: number, x1: number, y1: number, z = 0) => [v(x0, y0, z), v(x1, y0, z), v(x1, y1, z), v(x0, y1, z)];

function box(m: Mesh, x: number) {
  drawPolyline(m, rect(x, 0, x + 10, 10), true);
  pushPull(m, [...m.faces.values()].find((f) => f.normal.z < -0.99 && f.outer.every((p) => p.pos.x >= x - 1e-9))!, -10);
}

/** The model serialized from scratch, with no caching involved. */
function fresh(model: Model): string {
  const json: ModelJSON = {
    root: model.mesh.toJSON(),
    definitions: [...model.definitions.values()].map((d) => ({ id: d.id, name: d.name, kind: d.kind, mesh: d.mesh.toJSON(), frame: d.frame?.toArray() })),
    nextDefinitionId: 0,
    editPath: [...model.editPath],
  };
  return JSON.stringify({ ...json, nextDefinitionId: 0 });
}

function cached(model: Model): string {
  return JSON.stringify({ ...model.toJSON(), nextDefinitionId: 0 });
}

describe('Model caching', () => {
  it('cached snapshots always match the real state through edits, groups, previews, undo and redo', () => {
    const model = new Model();
    const check = (label: string) => expect(cached(model), label).toBe(fresh(model));
    model.transact('Box A', (m) => box(m, 0));
    check('box A');
    const a = model.transact('Group A', (m, mdl) => makeGroup(mdl, m, [...m.faces.values()], [], [], 'component'))!;
    check('group');
    model.transact('Box B', (m) => box(m, 30));
    check('box B');
    model.transact('Copy A', (m, mdl) => copyInstance(mdl, m, a, Transform.translation(v(0, 40, 0))));
    check('copy');

    // Edit inside the component, with a live preview first.
    model.enter(a.id);
    check('enter');
    model.beginPreview();
    for (const d of [2, 4, 6]) {
      model.showPreview((m) => pushPull(m, [...m.faces.values()].find((f) => f.normal.z > 0.99)!, d));
      check(`preview ${d}`);
    }
    model.endPreview();
    check('preview ended');
    model.transact('Taller', (m) => pushPull(m, [...m.faces.values()].find((f) => f.normal.z > 0.99)!, 5));
    check('taller');
    model.exit();
    check('exit');

    // Undo all the way and redo all the way.
    while (model.undo()) check(`undo -> ${model.undoName}`);
    while (model.redo()) check(`redo -> ${model.redoName}`);

    // An operation touching every mesh.
    model.transact('Guides everywhere', (_m, mdl) => {
      mdl.mesh.addGuidePoint(v(1, 2, 3));
      for (const d of mdl.definitions.values()) d.mesh.addGuidePoint(v(4, 5, 6));
    }, { scope: 'all' });
    check('scope all');
    model.undo();
    check('undo scope all');
  });

  it('undo reuses meshes it does not need to reload', () => {
    const model = new Model();
    model.transact('Box A', (m) => box(m, 0));
    const a = model.transact('Group A', (m, mdl) => makeGroup(mdl, m, [...m.faces.values()], [], [], 'group'))!;
    const defMesh = model.definitions.get(a.definition)!.mesh;
    model.transact('Box B', (m) => box(m, 30));
    model.undo();
    // The group's geometry wasn't touched by "Box B", so it's the same object (not reloaded).
    expect(model.definitions.get(a.definition)!.mesh).toBe(defMesh);
    model.redo();
    expect(model.definitions.get(a.definition)!.mesh).toBe(defMesh);
  });

  it('a failed operation restores the mesh it was changing', () => {
    const model = new Model();
    model.transact('Box', (m) => box(m, 0));
    const before = cached(model);
    expect(() =>
      model.transact('Broken', (m) => {
        pushPull(m, [...m.faces.values()].find((f) => f.normal.z > 0.99)!, 5);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(cached(model)).toBe(before);
    expect(fresh(model)).toBe(before);
  });
});
