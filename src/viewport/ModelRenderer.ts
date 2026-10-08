import * as THREE from 'three';
import { Vec3 } from '../core/math';
import type { Edge, Face, Vertex } from '../core/Mesh';
import type { Model } from '../core/Model';
import { triangulateFace, triangulateFaceVertices } from '../core/triangulate';

// SketchUp's default style: white-ish front faces, blue-grey back faces, black edges.
const FRONT_COLOR = 0xf4f4f2;
const BACK_COLOR = 0x9eafbd;
const EDGE_COLOR = 0x1a1a1a;

export type HighlightLayer = 'selection' | 'hover';
const HIGHLIGHT_STYLE: Record<HighlightLayer, { color: number; faceOpacity: number }> = {
  selection: { color: 0x2f6fde, faceOpacity: 0.32 },
  hover: { color: 0x2f9dde, faceOpacity: 0.18 },
};

interface Highlight {
  faceIds: Set<number>;
  edgeIds: Set<number>;
  faces: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
}

/** Keeps three.js geometry in sync with the model. */
export class ModelRenderer {
  private readonly faceGeometry = new THREE.BufferGeometry();
  private readonly edgeGeometry = new THREE.BufferGeometry();
  private builtVersion = -1;
  private readonly highlights = new Map<HighlightLayer, Highlight>();
  private highlightsDirty = false;

  constructor(
    private readonly model: Model,
    root: THREE.Group,
  ) {
    // Faces are pushed back slightly in depth so edges drawn on them always win.
    const faceMaterial = (color: number, side: THREE.Side) =>
      new THREE.MeshLambertMaterial({ color, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const front = new THREE.Mesh(this.faceGeometry, faceMaterial(FRONT_COLOR, THREE.FrontSide));
    const back = new THREE.Mesh(this.faceGeometry, faceMaterial(BACK_COLOR, THREE.BackSide));
    const edges = new THREE.LineSegments(this.edgeGeometry, new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
    edges.raycast = () => {}; // picking hits faces; edges are found by the inference engine
    front.name = 'faces-front';
    back.name = 'faces-back';
    edges.name = 'edges';
    root.add(front, back, edges);

    // Highlights draw over faces (no depth offset) and over edges (later render order).
    for (const layer of ['hover', 'selection'] as const) {
      const style = HIGHLIGHT_STYLE[layer];
      const faces = new THREE.BufferGeometry();
      const edgeGeo = new THREE.BufferGeometry();
      const faceMesh = new THREE.Mesh(
        faces,
        new THREE.MeshBasicMaterial({ color: style.color, transparent: true, opacity: style.faceOpacity, depthWrite: false, side: THREE.DoubleSide }),
      );
      const edgeLines = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: style.color }));
      faceMesh.renderOrder = layer === 'selection' ? 2 : 1;
      edgeLines.renderOrder = layer === 'selection' ? 4 : 3;
      faceMesh.raycast = () => {};
      edgeLines.raycast = () => {};
      root.add(faceMesh, edgeLines);
      this.highlights.set(layer, { faceIds: new Set(), edgeIds: new Set(), faces, edges: edgeGeo });
    }
    this.update();
  }

  /** Highlights faces and edges (by id, so it survives model rebuilds). */
  setHighlight(layer: HighlightLayer, faces: Iterable<Face>, edges: Iterable<Edge>): void {
    const h = this.highlights.get(layer)!;
    h.faceIds = new Set([...faces].map((f) => f.id));
    h.edgeIds = new Set([...edges].map((e) => e.id));
    this.highlightsDirty = true;
  }

  /** Rebuilds GPU buffers if the model changed since the last call. Cheap otherwise. */
  update(): void {
    if (this.model.version === this.builtVersion) {
      if (this.highlightsDirty) this.updateHighlights();
      return;
    }
    this.builtVersion = this.model.version;
    const mesh = this.model.mesh;

    const positions: number[] = [];
    const normals: number[] = [];
    const smooth = new SmoothNormals();
    for (const face of mesh.faces.values()) {
      for (const tri of triangulateFaceVertices(face)) {
        for (const v of tri) {
          const n = smooth.at(face, v);
          positions.push(v.pos.x, v.pos.y, v.pos.z);
          normals.push(n.x, n.y, n.z);
        }
      }
    }
    this.faceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.faceGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    this.faceGeometry.computeBoundingBox();
    this.faceGeometry.computeBoundingSphere();

    const edgePositions: number[] = [];
    for (const e of mesh.edges.values()) {
      if (e.hidden || e.soft) continue;
      edgePositions.push(e.v0.pos.x, e.v0.pos.y, e.v0.pos.z, e.v1.pos.x, e.v1.pos.y, e.v1.pos.z);
    }
    this.edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    this.edgeGeometry.computeBoundingBox();
    this.edgeGeometry.computeBoundingSphere();
    this.updateHighlights();
  }

  private updateHighlights(): void {
    this.highlightsDirty = false;
    const mesh = this.model.mesh;
    for (const h of this.highlights.values()) {
      const tris: number[] = [];
      for (const id of h.faceIds) {
        const f = mesh.faces.get(id);
        if (!f) continue;
        for (const tri of triangulateFace(f)) for (const p of tri) tris.push(p.x, p.y, p.z);
      }
      h.faces.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
      h.faces.computeBoundingSphere();
      const lines: number[] = [];
      for (const id of h.edgeIds) {
        const e = mesh.edges.get(id);
        if (!e) continue;
        lines.push(e.v0.pos.x, e.v0.pos.y, e.v0.pos.z, e.v1.pos.x, e.v1.pos.y, e.v1.pos.z);
      }
      h.edges.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      h.edges.computeBoundingSphere();
    }
  }
}

/**
 * Shading normals: a face's own normal, except at vertices where it meets other
 * faces across smooth edges (e.g. the sides of a cylinder), where the normals of
 * that whole smooth patch around the vertex are averaged so it shades as one surface.
 */
class SmoothNormals {
  private readonly cache = new Map<string, Vec3>();

  at(face: Face, v: Vertex): Vec3 {
    let hasSmooth = false;
    for (const e of v.edges) if (e.smooth && e.faces.has(face)) hasSmooth = true;
    if (!hasSmooth) return face.normal;
    const key = `${face.id}:${v.id}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    // Faces around v reachable from `face` by crossing smooth edges at v.
    const patch = new Set<Face>([face]);
    const stack = [face];
    while (stack.length > 0) {
      const f = stack.pop()!;
      for (const e of v.edges) {
        if (!e.smooth || !e.faces.has(f)) continue;
        for (const g of e.faces) {
          // Only blend faces that roughly agree (not folded back on each other).
          if (!patch.has(g) && g.normal.dot(face.normal) > 0) {
            patch.add(g);
            stack.push(g);
          }
        }
      }
    }
    let sum = new Vec3();
    for (const f of patch) sum = sum.add(f.normal);
    const n = sum.normalize();
    for (const f of patch) this.cache.set(`${f.id}:${v.id}`, n);
    return n;
  }
}
