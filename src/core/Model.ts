import { Mesh, type MeshJSON } from './Mesh';

const MAX_UNDO = 200;

interface Snapshot {
  name: string;
  state: MeshJSON;
}

/**
 * The document: geometry plus undo history. Every change goes through
 * `transact`, which makes it one undoable step.
 *
 * History stores whole-mesh snapshots. Simple and robust; fine for typical print
 * models. Can be replaced with diffs later without changing callers.
 */
export class Model {
  readonly mesh = new Mesh();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private readonly listeners = new Set<() => void>();
  private _version = 0;
  private previewBase: MeshJSON | null = null;

  /** Increments on every change; renderers compare it to know when to rebuild. */
  get version(): number {
    return this._version;
  }

  /** Runs `fn` as one undoable operation. If it throws, the model is restored. */
  transact<T>(name: string, fn: (mesh: Mesh) => T): T {
    this.endPreview();
    const before = this.mesh.toJSON();
    let result: T;
    try {
      result = fn(this.mesh);
    } catch (err) {
      this.mesh.load(before);
      this.changed();
      throw err;
    }
    if (!sameContent(before, this.mesh.toJSON())) {
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
    this.redoStack.push({ name: snap.name, state: this.mesh.toJSON() });
    this.mesh.load(snap.state);
    this.changed();
    return snap.name;
  }

  redo(): string | null {
    this.endPreview();
    const snap = this.redoStack.pop();
    if (!snap) return null;
    this.undoStack.push({ name: snap.name, state: this.mesh.toJSON() });
    this.mesh.load(snap.state);
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
    this.previewBase ??= this.mesh.toJSON();
  }

  /** Restores the state from beginPreview, then applies `fn` (if given) on top. */
  showPreview(fn?: (mesh: Mesh) => void): void {
    if (!this.previewBase) return;
    this.mesh.load(this.previewBase);
    if (fn) {
      try {
        fn(this.mesh);
      } catch (err) {
        this.mesh.load(this.previewBase);
        console.warn('Preview failed', err);
      }
    }
    this.changed();
  }

  endPreview(): void {
    if (!this.previewBase) return;
    this.mesh.load(this.previewBase);
    this.previewBase = null;
    this.changed();
  }

  /** Replaces the whole model (opening a file, New); clears undo history. */
  replace(state: MeshJSON): void {
    this.endPreview();
    this.mesh.load(state);
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

function sameContent(a: MeshJSON, b: MeshJSON): boolean {
  // nextId doesn't matter: a vertex created and removed again is no change.
  return JSON.stringify([a.vertices, a.edges, a.faces, a.guides]) === JSON.stringify([b.vertices, b.edges, b.faces, b.guides]);
}
