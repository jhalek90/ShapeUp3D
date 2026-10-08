import * as THREE from 'three';
import type { Model } from '../core/Model';
import { clearAutosave, readAutosave, writeAutosave } from '../io/autosave';
import { FILE_EXTENSION, parseDocument, serializeDocument, type CameraState } from '../io/document';
import { pickFile, saveFile, type FileHandle } from '../io/files';
import type { LengthFormat } from '../units/length';
import type { CameraController } from '../viewport/CameraController';

const AUTOSAVE_DELAY_MS = 800;

/**
 * The open document: its file name/handle, whether it has unsaved changes, the
 * window title, and crash-recovery autosave.
 */
export class DocumentController {
  private name: string | null = null;
  private handle: FileHandle | undefined;
  private dirty = false;
  private autosaveTimer: number | undefined;
  /** Suppresses marking dirty while loading a document. */
  private loading = false;

  constructor(
    private readonly model: Model,
    private readonly format: LengthFormat,
    private readonly camera: CameraController,
    /** Called after units change because a document was opened. */
    private readonly onUnitsLoaded: () => void,
    private readonly status: (text: string) => void,
  ) {
    model.onChange(() => {
      if (this.loading || model.previewing) return;
      this.markDirty();
    });
    window.addEventListener('beforeunload', () => this.flushAutosave());
    this.updateTitle();
  }

  /** Call when something saved with the document (like units) changes. */
  markDirty(): void {
    this.dirty = true;
    this.updateTitle();
    this.scheduleAutosave();
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Restores the last session's work, if any. */
  async restore(): Promise<void> {
    let record;
    try {
      record = await readAutosave();
    } catch {
      return; // storage unavailable (private browsing etc.)
    }
    if (!record) return;
    try {
      const doc = parseDocument(record.text);
      const root = doc.model.root;
      if (root.vertices.length === 0 && (root.guides?.length ?? 0) === 0 && (root.instances?.length ?? 0) === 0) return;
      this.load(record.text);
      this.name = record.name;
      this.dirty = record.dirty;
      this.updateTitle();
      this.status(`Restored your work from last session${record.name ? ` (${record.name})` : ''}.`);
    } catch {
      // A damaged autosave shouldn't block starting fresh.
    }
  }

  newDocument(): void {
    if (!this.confirmDiscard()) return;
    this.loading = true;
    this.model.replace({ nextId: 1, vertices: [], edges: [], faces: [] });
    this.loading = false;
    this.name = null;
    this.handle = undefined;
    this.dirty = false;
    this.updateTitle();
    void clearAutosave().catch(() => {});
  }

  async open(): Promise<void> {
    if (!this.confirmDiscard()) return;
    const file = await pickFile();
    if (!file) return;
    try {
      this.load(file.text);
    } catch (err) {
      this.status((err as Error).message);
      window.alert((err as Error).message);
      return;
    }
    this.name = file.name;
    this.handle = file.handle;
    this.dirty = false;
    this.updateTitle();
    this.scheduleAutosave();
    this.status(`Opened ${file.name}.`);
  }

  async save(): Promise<void> {
    await this.write(false);
  }

  async saveAs(): Promise<void> {
    await this.write(true);
  }

  private async write(as: boolean): Promise<void> {
    const name = this.name ?? `model${FILE_EXTENSION}`;
    try {
      const result = await saveFile(this.serialize(), name, as ? undefined : this.handle);
      if (!result) return;
      this.name = result.name;
      this.handle = result.handle;
      this.dirty = false;
      this.updateTitle();
      this.scheduleAutosave();
      this.status(result.handle ? `Saved ${result.name}.` : `Downloaded ${result.name}.`);
    } catch (err) {
      this.status(`Couldn't save: ${(err as Error).message}`);
    }
  }

  private load(text: string): void {
    const doc = parseDocument(text);
    this.loading = true;
    try {
      this.model.replace(doc.model);
      this.format.unit = doc.units.unit;
      this.format.precision = doc.units.precision;
      this.onUnitsLoaded();
      if (doc.camera) {
        this.camera.setFov(doc.camera.fov);
        this.camera.setProjection(doc.camera.projection);
        this.camera.lookAt(new THREE.Vector3(...doc.camera.position), new THREE.Vector3(...doc.camera.target));
      }
    } finally {
      this.loading = false;
    }
  }

  private serialize(): string {
    const c = this.camera;
    const camera: CameraState = {
      position: c.position.toArray(),
      target: c.target.toArray(),
      fov: c.fov,
      projection: c.projection,
    };
    return serializeDocument(this.model.toDocumentJSON(), this.format, camera);
  }

  private confirmDiscard(): boolean {
    return !this.dirty || window.confirm('Discard unsaved changes to this model?');
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => this.flushAutosave(), AUTOSAVE_DELAY_MS);
  }

  private flushAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    if (this.model.previewing) {
      this.scheduleAutosave();
      return;
    }
    void writeAutosave({ text: this.serialize(), name: this.name, dirty: this.dirty, savedAt: Date.now() }).catch(() => {});
  }

  private updateTitle(): void {
    document.title = `${this.dirty ? '• ' : ''}${this.name ?? 'Untitled'} — ShapeUp3d`;
  }
}
