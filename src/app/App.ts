import * as THREE from 'three';
import { Vec3 } from '../core/math';
import { Model } from '../core/Model';
import { explode, makeGroup } from '../core/groups';
import { eraseEdges, eraseFaces } from '../core/ops';
import { ForeignCache, type ForeignGeometry } from '../core/scene';
import { InferenceEngine, viewFromCamera } from '../inference/InferenceEngine';
import { ArcTool } from '../tools/ArcTool';
import { CircleTool } from '../tools/CircleTool';
import { EraserTool } from '../tools/EraserTool';
import { LineTool } from '../tools/LineTool';
import { MoveTool } from '../tools/MoveTool';
import { OrbitTool, PanTool, ZoomTool } from '../tools/navigationTools';
import { OffsetTool } from '../tools/OffsetTool';
import { PushPullTool } from '../tools/PushPullTool';
import { RectangleTool } from '../tools/RectangleTool';
import { ProtractorTool } from '../tools/ProtractorTool';
import { RotateTool } from '../tools/RotateTool';
import { ScaleTool } from '../tools/ScaleTool';
import { TapeMeasureTool } from '../tools/TapeMeasureTool';
import { GuideRenderer } from '../viewport/GuideRenderer';
import { SelectTool } from '../tools/SelectTool';
import type { ToolContext } from '../tools/Tool';
import { ToolManager } from '../tools/ToolManager';
import { Menu, type MenuItem } from '../ui/Menu';
import { StatusBar } from '../ui/StatusBar';
import { Toolbar, type ToolbarItem } from '../ui/Toolbar';
import type { LengthFormat } from '../units/length';
import { CameraController, type StandardView } from '../viewport/CameraController';
import { InputRouter } from '../viewport/InputRouter';
import { ModelRenderer } from '../viewport/ModelRenderer';
import { Overlay } from '../viewport/Overlay';
import { Viewport } from '../viewport/Viewport';
import { DocumentController } from './DocumentController';
import { StlController } from './StlController';
import { Selection } from './Selection';

/** Characters that start typing into the Measurements box. */
const MEASUREMENT_START = /^[0-9.,;'"\-+/x*]$/;

export class App {
  readonly format: LengthFormat = { unit: 'mm', precision: 2 };
  readonly model = new Model();
  readonly selection = new Selection(this.model);
  readonly camera = new CameraController();
  readonly viewport: Viewport;
  readonly tools: ToolManager;
  private readonly statusBar: StatusBar;
  private readonly shortcuts: Record<string, () => void>;
  readonly document: DocumentController;
  readonly stl: StlController;

  constructor() {
    this.viewport = new Viewport(byId('viewport'), this.camera);
    this.statusBar = new StatusBar(this.format.unit);

    const renderer = new ModelRenderer(this.model, this.viewport.modelRoot);
    const guides = new GuideRenderer(this.model, this.viewport.scene, this.camera);
    this.viewport.beforeRender.push(() => {
      renderer.update();
      guides.update();
    });
    this.selection.onChange(() => renderer.setHighlight('selection', this.selection.faces, this.selection.edges, this.selection.instances));
    const overlay = new Overlay(byId('viewport'), this.camera);
    this.viewport.afterRender.push(() => {
      overlay.begin();
      guides.drawPoints(overlay);
      for (const [a, b] of this.stl.problems) overlay.line(a, b, { color: '#e02424', width: 3 });
      this.tools.draw(overlay);
    });

    const ctx: ToolContext = {
      model: this.model,
      viewport: this.viewport,
      camera: this.camera,
      inference: new InferenceEngine(() => this.snapSources(), viewFromCamera(this.camera, () => this.viewport.size)),
      selection: this.selection,
      format: this.format,
      highlight: (faces = [], edges = [], instances = []) => renderer.setHighlight('hover', faces, edges, instances),
      facing: () => Vec3.from(this.camera.forward).negate(),
      setStatus: (text) => this.statusBar.setHint(text),
      setMeasurement: (label, value) => this.statusBar.setMeasurement(label, value),
      setCursor: (cursor) => (this.viewport.canvas.style.cursor = cursor),
    };
    this.tools = new ToolManager(ctx);
    this.tools.register(
      new SelectTool(),
      new EraserTool(),
      new LineTool(),
      new ArcTool(),
      new RectangleTool(),
      new CircleTool('circle', 'Circle', 'C', 'circle', 24),
      new CircleTool('polygon', 'Polygon', undefined, 'polygon', 6),
      new OffsetTool(),
      new PushPullTool(),
      new MoveTool(),
      new RotateTool(),
      new ScaleTool(),
      new TapeMeasureTool(),
      new ProtractorTool(),
      new OrbitTool(),
      new PanTool(),
      new ZoomTool(),
    );

    new Toolbar(byId('toolbar'), this.toolbarItems(), this.tools);
    new InputRouter(this.viewport, this.tools);

    this.shortcuts = {
      Space: () => this.tools.activate('select'),
      E: () => this.tools.activate('eraser'),
      L: () => this.tools.activate('line'),
      R: () => this.tools.activate('rectangle'),
      A: () => this.tools.activate('arc'),
      C: () => this.tools.activate('circle'),
      F: () => this.tools.activate('offset'),
      P: () => this.tools.activate('pushpull'),
      M: () => this.tools.activate('move'),
      Q: () => this.tools.activate('rotate'),
      S: () => this.tools.activate('scale'),
      T: () => this.tools.activate('tape'),
      Delete: () => this.eraseSelection(),
      G: () => this.makeGroup('component'),
      'Ctrl+G': () => this.makeGroup('group'),
      'Ctrl+A': () => this.selectAll(),
      // (Browsers reserve Ctrl+T / Ctrl+N, so these differ from SketchUp.)
      'Ctrl+Shift+A': () => this.selection.clear(),
      'Ctrl+O': () => void this.document.open(),
      'Ctrl+S': () => void this.document.save(),
      'Ctrl+Shift+S': () => void this.document.saveAs(),
      'Ctrl+E': () => void this.stl.exportStl(),
      O: () => this.tools.activate('orbit'),
      H: () => this.tools.activate('pan'),
      Z: () => this.tools.activate('zoom'),
      'Shift+Z': () => this.zoomExtents(),
      'Ctrl+Z': () => this.undo(),
      'Ctrl+Y': () => this.redo(),
      'Ctrl+Shift+Z': () => this.redo(),
    };

    this.statusBar.onSubmit = (text) => this.enterMeasurement(text);
    this.statusBar.onEscape = () => this.tools.cancel();
    this.document = new DocumentController(
      this.model,
      this.format,
      this.camera,
      () => this.statusBar.setUnit(this.format.unit),
      (text) => this.statusBar.setHint(text),
    );
    this.stl = new StlController(
      this.model,
      this.selection,
      () => this.document.fileName,
      (text) => this.statusBar.setHint(text),
      () => this.zoomExtents(),
    );
    this.statusBar.onUnitsChange = (unit) => {
      this.format.unit = unit;
      this.document.markDirty();
    };

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => {
      if (!isEditable(e.target)) this.tools.keyUp(e);
    });

    // Say which group is open, if any.
    let context = '';
    this.model.onChange(() => {
      const path = this.model.editPath.join('/');
      if (path === context) return;
      context = path;
      const def = this.model.activeDefinition;
      this.statusBar.setHint(def ? `Editing ${def.name}. Click outside it or press Esc to close.` : 'Closed the group.');
    });

    this.tools.activate('select');
    void this.document.restore();
  }

  private readonly foreignCache = new ForeignCache();
  private foreign: ForeignGeometry | undefined;
  private foreignVersion = -1;

  /** What snapping sees: the mesh being edited, and everything else in world coordinates. */
  private snapSources(): { active: import('../core/Mesh').Mesh; foreign?: ForeignGeometry } {
    // Live previews only change the active mesh, so the outside stays valid while they run.
    if (!this.model.previewing && this.foreignVersion !== this.model.version) {
      this.foreign = this.foreignCache.build(this.model);
      this.foreignVersion = this.model.version;
    }
    return { active: this.model.active, foreign: this.foreign };
  }

  makeGroup(kind: 'group' | 'component'): void {
    const { faces, edges, instances } = this.selection;
    if (faces.length + edges.length + instances.length === 0) {
      this.statusBar.setHint(`Select something first to make a ${kind}.`);
      return;
    }
    this.tools.cancel();
    const inst = this.model.transact(kind === 'group' ? 'Make Group' : 'Make Component', (m, model) => makeGroup(model, m, faces, edges, instances, kind));
    if (inst) this.selection.set([inst]);
  }

  explodeSelection(): void {
    const instances = this.selection.instances;
    if (instances.length === 0) {
      this.statusBar.setHint('Select a group or component to explode.');
      return;
    }
    this.tools.cancel();
    this.model.transact('Explode', (m, model) => {
      for (const inst of instances) explode(model, m, inst);
    });
    this.selection.clear();
  }

  zoomExtents(): void {
    // Measure the model itself (the rendered copy may be a frame behind), groups included.
    const pts: THREE.Vector3[] = [];
    this.model.traverse((mesh, t) => {
      for (const v of mesh.vertices.values()) {
        const p = t.apply(v.pos);
        pts.push(new THREE.Vector3(p.x, p.y, p.z));
      }
    });
    if (pts.length === 0) {
      this.camera.zoomExtents(this.viewport.extentsSphere());
      return;
    }
    const box = new THREE.Box3().setFromPoints(pts);
    this.camera.zoomExtents(box.getBoundingSphere(new THREE.Sphere()));
  }

  setView(view: StandardView): void {
    this.camera.setStandardView(view);
  }

  eraseSelection(): void {
    if (this.selection.isEmpty) return;
    const { faces, edges, instances } = this.selection;
    this.tools.cancel();
    this.model.transact('Erase', (m) => {
      eraseFaces(m, faces);
      eraseEdges(m, edges);
      for (const inst of instances) m.instances.delete(inst.id);
    });
    this.selection.clear();
  }

  deleteGuides(): void {
    this.model.transact(
      'Delete Guides',
      (_m, model) => {
        model.mesh.guides.clear();
        for (const d of model.definitions.values()) d.mesh.guides.clear();
      },
      { scope: 'all' },
    );
  }

  selectAll(): void {
    const m = this.model.active;
    this.selection.set([...m.faces.values(), ...[...m.edges.values()].filter((e) => !e.hidden), ...m.instances.values()]);
  }

  undo(): void {
    this.tools.cancel(); // an operation in progress is abandoned first, like SketchUp
    const name = this.model.undo();
    this.statusBar.setHint(name ? `Undo ${name}` : 'Nothing to undo');
  }

  redo(): void {
    this.tools.cancel();
    const name = this.model.redo();
    this.statusBar.setHint(name ? `Redo ${name}` : 'Nothing to redo');
  }

  private toolbarItems(): ToolbarItem[] {
    const view = (label: string, view: StandardView): MenuItem => ({ label, run: () => this.setView(view) });
    const cameraMenu = new Menu('Camera', [
      view('Iso', 'iso'),
      view('Top', 'top'),
      view('Bottom', 'bottom'),
      view('Front', 'front'),
      view('Back', 'back'),
      view('Left', 'left'),
      view('Right', 'right'),
      { separator: true },
      {
        label: 'Parallel Projection',
        run: () => this.camera.setProjection('parallel'),
        checked: () => this.camera.projection === 'parallel',
      },
      {
        label: 'Perspective',
        run: () => this.camera.setProjection('perspective'),
        checked: () => this.camera.projection === 'perspective',
      },
      { separator: true },
      { label: 'Zoom Extents', shortcut: 'Shift+Z', run: () => this.zoomExtents() },
    ]);
    const editMenu = new Menu(
      'Edit',
      [
        { label: 'Undo', shortcut: 'Ctrl+Z', run: () => this.undo() },
        { label: 'Redo', shortcut: 'Ctrl+Y', run: () => this.redo() },
        { separator: true },
        { label: 'Delete', shortcut: 'Delete', run: () => this.eraseSelection() },
        { separator: true },
        { label: 'Select All', shortcut: 'Ctrl+A', run: () => this.selectAll() },
        { label: 'Select None', shortcut: 'Ctrl+Shift+A', run: () => this.selection.clear() },
        { separator: true },
        { label: 'Delete Guides', run: () => this.deleteGuides() },
        { separator: true },
        { label: 'Make Group', shortcut: 'Ctrl+G', run: () => this.makeGroup('group') },
        { label: 'Make Component', shortcut: 'G', run: () => this.makeGroup('component') },
        { label: 'Explode', run: () => this.explodeSelection() },
        { label: 'Close Group', shortcut: 'Esc', run: () => this.model.exit() },
      ],
      'left',
    );
    const fileMenu = new Menu(
      'File',
      [
        { label: 'New', run: () => this.document.newDocument() },
        { label: 'Open…', shortcut: 'Ctrl+O', run: () => void this.document.open() },
        { separator: true },
        { label: 'Save', shortcut: 'Ctrl+S', run: () => void this.document.save() },
        { label: 'Save As…', shortcut: 'Ctrl+Shift+S', run: () => void this.document.saveAs() },
        { separator: true },
        { label: 'Import STL…', run: () => void this.stl.importStl() },
        { label: 'Export STL…', shortcut: 'Ctrl+E', run: () => void this.stl.exportStl() },
      ],
      'left',
    );
    return [
      { type: 'menu', menu: fileMenu },
      { type: 'menu', menu: editMenu },
      { type: 'separator' },
      { type: 'tool', id: 'select' },
      { type: 'tool', id: 'eraser' },
      { type: 'separator' },
      { type: 'tool', id: 'line' },
      { type: 'tool', id: 'arc' },
      { type: 'tool', id: 'rectangle' },
      { type: 'tool', id: 'circle' },
      { type: 'tool', id: 'polygon' },
      { type: 'separator' },
      { type: 'tool', id: 'pushpull' },
      { type: 'soon', label: 'Follow Me' },
      { type: 'tool', id: 'offset' },
      { type: 'separator' },
      { type: 'tool', id: 'move' },
      { type: 'tool', id: 'rotate' },
      { type: 'tool', id: 'scale' },
      { type: 'separator' },
      { type: 'tool', id: 'tape' },
      { type: 'tool', id: 'protractor' },
      { type: 'spacer' },
      { type: 'tool', id: 'orbit' },
      { type: 'tool', id: 'pan' },
      { type: 'tool', id: 'zoom' },
      { type: 'command', label: 'Zoom Extents', title: 'Zoom Extents (Shift+Z)', run: () => this.zoomExtents() },
      { type: 'separator' },
      { type: 'menu', menu: cameraMenu },
    ];
  }

  private enterMeasurement(text: string): void {
    if (!this.tools.enterMeasurement(text)) this.statusBar.setHint(`${this.tools.active?.name ?? 'This tool'} doesn't take measurements.`);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return; // the Measurements box handles its own keys
    if (this.tools.keyDown(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      this.tools.cancel();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && MEASUREMENT_START.test(e.key)) {
      // Focus moves before the key's default action, so the character lands in the box.
      this.statusBar.startTyping();
      return;
    }
    const action = this.shortcuts[shortcutName(e)];
    if (action) {
      e.preventDefault();
      if (!e.repeat) action();
    }
  };
}

/** "Ctrl+Shift+Z"-style name for a key event. */
function shortcutName(e: KeyboardEvent): string {
  const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return `${e.ctrlKey || e.metaKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${key}`;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}
