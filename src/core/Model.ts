import { Transform } from './affine';
import { Mesh, type Instance, type MeshJSON } from './Mesh';

const MAX_UNDO = 200;

export type DefinitionKind = 'group' | 'component';

/**
 * The geometry behind groups and components. A group's definition is used by one
 * instance; a component's is shared, so editing one copy edits them all.
 */
export interface Definition {
  id: number;
  name: string;
  kind: DefinitionKind;
  mesh: Mesh;
  /**
   * Set while this definition is being edited: its geometry has been moved into
   * world coordinates by this transform (so every tool can work on it directly).
   */
  frame?: Transform;
}

export interface DefinitionJSON {
  id: number;
  name: string;
  kind: DefinitionKind;
  mesh: MeshJSON;
  frame?: number[];
}

export interface ModelJSON {
  root: MeshJSON;
  definitions: DefinitionJSON[];
  nextDefinitionId: number;
  /** Instance ids from the root down to the group being edited. */
  editPath: number[];
}

interface Snapshot {
  name: string;
  state: ModelJSON;
}

/**
 * The document: geometry (the root mesh plus group/component definitions), the
 * group being edited, and undo history. Every change goes through `transact`.
 *
 * Editing inside a group: `enter` moves the group's geometry into world
 * coordinates (recording `frame`), so tools work on `active` without knowing about
 * transforms; `exit` moves it back. History stores whole-model snapshots.
 */
export class Model {
  /** The top level of the model. */
  readonly mesh = new Mesh();
  readonly definitions = new Map<number, Definition>();
  private nextDefinitionId = 1;
  private path: number[] = [];

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private readonly listeners = new Set<() => void>();
  private _version = 0;
  private previewBase: ModelJSON | null = null;

  /** Increments on every change; renderers compare it to know when to rebuild. */
  get version(): number {
    return this._version;
  }

  // ---- Edit context ----------------------------------------------------------

  /** Instance ids from the root down to the group being edited ([] at top level). */
  get editPath(): readonly number[] {
    return this.path;
  }

  /** The mesh being edited: the root, or the open group's (world-coordinate) geometry. */
  get active(): Mesh {
    return this.activeDefinition?.mesh ?? this.mesh;
  }

  get activeDefinition(): Definition | null {
    let mesh = this.mesh;
    let def: Definition | null = null;
    for (const id of this.path) {
      const inst = mesh.instances.get(id);
      const d = inst && this.definitions.get(inst.definition);
      if (!d) return def;
      def = d;
      mesh = d.mesh;
    }
    return def;
  }

  /** Opens a group/component (an instance in the active mesh) for editing. */
  enter(instanceId: number): void {
    const inst = this.active.instances.get(instanceId);
    const def = inst && this.definitions.get(inst.definition);
    if (!inst || !def || def.frame) return;
    this.endPreview();
    def.mesh.applyTransform(inst.transform);
    def.frame = inst.transform;
    this.path.push(instanceId);
    this.changed();
  }

  /** Closes the innermost open group. Returns false if already at the top level. */
  exit(): boolean {
    const def = this.activeDefinition;
    if (!def) return false;
    this.endPreview();
    if (def.frame) def.mesh.applyTransform(def.frame.inverse());
    def.frame = undefined;
    this.path.pop();
    this.changed();
    return true;
  }

  exitAll(): void {
    while (this.exit());
  }

  addDefinition(kind: DefinitionKind, name?: string): Definition {
    const id = this.nextDefinitionId++;
    const def: Definition = { id, name: name ?? `${kind === 'group' ? 'Group' : 'Component'} ${id}`, kind, mesh: new Mesh() };
    this.definitions.set(id, def);
    return def;
  }

  /** Number of instances of a definition anywhere in the model. */
  instanceCount(definitionId: number): number {
    let n = 0;
    const count = (m: Mesh) => {
      for (const inst of m.instances.values()) if (inst.definition === definitionId) n++;
    };
    count(this.mesh);
    for (const d of this.definitions.values()) count(d.mesh);
    return n;
  }

  /**
   * Visits every mesh in the model with the transform taking its stored
   * coordinates to world coordinates, and the chain of instances leading to it.
   */
  traverse(visit: (mesh: Mesh, toWorld: Transform, path: readonly Instance[]) => void): void {
    const walk = (mesh: Mesh, toWorld: Transform, path: Instance[]) => {
      visit(mesh, toWorld, path);
      for (const inst of mesh.instances.values()) {
        const def = this.definitions.get(inst.definition);
        if (!def || path.some((p) => p.definition === def.id)) continue; // guard against cycles
        // A definition being edited stores world coordinates: undo its frame first.
        let t = toWorld.multiply(inst.transform);
        if (def.frame) t = t.multiply(def.frame.inverse());
        walk(def.mesh, t, [...path, inst]);
      }
    };
    walk(this.mesh, Transform.IDENTITY, []);
  }

  // ---- Transactions ----------------------------------------------------------

  /**
   * Runs `fn` on the active mesh as one undoable operation. If it throws, the
   * model is restored.
   */
  transact<T>(name: string, fn: (mesh: Mesh, model: Model) => T): T {
    this.endPreview();
    const before = this.toJSON();
    let result: T;
    try {
      result = fn(this.active, this);
    } catch (err) {
      this.load(before);
      this.changed();
      throw err;
    }
    if (!sameContent(before, this.toJSON())) {
      this.undoStack.push({ name, state: before });
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack = [];
      this.changed();
    }
    return result;
  }

  get undoName(): string | null {
    return this.undoStack.at(-1)?.name ?? null;
  }

  get redoName(): string | null {
    return this.redoStack.at(-1)?.name ?? null;
  }

  /** Undoes the last operation; returns its name, or null if there was nothing to undo. */
  undo(): string | null {
    this.endPreview();
    const snap = this.undoStack.pop();
    if (!snap) return null;
    this.redoStack.push({ name: snap.name, state: this.toJSON() });
    this.load(snap.state);
    this.changed();
    return snap.name;
  }

  redo(): string | null {
    this.endPreview();
    const snap = this.redoStack.pop();
    if (!snap) return null;
    this.undoStack.push({ name: snap.name, state: this.toJSON() });
    this.load(snap.state);
    this.changed();
    return snap.name;
  }

  // ---- Live previews -------------------------------------------------------
  // A tool dragging an operation (Push/Pull, Move, ...) shows its result live:
  // beginPreview remembers the model, showPreview re-applies the operation from that
  // state on every mouse move, and endPreview puts the model back. The final
  // operation is then committed with transact, so it's one clean undo step.

  get previewing(): boolean {
    return this.previewBase !== null;
  }

  beginPreview(): void {
    this.previewBase ??= this.toJSON();
  }

  /** Restores the state from beginPreview, then applies `fn` (if given) on the active mesh. */
  showPreview(fn?: (mesh: Mesh, model: Model) => void): void {
    if (!this.previewBase) return;
    this.load(this.previewBase);
    if (fn) {
      try {
        fn(this.active, this);
      } catch (err) {
        this.load(this.previewBase);
        console.warn('Preview failed', err);
      }
    }
    this.changed();
  }

  endPreview(): void {
    if (!this.previewBase) return;
    this.load(this.previewBase);
    this.previewBase = null;
    this.changed();
  }

  // ---- Serialization ---------------------------------------------------------

  /** Exact current state, including any open group (used for undo and previews). */
  toJSON(): ModelJSON {
    return {
      root: this.mesh.toJSON(),
      definitions: [...this.definitions.values()].map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        mesh: d.mesh.toJSON(),
        frame: d.frame?.toArray(),
      })),
      nextDefinitionId: this.nextDefinitionId,
      editPath: [...this.path],
    };
  }

  /**
   * The model as it should be saved: groups closed (geometry back in their own
   * coordinates) and definitions nothing uses any more dropped.
   */
  toDocumentJSON(): ModelJSON {
    const used = new Set<number>();
    const mark = (m: Mesh) => {
      for (const inst of m.instances.values()) {
        if (used.has(inst.definition)) continue;
        used.add(inst.definition);
        const d = this.definitions.get(inst.definition);
        if (d) mark(d.mesh);
      }
    };
    mark(this.mesh);
    const definitions: DefinitionJSON[] = [];
    for (const d of this.definitions.values()) {
      if (!used.has(d.id)) continue;
      let mesh = d.mesh.toJSON();
      if (d.frame) {
        const local = new Mesh();
        local.load(mesh);
        local.applyTransform(d.frame.inverse());
        mesh = local.toJSON();
      }
      definitions.push({ id: d.id, name: d.name, kind: d.kind, mesh });
    }
    return { root: this.mesh.toJSON(), definitions, nextDefinitionId: this.nextDefinitionId, editPath: [] };
  }

  private load(json: ModelJSON): void {
    this.mesh.load(json.root);
    this.definitions.clear();
    for (const d of json.definitions) {
      const mesh = new Mesh();
      mesh.load(d.mesh);
      this.definitions.set(d.id, { id: d.id, name: d.name, kind: d.kind, mesh, frame: d.frame ? new Transform(d.frame) : undefined });
    }
    this.nextDefinitionId = json.nextDefinitionId;
    this.path = [...json.editPath];
  }

  /** Replaces the whole model (opening a file, New); clears undo history. */
  replace(state: ModelJSON | MeshJSON): void {
    this.previewBase = null;
    this.load(isModelJSON(state) ? state : { root: state, definitions: [], nextDefinitionId: 1, editPath: [] });
    this.undoStack = [];
    this.redoStack = [];
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this._version++;
    for (const fn of this.listeners) fn();
  }
}

export function isModelJSON(x: ModelJSON | MeshJSON): x is ModelJSON {
  return 'root' in x;
}

function sameContent(a: ModelJSON, b: ModelJSON): boolean {
  // nextId counters don't matter: something created and removed again is no change.
  const strip = (m: MeshJSON) => [m.vertices, m.edges, m.faces, m.guides, m.instances, m.curves];
  const key = (s: ModelJSON) =>
    JSON.stringify([strip(s.root), s.definitions.map((d) => [d.id, d.name, d.kind, strip(d.mesh), d.frame]), s.editPath]);
  return key(a) === key(b);
}
