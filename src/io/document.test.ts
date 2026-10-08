import { describe, expect, it } from 'vitest';
import { makeGroup } from '../core/groups';
import { Vec3 } from '../core/math';
import { Mesh } from '../core/Mesh';
import { Model } from '../core/Model';
import { drawPolyline } from '../core/ops';
import { pushPull } from '../core/pushpull';
import { parseDocument, serializeDocument } from './document';

function box(m: Mesh, x = 0) {
  drawPolyline(m, [new Vec3(x, 0, 0), new Vec3(x + 10, 0, 0), new Vec3(x + 10, 10, 0), new Vec3(x, 10, 0)], true);
  pushPull(m, [...m.faces.values()].find((f) => f.normal.z < -0.99 && f.outer.every((v) => v.pos.x >= x - 1e-9))!, -10);
}

/** A model with a loose box, a grouped box, and guides. */
function sampleModel(): Model {
  const model = new Model();
  model.transact('Box', (m) => box(m, 30));
  model.transact('Group', (m, mdl) => makeGroup(mdl, m, [...m.faces.values()], [], [], 'group'));
  model.transact('Box 2', (m) => {
    box(m, 0);
    m.addGuideLine(new Vec3(0, 5, 0), Vec3.X);
    m.addGuidePoint(new Vec3(3, 3, 3));
  });
  return model;
}

const mm = { unit: 'mm' as const, precision: 2 };

describe('document format', () => {
  it('round-trips geometry, groups, guides, units and camera', () => {
    const model = sampleModel();
    const camera = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 35, projection: 'parallel' as const };
    const doc = parseDocument(serializeDocument(model.toDocumentJSON(), { unit: 'in', precision: 3 }, camera));
    expect(doc.units).toEqual({ unit: 'in', precision: 3 });
    expect(doc.camera).toEqual(camera);
    const back = new Model();
    back.replace(doc.model);
    expect(back.mesh.faces.size).toBe(6);
    expect(back.mesh.instances.size).toBe(1);
    expect(back.definitions.size).toBe(1);
    expect(back.mesh.guides.size).toBe(2);
    expect(JSON.stringify(back.toDocumentJSON())).toBe(JSON.stringify(model.toDocumentJSON()));
  });

  it('saves with groups closed even if one is open', () => {
    const model = sampleModel();
    const closed = JSON.stringify(model.toDocumentJSON());
    model.enter([...model.mesh.instances.keys()][0]!);
    const doc = parseDocument(serializeDocument(model.toDocumentJSON(), mm));
    expect(doc.model.editPath).toEqual([]);
    expect(JSON.stringify(doc.model)).toBe(closed);
  });

  it('opens version 1 files (geometry only)', () => {
    const mesh = new Mesh();
    box(mesh);
    const v1 = JSON.stringify({ format: 'shapeup3d', version: 1, units: mm, model: mesh.toJSON() });
    const doc = parseDocument(v1);
    expect(doc.model.definitions).toEqual([]);
    const back = new Model();
    back.replace(doc.model);
    expect(back.mesh.faces.size).toBe(6);
  });

  it('rejects things that are not ShapeUp3d models', () => {
    expect(() => parseDocument('not json')).toThrow(/not a ShapeUp3d model/);
    expect(() => parseDocument('{"hello":1}')).toThrow(/not a ShapeUp3d model/);
  });

  it('rejects files from a newer version', () => {
    const text = serializeDocument(new Model().toDocumentJSON(), mm).replace('"version":2', '"version":99');
    expect(() => parseDocument(text)).toThrow(/newer version/);
  });

  it('rejects damaged geometry', () => {
    const json = sampleModel().toDocumentJSON();
    json.root.faces[0]![1] = [99999, 99998, 99997]; // a face pointing at vertices that don't exist
    expect(() => parseDocument(serializeDocument(json, mm))).toThrow(/damaged/);
  });

  it('rejects a group pointing at missing geometry', () => {
    const json = sampleModel().toDocumentJSON();
    json.definitions = [];
    expect(() => parseDocument(serializeDocument(json, mm))).toThrow(/missing geometry/);
  });

  it('falls back to millimetres for unknown units', () => {
    const text = serializeDocument(new Model().toDocumentJSON(), mm).replace('"unit":"mm"', '"unit":"furlongs"');
    expect(parseDocument(text).units.unit).toBe('mm');
  });
});
