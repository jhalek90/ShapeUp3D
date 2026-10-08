import { buildFromTriangles } from '../core/importMesh';
import type { Vec3 } from '../core/math';
import type { Mesh } from '../core/Mesh';
import type { Model } from '../core/Model';
import { analyzeModel, isWatertight, modelTriangles, orientFaces, type PartReport } from '../core/solid';
import { parseSTL, writeAsciiSTL, writeBinarySTL, type Triangle } from '../core/stl';
import { pickFile, saveFile, STL_FILE } from '../io/files';
import { selectRow, showDialog } from '../ui/Dialog';
import type { Selection } from './Selection';

type ExportUnit = 'mm' | 'in';
type ImportUnit = 'mm' | 'cm' | 'm' | 'in';
const IMPORT_SCALE: Record<ImportUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

/**
 * STL export (with a printability check and a fix for reversed faces) and import
 * (into a group, rebuilt as editable faces).
 */
export class StlController {
  /** World-space edges to show as problems (open edges), until the model changes. */
  problems: [Vec3, Vec3][] = [];

  constructor(
    private readonly model: Model,
    private readonly selection: Selection,
    private readonly docName: () => string | null,
    private readonly status: (text: string) => void,
    private readonly afterImport: () => void,
  ) {
    model.onChange(() => {
      if (!model.previewing) this.problems = [];
    });
  }

  async exportStl(): Promise<void> {
    const hasSelection = this.selection.faces.length > 0 || this.selection.instances.length > 0;
    const body = document.createElement('div');
    const format = selectRow('Format', [
      { value: 'binary', label: 'Binary (smaller, recommended)' },
      { value: 'ascii', label: 'ASCII (text)' },
    ], 'binary');
    const units = selectRow<ExportUnit>('Units', [
      { value: 'mm', label: 'Millimetres (slicers expect this)' },
      { value: 'in', label: 'Inches' },
    ], 'mm');
    const scope = selectRow('Export', [
      { value: 'all', label: 'Whole model' },
      ...(hasSelection ? [{ value: 'selection', label: 'Selection only' }] : []),
    ], hasSelection ? 'selection' : 'all');
    const report = document.createElement('div');
    body.append(format.row, units.row, scope.row, report);

    let action: 'export' | 'show' | null = null;
    const render = () => {
      report.replaceChildren(this.reportElement(analyzeModel(this.model), () => {
        // Fix reversed faces everywhere, then re-check.
        const flipped = this.model.transact(
          'Fix Reversed Faces',
          (_m, model) => {
            let n = 0;
            const meshes: Mesh[] = [model.mesh, ...[...model.definitions.values()].map((d) => d.mesh)];
            for (const mesh of meshes) n += orientFaces(mesh);
            return n;
          },
          { scope: 'all' },
        );
        this.status(`Turned ${flipped} reversed face${flipped === 1 ? '' : 's'} the right way out.`);
        render();
      }));
    };
    render();
    const parts = analyzeModel(this.model);
    const anyOpen = parts.some((p) => p.openEdges.length > 0 || p.tangledEdges.length > 0);
    action = await showDialog('Export STL', body, [
      ...(anyOpen ? [{ label: 'Show problems', value: 'show' as const }] : []),
      { label: 'Cancel', value: null },
      { label: 'Export', value: 'export' as const, primary: true },
    ]);
    if (action === 'show') {
      this.showProblems();
      return;
    }
    if (action !== 'export') return;

    const only = scope.select.value === 'selection'
      ? { faceIds: new Set(this.selection.faces.map((f) => f.id)), instanceIds: new Set(this.selection.instances.map((i) => i.id)) }
      : undefined;
    let tris = modelTriangles(this.model, only);
    if (tris.length === 0) {
      this.status('Nothing to export: there are no faces.');
      return;
    }
    if (units.select.value === 'in') tris = tris.map((t) => t.map((p) => p.scale(1 / 25.4)) as Triangle);
    const base = (this.docName() ?? 'model').replace(/\.[^.]+$/, '');
    const data = format.select.value === 'ascii' ? writeAsciiSTL(tris, base) : new Blob([writeBinarySTL(tris)], { type: 'model/stl' });
    try {
      const saved = await saveFile(data, `${base}.stl`, undefined, STL_FILE);
      if (saved) this.status(`Exported ${tris.length.toLocaleString()} triangles to ${saved.name}.`);
    } catch (err) {
      this.status(`Couldn't export: ${(err as Error).message}`);
    }
  }

  async importStl(): Promise<void> {
    const picked = await pickFile(STL_FILE);
    if (!picked) return;
    let tris: Triangle[];
    try {
      tris = parseSTL(await picked.file.arrayBuffer());
    } catch (err) {
      window.alert((err as Error).message);
      return;
    }
    const body = document.createElement('div');
    const note = document.createElement('p');
    note.className = 'dialog-note';
    note.textContent = `${picked.name}: ${tris.length.toLocaleString()} triangles. STL files don't record units; most are in millimetres.`;
    const units = selectRow<ImportUnit>('File units', [
      { value: 'mm', label: 'Millimetres' },
      { value: 'cm', label: 'Centimetres' },
      { value: 'm', label: 'Metres' },
      { value: 'in', label: 'Inches' },
    ], 'mm');
    body.append(note, units.row);
    const ok = await showDialog('Import STL', body, [
      { label: 'Cancel', value: false },
      { label: 'Import', value: true, primary: true },
    ]);
    if (!ok) return;
    const scale = IMPORT_SCALE[units.select.value as ImportUnit];
    const name = picked.name.replace(/\.stl$/i, '');
    const result = this.model.transact('Import STL', (m, model) => {
      const def = model.addDefinition('group', name);
      const stats = buildFromTriangles(def.mesh, tris, scale);
      return { stats, instance: m.addInstance(def.id) };
    });
    this.selection.set([result.instance]);
    const { faces, skipped } = result.stats;
    this.status(`Imported ${name}: ${tris.length.toLocaleString()} triangles became ${faces.toLocaleString()} faces${skipped ? ` (${skipped} degenerate skipped)` : ''}.`);
    this.afterImport();
  }

  /** Marks open edges of every part in red (cleared on the next change). */
  showProblems(): void {
    const segs: [Vec3, Vec3][] = [];
    const seen = new Set<Mesh>();
    this.model.traverse((mesh, t) => {
      if (seen.has(mesh)) return;
      seen.add(mesh);
      for (const e of mesh.edges.values()) {
        if (e.faces.size === 1 || (e.faces.size > 2 && e.faces.size % 2 === 1)) segs.push([t.apply(e.v0.pos), t.apply(e.v1.pos)]);
      }
    });
    this.problems = segs;
    this.status(`${segs.length} problem edge${segs.length === 1 ? '' : 's'} shown in red. They border only one face (a gap in the surface).`);
  }

  private reportElement(parts: PartReport[], fix: () => void): HTMLElement {
    const box = document.createElement('div');
    box.className = 'dialog-parts';
    if (parts.length === 0) {
      box.textContent = 'The model has no faces yet.';
      return box;
    }
    let anyReversed = false;
    for (const p of parts) {
      const line = document.createElement('div');
      const vol = `${(Math.abs(p.volume) / 1000).toFixed(2)} cm³`;
      if (isWatertight(p)) {
        line.innerHTML = `<span class="ok">✓</span> ${escape(p.name)}: watertight, ${vol}`;
      } else {
        const issues: string[] = [];
        if (p.openEdges.length) issues.push(`${p.openEdges.length} open edge${p.openEdges.length === 1 ? '' : 's'} (gaps)`);
        if (p.tangledEdges.length) issues.push(`${p.tangledEdges.length} tangled edge${p.tangledEdges.length === 1 ? '' : 's'}`);
        if (p.reversedEdges.length) {
          issues.push('reversed faces');
          anyReversed = true;
        }
        line.innerHTML = `<span class="bad">⚠</span> ${escape(p.name)}: ${issues.join(', ')}`;
      }
      box.append(line);
    }
    if (anyReversed) {
      const btn = document.createElement('button');
      btn.className = 'dialog-inline-btn';
      btn.textContent = 'Fix reversed faces';
      btn.addEventListener('click', fix);
      box.append(btn);
    }
    return box;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
