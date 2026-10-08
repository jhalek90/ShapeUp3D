import * as THREE from 'three';
import type { Transform } from '../core/affine';
import { instanceBounds } from '../core/groups';
import { Vec3 } from '../core/math';
import type { Edge, Face, Instance, Mesh, Vertex } from '../core/Mesh';
import type { Model } from '../core/Model';
import { triangulateFace, triangulateFaceVertices } from '../core/triangulate';

// SketchUp's default style: white-ish front faces, blue-grey back faces, black edges.
const FRONT_COLOR = 0xf4f4f2;
const BACK_COLOR = 0x9eafbd;
const EDGE_COLOR = 0x1a1a1a;
/** Opacity of everything outside the group being edited. */
const FADED_OPACITY = 0.3;

export type HighlightLayer = 'selection' | 'hover';
const HIGHLIGHT_STYLE: Record<HighlightLayer, { color: number; faceOpacity: number }> = {
  selection: { color: 0x2f6fde, faceOpacity: 0.32 },
  hover: { color: 0x2f9dde, faceOpacity: 0.18 },
};

interface Highlight {
  faceIds: Set<number>;
  edgeIds: Set<number>;
  instanceIds: Set<number>;
  faces: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
}

/** Face and edge buffers for one style (normal, or faded outside the open group). */
interface Layer {
  faces: THREE.BufferGeometry;
  edges: THREE.BufferGeometry;
}

/**
 * Keeps three.js geometry in sync with the model: the mesh being edited and
 * everything inside it normally, everything else (when inside a group) faded.
 * Highlights mark faces/edges of the active mesh, and groups by their bounding box.
 */
export class ModelRenderer {
  private readonly normal: Layer = { faces: new THREE.BufferGeometry(), edges: new THREE.BufferGeometry() };
  private readonly faded: Layer = { faces: new THREE.BufferGeometry(), edges: new THREE.BufferGeometry() };
  private builtVersion = -1;
  private readonly highlights = new Map<HighlightLayer, Highlight>();
  private highlightsDirty = false;

  constructor(
    private readonly model: Model,
    root: THREE.Group,
  ) {
    // Faces are pushed back slightly in depth so edges drawn on them always win.
    const faceMaterial = (color: number, side: THREE.Side, opacity = 1) =>
      new THREE.MeshLambertMaterial({
        color,
        side,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity === 1,
      });
    const add = (layer: Layer, opacity: number, name: string) => {
      const front = new THREE.Mesh(layer.faces, faceMaterial(FRONT_COLOR, THREE.FrontSide, opacity));
      const back = new THREE.Mesh(layer.faces, faceMaterial(BACK_COLOR, THREE.BackSide, opacity));
      const edges = new THREE.LineSegments(layer.edges, new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: opacity < 1, opacity }));
      edges.raycast = () => {}; // picking hits faces; edges are found by the inference engine
      front.name = `${name}-front`;
      back.name = `${name}-back`;
      edges.name = `${name}-edges`;
      root.add(front, back, edges);
    };
    add(this.normal, 1, 'model');
    add(this.faded, FADED_OPACITY, 'faded');

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
      this.highlights.set(layer, { faceIds: new Set(), edgeIds: new Set(), instanceIds: new Set(), faces, edges: edgeGeo });
    }
    this.update();
  }

  /** Highlights faces, edges and instances of the active mesh (by id, so it survives rebuilds). */
  setHighlight(layer: HighlightLayer, faces: Iterable<Face>, edges: Iterable<Edge>, instances: Iterable<Instance> = []): void {
    const h = this.highlights.get(layer)!;
    h.faceIds = new Set([...faces].map((f) => f.id));
    h.edgeIds = new Set([...edges].map((e) => e.id));
    h.instanceIds = new Set([...instances].map((i) => i.id));
    this.highlightsDirty = true;
  }

  /** Rebuilds GPU buffers if the model changed since the last call. Cheap otherwise. */
  update(): void {
    if (this.model.version === this.builtVersion) {
      if (this.highlightsDirty) this.updateHighlights();
      return;
    }
    this.builtVersion = this.model.version;
    const model = this.model;
    const path = model.editPath;
    const normal = { positions: [] as number[], normals: [] as number[], edges: [] as number[] };
    const faded = { positions: [] as number[], normals: [] as number[], edges: [] as number[] };
    model.traverse((mesh, toWorld, instances) => {
      // Normal: the open group and anything inside it. Faded: everything else.
      const inside = instances.length >= path.length && path.every((id, i) => instances[i]!.id === id);
      appendMesh(mesh, toWorld, inside ? normal : faded);
    });
    setBuffers(this.normal, normal);
    setBuffers(this.faded, faded);
    this.updateHighlights();
  }

  private updateHighlights(): void {
    this.highlightsDirty = false;
    const mesh = this.model.active;
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
      // Groups and components: their bounding box.
      for (const id of h.instanceIds) {
        const inst = mesh.instances.get(id);
        const b = inst && instanceBounds(this.model, inst);
        if (b) pushBox(lines, b.min, b.max);
      }
      h.edges.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
      h.edges.computeBoundingSphere();
    }
  }
}

function appendMesh(mesh: Mesh, t: Transform, out: { positions: number[]; normals: number[]; edges: number[] }): void {
  const identity = t.isIdentity();
  const pos = (p: Vec3) => (identity ? p : t.apply(p));
  const smooth = new SmoothNormals();
  for (const face of mesh.faces.values()) {
    for (const tri of triangulateFaceVertices(face)) {
      for (const v of tri) {
        const p = pos(v.pos);
        const n = identity ? smooth.at(face, v) : t.applyDir(smooth.at(face, v)).normalize();
        out.positions.push(p.x, p.y, p.z);
        out.normals.push(n.x, n.y, n.z);
      }
    }
  }
  for (const e of mesh.edges.values()) {
    if (e.hidden || e.soft) continue;
    const a = pos(e.v0.pos);
    const b = pos(e.v1.pos);
    out.edges.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}

function setBuffers(layer: Layer, data: { positions: number[]; normals: number[]; edges: number[] }): void {
  layer.faces.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  layer.faces.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
  layer.faces.computeBoundingBox();
  layer.faces.computeBoundingSphere();
  layer.edges.setAttribute('position', new THREE.Float32BufferAttribute(data.edges, 3));
  layer.edges.computeBoundingBox();
  layer.edges.computeBoundingSphere();
}

/** The 12 edges of an axis-aligned box, as line-segment coordinates. */
function pushBox(out: number[], a: Vec3, b: Vec3): void {
  const c = (i: number) => new Vec3(i & 1 ? b.x : a.x, i & 2 ? b.y : a.y, i & 4 ? b.z : a.z);
  const pairs = [
    [0, 1], [1, 3], [3, 2], [2, 0],
    [4, 5], [5, 7], [7, 6], [6, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ]; // prettier-ignore
  for (const [i, j] of pairs) {
    const p = c(i!);
    const q = c(j!);
    out.push(p.x, p.y, p.z, q.x, q.y, q.z);
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
