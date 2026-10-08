import { Transform } from './affine';
import { newellNormal, Plane, PlaneProjector, pointInPolygon2D, TOL, Vec3, type XYZ } from './math';

// The edge/face model. See PLAN.md "Geometry data model".
//
// Invariants:
// - No two vertices are within TOL of each other (welding).
// - At most one edge between any pair of vertices; every edge has two distinct vertices.
// - Every vertex has at least one edge (no free-floating vertices).
// - Each consecutive vertex pair of a face loop is an edge, and that edge lists the face.
// - A face's outer loop is counter-clockwise around its normal; holes are clockwise.
//
// Mesh methods here are low-level and keep these invariants; the SketchUp-style
// behaviours (auto faces, splitting, merging) live in ops.ts.
//
// Curves: edges drawn as one circle, arc or polygon share a curve id, so they select
// and erase together. The curve's info (center, radius) powers center inference and
// is dropped (`center` unset) if the curve gets distorted.

export type CurveKind = 'circle' | 'arc' | 'polygon';

export interface CurveInfo {
  kind: CurveKind;
  /** Unset once the curve has been distorted and no longer has a true center. */
  center?: Vec3;
  normal?: Vec3;
  radius?: number;
}

/**
 * Construction guides (from Tape Measure and Protractor): infinite dashed lines and
 * points that snapping can use but that aren't geometry (never part of faces/STL).
 */
export type Guide = { id: number; kind: 'line'; point: Vec3; dir: Vec3 } | { id: number; kind: 'point'; point: Vec3 };

/**
 * A placed group or component: an instance of a definition (which holds its own
 * geometry), positioned by `transform` (definition coordinates → this mesh's).
 */
export interface Instance {
  id: number;
  definition: number;
  transform: Transform;
}

/** Curves whose extrusions read as smooth surfaces (polygons stay faceted). */
export function isSmoothCurve(kind: CurveKind | undefined): boolean {
  return kind === 'circle' || kind === 'arc';
}

export class Vertex {
  readonly edges = new Set<Edge>();
  constructor(
    readonly id: number,
    public pos: Vec3,
  ) {}
}

export class Edge {
  readonly faces = new Set<Face>();
  /** Soft edges hide and let faces read as one surface (curves); smooth affects shading. */
  soft = false;
  smooth = false;
  hidden = false;
  /** Curve this edge belongs to (0 = none). */
  curve = 0;

  constructor(
    readonly id: number,
    readonly v0: Vertex,
    readonly v1: Vertex,
  ) {}

  other(v: Vertex): Vertex {
    return v === this.v0 ? this.v1 : this.v0;
  }

  has(v: Vertex): boolean {
    return v === this.v0 || v === this.v1;
  }

  get length(): number {
    return this.v0.pos.distanceTo(this.v1.pos);
  }

  get midpoint(): Vec3 {
    return this.v0.pos.lerp(this.v1.pos, 0.5);
  }

  /** Unit direction v0 → v1. */
  get direction(): Vec3 {
    return this.v1.pos.sub(this.v0.pos).normalize();
  }
}

export class Face {
  constructor(
    readonly id: number,
    public outer: Vertex[],
    public holes: Vertex[][],
    public normal: Vec3,
  ) {}

  get loops(): Vertex[][] {
    return [this.outer, ...this.holes];
  }

  get plane(): Plane {
    return Plane.fromPointNormal(this.outer[0]!.pos, this.normal);
  }

  /** All vertices of all loops. */
  get vertices(): Vertex[] {
    return this.loops.flat();
  }
}

/** True if p (assumed on the face's plane) is inside the face: in its outline, not in a hole. */
export function faceContainsPoint(face: Face, p: XYZ): boolean {
  const proj = new PlaneProjector(face.plane);
  const q = proj.to2D(p);
  if (!pointInPolygon2D(q, face.outer.map((v) => proj.to2D(v.pos)))) return false;
  return !face.holes.some((h) => pointInPolygon2D(q, h.map((v) => proj.to2D(v.pos))));
}

export interface MeshJSON {
  nextId: number;
  /** [id, x, y, z] */
  vertices: [number, number, number, number][];
  /** [id, v0, v1, flags, curve] with flags bit 0 soft, 1 smooth, 2 hidden */
  edges: [number, number, number, number, number][];
  /** [id, outer vertex ids, hole vertex id lists, normal] */
  faces: [number, number[], number[][], [number, number, number]][];
  /** [id, kind, center or null, normal or null, radius or null] */
  curves?: [number, CurveKind, number[] | null, number[] | null, number | null][];
  /** [id, point, direction or null (a guide point)] */
  guides?: [number, number[], number[] | null][];
  /** [id, definition id, transform (12 numbers)] */
  instances?: [number, number, number[]][];
}

/** Copies an edge's display flags and curve onto another edge. */
export function copyEdgeAttributes(from: Edge, to: Edge): void {
  to.soft = from.soft;
  to.smooth = from.smooth;
  to.hidden = from.hidden;
  to.curve = from.curve;
}

/** Spatial hash cell size; any size >= TOL works since lookups check neighbouring cells. */
const CELL = 0.5;

export class Mesh {
  readonly vertices = new Map<number, Vertex>();
  readonly edges = new Map<number, Edge>();
  readonly faces = new Map<number, Face>();
  readonly curves = new Map<number, CurveInfo>();
  readonly guides = new Map<number, Guide>();
  readonly instances = new Map<number, Instance>();

  private nextId = 1;
  private readonly grid = new Map<string, Vertex[]>();

  // ---- Vertices ------------------------------------------------------------

  /** Existing vertex within TOL of p (other than `exclude`), if any. */
  vertexAt(p: XYZ, exclude?: Vertex): Vertex | undefined {
    const cx = Math.floor(p.x / CELL);
    const cy = Math.floor(p.y / CELL);
    const cz = Math.floor(p.z / CELL);
    let best: Vertex | undefined;
    let bestDist = TOL;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const cell = this.grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!cell) continue;
          for (const v of cell) {
            if (v === exclude) continue;
            const d = v.pos.distanceTo(p);
            if (d <= bestDist) {
              best = v;
              bestDist = d;
            }
          }
        }
    return best;
  }

  /**
   * Returns the vertex at p, creating it if needed. A new vertex must get an edge
   * before the operation ends (see invariants); use addEdge.
   */
  addVertex(p: XYZ): Vertex {
    const existing = this.vertexAt(p);
    if (existing) return existing;
    const v = new Vertex(this.nextId++, Vec3.from(p));
    this.vertices.set(v.id, v);
    this.gridInsert(v);
    return v;
  }

  /** Moves a vertex. The caller is responsible for not landing on another vertex. */
  moveVertex(v: Vertex, p: XYZ): void {
    this.gridRemove(v);
    v.pos = Vec3.from(p);
    this.gridInsert(v);
  }

  /** Removes a vertex that has no edges (e.g. one created by addVertex but not used). */
  pruneVertex(v: Vertex): void {
    if (v.edges.size === 0 && this.vertices.get(v.id) === v) this.removeVertex(v);
  }

  private removeVertex(v: Vertex): void {
    this.gridRemove(v);
    this.vertices.delete(v.id);
  }

  private cellKey(p: XYZ): string {
    return `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)},${Math.floor(p.z / CELL)}`;
  }

  private gridInsert(v: Vertex): void {
    const key = this.cellKey(v.pos);
    const cell = this.grid.get(key);
    if (cell) cell.push(v);
    else this.grid.set(key, [v]);
  }

  private gridRemove(v: Vertex): void {
    const key = this.cellKey(v.pos);
    const cell = this.grid.get(key);
    if (!cell) return;
    const i = cell.indexOf(v);
    if (i >= 0) cell.splice(i, 1);
    if (cell.length === 0) this.grid.delete(key);
  }

  // ---- Edges ---------------------------------------------------------------

  edgeBetween(a: Vertex, b: Vertex): Edge | undefined {
    // Iterate the smaller edge set.
    const [small, other] = a.edges.size <= b.edges.size ? [a, b] : [b, a];
    for (const e of small.edges) if (e.other(small) === other) return e;
    return undefined;
  }

  /** Edge between a and b, creating it if needed. No splitting or face detection. */
  addEdge(a: Vertex, b: Vertex): Edge {
    if (a === b) throw new Error('Edge needs two distinct vertices');
    const existing = this.edgeBetween(a, b);
    if (existing) return existing;
    const e = new Edge(this.nextId++, a, b);
    this.edges.set(e.id, e);
    a.edges.add(e);
    b.edges.add(e);
    return e;
  }

  /** Removes an edge and every face using it. Vertices left without edges are removed too. */
  removeEdge(e: Edge): void {
    for (const f of [...e.faces]) this.removeFace(f);
    this.edges.delete(e.id);
    for (const v of [e.v0, e.v1]) {
      v.edges.delete(e);
      if (v.edges.size === 0) this.removeVertex(v);
    }
  }

  /**
   * Splits edge e at vertex v (which must lie on it), updating face loops.
   * Returns the two new edges [v0–v, v–v1].
   */
  splitEdge(e: Edge, v: Vertex): [Edge, Edge] {
    if (e.has(v)) throw new Error('Cannot split an edge at its own endpoint');
    const { v0, v1 } = e;
    const faces = [...e.faces];
    // Detach e without deleting its faces.
    this.edges.delete(e.id);
    v0.edges.delete(e);
    v1.edges.delete(e);

    const e0 = this.addEdge(v0, v);
    const e1 = this.addEdge(v, v1);
    copyEdgeAttributes(e, e0);
    copyEdgeAttributes(e, e1);
    for (const f of faces) {
      for (const loop of f.loops) {
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i]!;
          const b = loop[(i + 1) % loop.length]!;
          if ((a === v0 && b === v1) || (a === v1 && b === v0)) {
            loop.splice(i + 1, 0, v);
            break;
          }
        }
      }
      e0.faces.add(f);
      e1.faces.add(f);
    }
    return [e0, e1];
  }

  /**
   * Removes vertex v if it joins exactly two collinear edges with the same faces,
   * replacing them with one edge (SketchUp's "healing"). Returns true if it did.
   */
  healVertex(v: Vertex): boolean {
    if (v.edges.size !== 2) return false;
    const [ea, eb] = [...v.edges] as [Edge, Edge];
    const a = ea.other(v);
    const b = eb.other(v);
    const da = a.pos.sub(v.pos);
    const db = b.pos.sub(v.pos);
    // Must point in opposite directions along one line.
    if (da.normalize().dot(db.normalize()) > -1 + 1e-9) return false;
    if (ea.faces.size !== eb.faces.size || [...ea.faces].some((f) => !eb.faces.has(f))) return false;
    if (this.edgeBetween(a, b)) return false;

    const faces = [...ea.faces];
    for (const f of faces) {
      for (const loop of f.loops) {
        const i = loop.indexOf(v);
        if (i >= 0) loop.splice(i, 1);
      }
    }
    const flags = { soft: ea.soft && eb.soft, smooth: ea.smooth && eb.smooth, hidden: ea.hidden && eb.hidden, curve: ea.curve === eb.curve ? ea.curve : 0 };
    for (const e of [ea, eb]) {
      this.edges.delete(e.id);
      e.v0.edges.delete(e);
      e.v1.edges.delete(e);
    }
    this.removeVertex(v);
    const merged = this.addEdge(a, b);
    Object.assign(merged, flags);
    for (const f of faces) merged.faces.add(f);
    return true;
  }

  /**
   * Merges vertex v into `into` (typically because they now coincide): v's edges are
   * reattached to `into`, edges between them disappear, duplicate edges merge, and
   * face loops are updated. Faces whose outer loop collapses are removed.
   */
  weldVertex(v: Vertex, into: Vertex): void {
    if (v === into) return;
    const faces = new Set<Face>();
    for (const e of v.edges) for (const f of e.faces) faces.add(f);
    // Detach the faces from their current edges; they're re-registered once their loops are fixed.
    for (const f of faces) for (const e of this.faceEdges(f)) e.faces.delete(f);

    const old = [...v.edges];
    for (const e of old) {
      this.edges.delete(e.id);
      e.v0.edges.delete(e);
      e.v1.edges.delete(e);
    }
    for (const e of old) {
      const other = e.other(v);
      if (other === into) continue; // the edge between them collapses
      const existed = this.edgeBetween(into, other);
      const target = existed ?? this.addEdge(into, other);
      if (!existed) copyEdgeAttributes(e, target);
    }

    for (const f of faces) {
      const fix = (loop: Vertex[]) => {
        const replaced = loop.map((x) => (x === v ? into : x));
        return replaced.filter((x, i) => x !== replaced[(i + 1) % replaced.length]);
      };
      f.outer = fix(f.outer);
      f.holes = f.holes.map(fix).filter((h) => h.length >= 3);
      if (f.outer.length < 3) {
        this.faces.delete(f.id);
        continue;
      }
      for (const loop of f.loops) {
        for (let i = 0; i < loop.length; i++) this.addEdge(loop[i]!, loop[(i + 1) % loop.length]!).faces.add(f);
      }
    }
    this.removeVertex(v);
  }

  // ---- Instances -----------------------------------------------------------

  addInstance(definition: number, transform: Transform = Transform.IDENTITY): Instance {
    const inst: Instance = { id: this.nextId++, definition, transform };
    this.instances.set(inst.id, inst);
    return inst;
  }

  /**
   * Moves everything in this mesh through an affine transform (used to switch a
   * group's geometry between its own coordinates and world coordinates while it's
   * being edited). Mirroring transforms are not supported.
   */
  applyTransform(t: Transform): void {
    if (t.isIdentity()) return;
    this.grid.clear();
    for (const v of this.vertices.values()) {
      v.pos = t.apply(v.pos);
      this.gridInsert(v);
    }
    for (const f of this.faces.values()) this.updateFaceNormal(f);
    const scale = t.uniformScale();
    for (const [id, c] of this.curves) {
      if (!c.center || !c.normal) continue;
      const center = t.apply(c.center);
      this.curves.set(id, {
        kind: c.kind,
        center: scale === null ? undefined : center,
        normal: scale === null ? undefined : t.applyDir(c.normal).normalize(),
        radius: scale === null || c.radius === undefined ? undefined : c.radius * scale,
      });
    }
    for (const [id, g] of this.guides) {
      this.guides.set(id, g.kind === 'line' ? { ...g, point: t.apply(g.point), dir: t.applyDir(g.dir).normalize() } : { ...g, point: t.apply(g.point) });
    }
    for (const inst of this.instances.values()) inst.transform = t.multiply(inst.transform);
  }

  // ---- Guides --------------------------------------------------------------

  addGuideLine(point: Vec3, dir: Vec3): Guide {
    const g: Guide = { id: this.nextId++, kind: 'line', point, dir: dir.normalize() };
    this.guides.set(g.id, g);
    return g;
  }

  addGuidePoint(point: Vec3): Guide {
    const g: Guide = { id: this.nextId++, kind: 'point', point };
    this.guides.set(g.id, g);
    return g;
  }

  // ---- Curves --------------------------------------------------------------

  addCurve(info: CurveInfo): number {
    const id = this.nextId++;
    this.curves.set(id, info);
    return id;
  }

  /** All edges of a curve. */
  curveEdges(id: number): Edge[] {
    if (!id) return [];
    return [...this.edges.values()].filter((e) => e.curve === id);
  }

  // ---- Faces ---------------------------------------------------------------

  /**
   * Recomputes a face's normal from its outer loop (after its vertices moved).
   * Returns false if the face has become degenerate (no area).
   */
  updateFaceNormal(f: Face): boolean {
    const n = newellNormal(f.outer.map((v) => v.pos));
    if (n.length() < TOL * TOL) return false;
    f.normal = n.normalize();
    // Keep holes clockwise around the (possibly flipped) normal.
    for (const h of f.holes) if (newellNormal(h.map((v) => v.pos)).dot(f.normal) > 0) h.reverse();
    return true;
  }

  /** True if every vertex of the face lies on its plane. */
  isPlanar(f: Face): boolean {
    const n = f.normal;
    const pts = f.vertices.map((v) => v.pos);
    const centroid = pts.reduce((a, p) => a.add(p), new Vec3()).scale(1 / pts.length);
    const plane = Plane.fromPointNormal(centroid, n);
    return pts.every((p) => plane.contains(p));
  }

  /**
   * Adds a face from vertex loops. Missing edges are created. The outer loop is
   * reordered if needed so it runs counter-clockwise around `normal` (holes clockwise).
   * If `normal` is omitted it's derived from the outer loop's winding.
   */
  addFace(outer: Vertex[], holes: Vertex[][] = [], normal?: Vec3): Face {
    if (outer.length < 3) throw new Error('A face needs at least 3 vertices');
    const winding = newellNormal(outer.map((v) => v.pos));
    const n = (normal ?? winding).normalize();
    if (n.lengthSq() === 0) throw new Error('Degenerate face');
    const outerLoop = winding.dot(n) >= 0 ? [...outer] : [...outer].reverse();
    const holeLoops = holes.map((h) => (newellNormal(h.map((v) => v.pos)).dot(n) <= 0 ? [...h] : [...h].reverse()));

    const face = new Face(this.nextId++, outerLoop, holeLoops, n);
    this.faces.set(face.id, face);
    for (const loop of face.loops) {
      for (let i = 0; i < loop.length; i++) {
        this.addEdge(loop[i]!, loop[(i + 1) % loop.length]!).faces.add(face);
      }
    }
    return face;
  }

  /** Removes a face; its edges stay. */
  removeFace(f: Face): void {
    for (const e of this.faceEdges(f)) e.faces.delete(f);
    this.faces.delete(f.id);
  }

  /** Reverses a face's orientation. */
  reverseFace(f: Face): void {
    f.normal = f.normal.negate();
    f.outer.reverse();
    for (const h of f.holes) h.reverse();
  }

  /** Edges of all loops of a face. */
  faceEdges(f: Face): Edge[] {
    const out: Edge[] = [];
    for (const loop of f.loops) {
      for (let i = 0; i < loop.length; i++) {
        const e = this.edgeBetween(loop[i]!, loop[(i + 1) % loop.length]!);
        if (e) out.push(e);
      }
    }
    return out;
  }

  // ---- Queries -------------------------------------------------------------

  /** Edges with both endpoints on the plane. */
  edgesInPlane(plane: Plane): Edge[] {
    const out: Edge[] = [];
    for (const e of this.edges.values()) {
      if (plane.contains(e.v0.pos) && plane.contains(e.v1.pos)) out.push(e);
    }
    return out;
  }

  get isEmpty(): boolean {
    return this.vertices.size === 0 && this.instances.size === 0;
  }

  // ---- Serialization -------------------------------------------------------

  toJSON(): MeshJSON {
    const usedCurves = new Set<number>();
    for (const e of this.edges.values()) if (e.curve) usedCurves.add(e.curve);
    return {
      nextId: this.nextId,
      vertices: [...this.vertices.values()].map((v) => [v.id, v.pos.x, v.pos.y, v.pos.z]),
      edges: [...this.edges.values()].map((e) => [
        e.id,
        e.v0.id,
        e.v1.id,
        (e.soft ? 1 : 0) | (e.smooth ? 2 : 0) | (e.hidden ? 4 : 0),
        e.curve,
      ]),
      // Only curves still in use; curves are dropped once their last edge goes.
      guides: [...this.guides.values()].map((g) => [g.id, g.point.toArray(), g.kind === 'line' ? g.dir.toArray() : null]),
      instances: [...this.instances.values()].map((i) => [i.id, i.definition, i.transform.toArray()]),
      curves: [...this.curves]
        .filter(([id]) => usedCurves.has(id))
        .map(([id, c]) => [id, c.kind, c.center?.toArray() ?? null, c.normal?.toArray() ?? null, c.radius ?? null]),
      faces: [...this.faces.values()].map((f) => [
        f.id,
        f.outer.map((v) => v.id),
        f.holes.map((h) => h.map((v) => v.id)),
        f.normal.toArray(),
      ]),
    };
  }

  /** Replaces all content with the given state (used by undo/redo and file loading). */
  load(json: MeshJSON): void {
    this.vertices.clear();
    this.edges.clear();
    this.faces.clear();
    this.curves.clear();
    this.guides.clear();
    this.instances.clear();
    for (const [id, definition, m] of json.instances ?? []) this.instances.set(id, { id, definition, transform: new Transform(m) });
    for (const [id, p, d] of json.guides ?? []) {
      const point = new Vec3(p[0], p[1], p[2]);
      this.guides.set(id, d ? { id, kind: 'line', point, dir: new Vec3(d[0], d[1], d[2]) } : { id, kind: 'point', point });
    }
    this.grid.clear();
    for (const [id, x, y, z] of json.vertices) {
      const v = new Vertex(id, new Vec3(x, y, z));
      this.vertices.set(id, v);
      this.gridInsert(v);
    }
    const vert = (id: number) => {
      const v = this.vertices.get(id);
      if (!v) throw new Error(`Missing vertex ${id}`);
      return v;
    };
    for (const [id, kind, center, normal, radius] of json.curves ?? []) {
      this.curves.set(id, {
        kind,
        center: center ? new Vec3(center[0], center[1], center[2]) : undefined,
        normal: normal ? new Vec3(normal[0], normal[1], normal[2]) : undefined,
        radius: radius ?? undefined,
      });
    }
    for (const [id, a, b, flags, curve] of json.edges) {
      const e = new Edge(id, vert(a), vert(b));
      e.soft = (flags & 1) !== 0;
      e.smooth = (flags & 2) !== 0;
      e.hidden = (flags & 4) !== 0;
      e.curve = curve && this.curves.has(curve) ? curve : 0;
      this.edges.set(id, e);
      e.v0.edges.add(e);
      e.v1.edges.add(e);
    }
    for (const [id, outer, holes, n] of json.faces) {
      const f = new Face(id, outer.map(vert), holes.map((h) => h.map(vert)), new Vec3(...n));
      this.faces.set(id, f);
      for (const e of this.faceEdges(f)) e.faces.add(f);
    }
    this.nextId = json.nextId;
  }

  /** Checks the invariants; returns a list of problems (empty if valid). For tests and debugging. */
  validate(): string[] {
    const problems: string[] = [];
    for (const v of this.vertices.values()) {
      if (v.edges.size === 0) problems.push(`vertex ${v.id} has no edges`);
      const near = this.vertexAt(v.pos);
      if (near !== v) problems.push(`vertex ${v.id} not found at its own position (near ${near?.id})`);
    }
    for (const e of this.edges.values()) {
      if (!this.vertices.has(e.v0.id) || !this.vertices.has(e.v1.id)) problems.push(`edge ${e.id} has a missing vertex`);
      if (e.v0 === e.v1) problems.push(`edge ${e.id} is degenerate`);
      for (const f of e.faces) if (!this.faces.has(f.id)) problems.push(`edge ${e.id} lists removed face ${f.id}`);
    }
    for (const f of this.faces.values()) {
      const plane = f.plane;
      for (const loop of f.loops) {
        if (loop.length < 3) problems.push(`face ${f.id} has a loop with ${loop.length} vertices`);
        for (let i = 0; i < loop.length; i++) {
          const a = loop[i]!;
          const b = loop[(i + 1) % loop.length]!;
          const e = this.edgeBetween(a, b);
          if (!e) problems.push(`face ${f.id} loop step ${a.id}->${b.id} has no edge`);
          else if (!e.faces.has(f)) problems.push(`edge ${e.id} doesn't list face ${f.id}`);
          if (!plane.contains(a.pos)) problems.push(`face ${f.id} vertex ${a.id} is off its plane`);
        }
      }
      if (newellNormal(f.outer.map((v) => v.pos)).dot(f.normal) <= 0) problems.push(`face ${f.id} outer loop winds the wrong way`);
      for (const h of f.holes) {
        if (newellNormal(h.map((v) => v.pos)).dot(f.normal) >= 0) problems.push(`face ${f.id} hole winds the wrong way`);
      }
    }
    return problems;
  }
}
