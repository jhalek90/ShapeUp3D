import { Mesh, type MeshJSON } from '../core/Mesh';
import { LENGTH_UNITS, type LengthFormat } from '../units/length';

// The native file format: a versioned JSON document.

export const FILE_EXTENSION = '.su3d';
export const FILE_FORMAT = 'shapeup3d';
export const FILE_VERSION = 1;

export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  projection: 'perspective' | 'parallel';
}

export interface DocumentJSON {
  format: typeof FILE_FORMAT;
  version: number;
  units: LengthFormat;
  model: MeshJSON;
  camera?: CameraState;
}

export function serializeDocument(model: MeshJSON, units: LengthFormat, camera?: CameraState): string {
  const doc: DocumentJSON = { format: FILE_FORMAT, version: FILE_VERSION, units: { ...units }, model, camera };
  return JSON.stringify(doc);
}

/** Parses and checks a document. Throws an Error with a user-readable message if it's not valid. */
export function parseDocument(text: string): DocumentJSON {
  let doc: Partial<DocumentJSON>;
  try {
    doc = JSON.parse(text) as Partial<DocumentJSON>;
  } catch {
    throw new Error('This file is not a ShapeUp3d model (it is not valid JSON).');
  }
  if (!doc || doc.format !== FILE_FORMAT) throw new Error('This file is not a ShapeUp3d model.');
  if (typeof doc.version !== 'number' || doc.version > FILE_VERSION) {
    throw new Error(`This model was saved by a newer version of ShapeUp3d (format ${doc.version}). Please update.`);
  }
  const m = doc.model;
  if (!m || !Array.isArray(m.vertices) || !Array.isArray(m.edges) || !Array.isArray(m.faces) || typeof m.nextId !== 'number') {
    throw new Error('This model file is damaged (missing geometry).');
  }
  // Load it into a scratch mesh to make sure it's consistent before touching the real model.
  const check = new Mesh();
  try {
    check.load(m);
  } catch (err) {
    throw new Error(`This model file is damaged (${(err as Error).message}).`);
  }
  const problems = check.validate();
  if (problems.length > 0) throw new Error(`This model file is damaged (${problems[0]}).`);

  const units: LengthFormat =
    doc.units && LENGTH_UNITS.includes(doc.units.unit) && Number.isInteger(doc.units.precision)
      ? { unit: doc.units.unit, precision: doc.units.precision }
      : { unit: 'mm', precision: 2 };
  return { format: FILE_FORMAT, version: doc.version, units, model: m, camera: isCamera(doc.camera) ? doc.camera : undefined };
}

function isCamera(c: unknown): c is CameraState {
  const cam = c as CameraState | undefined;
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  return !!cam && vec(cam.position) && vec(cam.target) && typeof cam.fov === 'number' && (cam.projection === 'perspective' || cam.projection === 'parallel');
}
