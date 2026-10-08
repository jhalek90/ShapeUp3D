import { Mesh, type MeshJSON } from '../core/Mesh';
import { isModelJSON, type ModelJSON } from '../core/Model';
import { LENGTH_UNITS, type LengthFormat } from '../units/length';

// The native file format: a versioned JSON document.

export const FILE_EXTENSION = '.su3d';
export const FILE_FORMAT = 'shapeup3d';
/** 1: geometry only. 2: groups and components (definitions + instances). */
export const FILE_VERSION = 2;

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
  model: ModelJSON;
  camera?: CameraState;
}

export function serializeDocument(model: ModelJSON, units: LengthFormat, camera?: CameraState): string {
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
  // Version 1 files held a single mesh; wrap it as a model with no groups.
  const raw = doc.model as ModelJSON | MeshJSON | undefined;
  if (!raw) throw new Error('This model file is damaged (missing geometry).');
  const m: ModelJSON = isModelJSON(raw) ? raw : { root: raw, definitions: [], nextDefinitionId: 1, editPath: [] };
  if (!Array.isArray(m.definitions) || typeof m.nextDefinitionId !== 'number') throw new Error('This model file is damaged (missing groups).');
  m.editPath = [];
  // Load every mesh into a scratch copy to make sure it's consistent before touching the real model.
  const definitionIds = new Set(m.definitions.map((d) => d.id));
  for (const [what, mesh] of [['model', m.root] as const, ...m.definitions.map((d) => [d.name, d.mesh] as const)]) {
    if (!mesh || !Array.isArray(mesh.vertices) || !Array.isArray(mesh.edges) || !Array.isArray(mesh.faces) || typeof mesh.nextId !== 'number') {
      throw new Error(`This model file is damaged (missing geometry in ${what}).`);
    }
    const check = new Mesh();
    try {
      check.load(mesh);
    } catch (err) {
      throw new Error(`This model file is damaged (${(err as Error).message}).`);
    }
    const problems = check.validate();
    if (problems.length > 0) throw new Error(`This model file is damaged (${problems[0]}).`);
    for (const [, defId] of mesh.instances ?? []) {
      if (!definitionIds.has(defId)) throw new Error('This model file is damaged (a group refers to missing geometry).');
    }
  }

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
