import type { Edge, Face, Instance } from '../core/Mesh';
import type { Model } from '../core/Model';

/** Something selectable: a face or edge of the mesh being edited, or a group/component in it. */
export type Entity = Face | Edge | Instance;

const key = (e: Entity) => ('outer' in e ? `f${e.id}` : 'v0' in e ? `e${e.id}` : `i${e.id}`);

/**
 * The selected faces, edges and groups/components, in the mesh being edited.
 * Stored by id so it survives undo/redo and live previews (which rebuild entity
 * objects); entities that disappear drop out, and entering or leaving a group
 * clears it.
 */
export class Selection {
  private ids = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private context = '';

  constructor(private readonly model: Model) {
    // Live previews rebuild the model constantly; only prune once things settle.
    model.onChange(() => {
      if (model.previewing) return;
      const context = model.editPath.join('/');
      if (context !== this.context) {
        this.context = context;
        this.clear();
      } else {
        this.prune();
      }
    });
  }

  get faces(): Face[] {
    return this.resolve('f', (id) => this.model.active.faces.get(id));
  }

  get edges(): Edge[] {
    return this.resolve('e', (id) => this.model.active.edges.get(id));
  }

  get instances(): Instance[] {
    return this.resolve('i', (id) => this.model.active.instances.get(id));
  }

  get size(): number {
    return this.ids.size;
  }

  get isEmpty(): boolean {
    return this.ids.size === 0;
  }

  has(e: Entity): boolean {
    return this.ids.has(key(e));
  }

  set(entities: Iterable<Entity>): void {
    this.ids = new Set([...entities].map(key));
    this.changed();
  }

  add(entities: Iterable<Entity>): void {
    for (const e of entities) this.ids.add(key(e));
    this.changed();
  }

  remove(entities: Iterable<Entity>): void {
    for (const e of entities) this.ids.delete(key(e));
    this.changed();
  }

  toggle(entities: Iterable<Entity>): void {
    for (const e of entities) {
      const k = key(e);
      if (this.ids.has(k)) this.ids.delete(k);
      else this.ids.add(k);
    }
    this.changed();
  }

  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private resolve<T>(kind: string, get: (id: number) => T | undefined): T[] {
    const out: T[] = [];
    for (const id of this.ids) {
      if (id[0] !== kind) continue;
      const x = get(Number(id.slice(1)));
      if (x) out.push(x);
    }
    return out;
  }

  private prune(): void {
    const mesh = this.model.active;
    const before = this.ids.size;
    for (const id of this.ids) {
      const n = Number(id.slice(1));
      const exists = id[0] === 'f' ? mesh.faces.has(n) : id[0] === 'e' ? mesh.edges.has(n) : mesh.instances.has(n);
      if (!exists) this.ids.delete(id);
    }
    if (this.ids.size !== before) this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
