import type { Edge, Face } from '../core/Mesh';
import type { Model } from '../core/Model';

export type Entity = Face | Edge;

const key = (e: Entity) => ('outer' in e ? `f${e.id}` : `e${e.id}`);

/**
 * The selected faces and edges. Stored by id so it survives undo/redo and live
 * previews (which rebuild entity objects); entities that disappear drop out.
 */
export class Selection {
  private ids = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly model: Model) {
    // Live previews rebuild the model constantly; only prune once things settle.
    model.onChange(() => {
      if (!model.previewing) this.prune();
    });
  }

  get faces(): Face[] {
    const out: Face[] = [];
    for (const id of this.ids) {
      if (id[0] !== 'f') continue;
      const f = this.model.mesh.faces.get(Number(id.slice(1)));
      if (f) out.push(f);
    }
    return out;
  }

  get edges(): Edge[] {
    const out: Edge[] = [];
    for (const id of this.ids) {
      if (id[0] !== 'e') continue;
      const e = this.model.mesh.edges.get(Number(id.slice(1)));
      if (e) out.push(e);
    }
    return out;
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

  private prune(): void {
    const mesh = this.model.mesh;
    const before = this.ids.size;
    for (const id of this.ids) {
      const n = Number(id.slice(1));
      if (id[0] === 'f' ? !mesh.faces.has(n) : !mesh.edges.has(n)) this.ids.delete(id);
    }
    if (this.ids.size !== before) this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
