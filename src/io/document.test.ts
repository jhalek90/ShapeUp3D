import { describe, expect, it } from 'vitest';
import { Vec3 } from '../core/math';
import { Mesh } from '../core/Mesh';
import { drawPolyline } from '../core/ops';
import { pushPull } from '../core/pushpull';
import { parseDocument, serializeDocument } from './document';

function boxMesh(): Mesh {
  const m = new Mesh();
  drawPolyline(m, [new Vec3(0, 0, 0), new Vec3(10, 0, 0), new Vec3(10, 10, 0), new Vec3(0, 10, 0)], true);
  pushPull(m, [...m.faces.values()][0]!, -10);
  m.addGuideLine(new Vec3(0, 5, 0), Vec3.X);
  m.addGuidePoint(new Vec3(3, 3, 3));
  return m;
}

describe('document format', () => {
  it('round-trips geometry, guides, units and camera', () => {
    const mesh = boxMesh();
    const camera = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 35, projection: 'parallel' as const };
    const doc = parseDocument(serializeDocument(mesh.toJSON(), { unit: 'in', precision: 3 }, camera));
    expect(doc.units).toEqual({ unit: 'in', precision: 3 });
    expect(doc.camera).toEqual(camera);
    const back = new Mesh();
    back.load(doc.model);
    expect(back.faces.size).toBe(6);
    expect(back.guides.size).toBe(2);
    expect(JSON.stringify(back.toJSON())).toBe(JSON.stringify(mesh.toJSON()));
  });

  it('rejects things that are not ShapeUp3d models', () => {
    expect(() => parseDocument('not json')).toThrow(/not a ShapeUp3d model/);
    expect(() => parseDocument('{"hello":1}')).toThrow(/not a ShapeUp3d model/);
  });

  it('rejects files from a newer version', () => {
    const text = serializeDocument(new Mesh().toJSON(), { unit: 'mm', precision: 2 }).replace('"version":1', '"version":99');
    expect(() => parseDocument(text)).toThrow(/newer version/);
  });

  it('rejects damaged geometry', () => {
    const json = boxMesh().toJSON();
    json.faces[0]![1] = [99999, 99998, 99997]; // face pointing at vertices that don't exist
    expect(() => parseDocument(serializeDocument(json, { unit: 'mm', precision: 2 }))).toThrow(/damaged/);
  });

  it('falls back to millimetres for unknown units', () => {
    const text = serializeDocument(new Mesh().toJSON(), { unit: 'mm', precision: 2 }).replace('"unit":"mm"', '"unit":"furlongs"');
    expect(parseDocument(text).units.unit).toBe('mm');
  });
});
