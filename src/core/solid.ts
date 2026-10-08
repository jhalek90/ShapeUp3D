import type { Edge, Face, Mesh } from './Mesh';
import type { Model } from './Model';
import type { Triangle } from './stl';
import { triangulateFace } from './triangulate';

// Is it printable? Watertightness and face orientation checks, and a fix for
// reversed faces.

export interface SolidReport {
  /** Edges bordering exactly one face: holes in the surface. */
  openEdges: Edge[];
  /** Edges bordering 3, 5, ... faces: tangled geometry. */
  tangledEdges: Edge[];
  /** Edges whose two faces disagree about which way is out. */
  reversedEdges: Edge[];
  /** Enclosed volume in mm³ (positive when faces point outward). */
  volume: number;
}

export function analyzeMesh(mesh: Mesh): SolidReport {
  const openEdges: Edge[] = [];
  const tangledEdges: Edge[] = [];
  const reversedEdges: Edge[] = [];
  for (const e of mesh.edges.values()) {
    const n = e.faces.size;
    if (n === 0) continue; // loose lines don't affect the solid
    if (n === 1) openEdges.push(e);
    else if (n % 2 === 1) tangledEdges.push(e);
    else if (n === 2) {
      const [f, g] = [...e.faces] as [Face, Face];
      if (direction(f, e) === direction(g, e)) reversedEdges.push(e);
    }
  }
  let volume = 0;
  for (const f of mesh.faces.values()) for (const [a, b, c] of triangulateFace(f)) volume += a.dot(b.cross(c)) / 6;
  return { openEdges, tangledEdges, reversedEdges, volume };
}

export function isWatertight(r: SolidReport): boolean {
  return r.openEdges.length === 0 && r.tangledEdges.length === 0 && r.reversedEdges.length === 0;
}

/** +1 if the face's loops run v0→v1 along the edge, -1 if v1→v0. */
function direction(f: Face, e: Edge): number {
  for (const loop of f.loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      if (a === e.v0 && b === e.v1) return 1;
      if (a === e.v1 && b === e.v0) return -1;
    }
  }
  return 0;
}

/**
 * Makes faces agree on which way is out: within each connected shell, faces are
 * flipped to match their neighbours, then a closed shell that ends up inside out
 * (negative volume) is flipped as a whole. Returns how many faces were flipped.
 */
export function orientFaces(mesh: Mesh): number {
  const seen = new Set<Face>();
  let flipped = 0;
  for (const start of mesh.faces.values()) {
    if (seen.has(start)) continue;
    const shell: Face[] = [start];
    const flip = new Set<Face>();
    seen.add(start);
    for (let i = 0; i < shell.length; i++) {
      const f = shell[i]!;
      for (const e of mesh.faceEdges(f)) {
        if (e.faces.size !== 2) continue; // only walk across clean, two-faced edges
        const g = [...e.faces].find((x) => x !== f)!;
        if (seen.has(g)) continue;
        seen.add(g);
        // Neighbours must run the shared edge in opposite directions (after f's own flip).
        const df = direction(f, e) * (flip.has(f) ? -1 : 1);
        if (direction(g, e) === df) flip.add(g);
        shell.push(g);
      }
    }
    for (const f of flip) mesh.reverseFace(f);
    // A closed shell that is now consistent but inside out gets flipped as a whole.
    const closed = shell.every((f) => mesh.faceEdges(f).every((e) => e.faces.size === 2));
    let vol = 0;
    if (closed) for (const f of shell) for (const [a, b, c] of triangulateFace(f)) vol += a.dot(b.cross(c)) / 6;
    if (closed && vol < 0) {
      for (const f of shell) mesh.reverseFace(f);
      flipped += shell.length - flip.size; // faces flipped twice are back where they started
    } else {
      flipped += flip.size;
    }
  }
  return flipped;
}

export interface PartReport extends SolidReport {
  /** "Model" for loose geometry at the top level, or the group/component name. */
  name: string;
  meshId: string;
}

/**
 * Checks each separate part that would go into an STL: the loose top-level
 * geometry and each group/component definition used.
 */
export function analyzeModel(model: Model): PartReport[] {
  const out: PartReport[] = [];
  const seen = new Set<Mesh>();
  model.traverse((mesh, _t, path) => {
    if (seen.has(mesh) || mesh.faces.size === 0) return;
    seen.add(mesh);
    const def = path.length ? model.definitions.get(path[path.length - 1]!.definition) : undefined;
    out.push({ ...analyzeMesh(mesh), name: def?.name ?? 'Model', meshId: def ? `d${def.id}` : 'root' });
  });
  return out;
}

/**
 * All faces as world-space triangles, for export. With `only`, just those
 * top-level entities (faces / edges are ignored; instances are included whole).
 */
export function modelTriangles(model: Model, only?: { faceIds: Set<number>; instanceIds: Set<number> }): Triangle[] {
  const tris: Triangle[] = [];
  const active = model.active;
  model.traverse((mesh, t, path) => {
    if (only) {
      // Selection is in the active mesh: its own faces, or anything inside a selected instance.
      const depth = model.editPath.length;
      const inActive = mesh === active;
      const underSelected = path.length > depth && only.instanceIds.has(path[depth]!.id) && model.editPath.every((id, i) => path[i]!.id === id);
      if (!inActive && !underSelected) return;
      for (const f of mesh.faces.values()) {
        if (inActive && !only.faceIds.has(f.id)) continue;
        for (const tri of triangulateFace(f)) tris.push(tri.map((p) => t.apply(p)) as Triangle);
      }
      return;
    }
    for (const f of mesh.faces.values()) for (const tri of triangulateFace(f)) tris.push(tri.map((p) => t.apply(p)) as Triangle);
  });
  return tris;
}
