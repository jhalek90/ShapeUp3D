import * as THREE from 'three';
import type { CameraController } from './CameraController';
import { clipSegmentInFront } from './clip';

// SketchUp convention: Z is up. Red = X, green = Y, blue = Z. Model units are mm.

const AXIS_LENGTH = 1_000_000;
const AXIS_COLORS = { x: 0xd02020, y: 0x20a020, z: 0x2040d0 } as const;
const GROUND = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
/** Ground hits farther than this many focus distances are treated as "near the horizon". */
const MAX_GROUND_PICK = 50;

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Everything belonging to the model goes here; it's what picking and Zoom Extents see. */
  readonly modelRoot = new THREE.Group();
  /** Called every frame before the scene is drawn (e.g. to sync model geometry). */
  readonly beforeRender: (() => void)[] = [];
  /** Called every frame after the scene is drawn (e.g. 2D overlays). */
  readonly afterRender: (() => void)[] = [];

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly axisLines: { line: THREE.Line; end: THREE.Vector3 }[] = [];
  private grid!: THREE.GridHelper;

  constructor(
    container: HTMLElement,
    readonly camera: CameraController,
  ) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xf2f3f5);
    this.modelRoot.name = 'model';
    this.scene.add(this.modelRoot);

    this.addLights();
    this.addAxes();
    this.addGrid();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.renderer.setAnimationLoop((time) => this.render(time));
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Converts client (page) coordinates to viewport pixels and NDC. */
  toViewport(clientX: number, clientY: number): { x: number; y: number; ndc: THREE.Vector2 } {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { x, y, ndc: new THREE.Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1) };
  }

  ray(ndc: THREE.Vector2): THREE.Ray {
    this.raycaster.setFromCamera(ndc, this.camera.camera);
    return this.raycaster.ray.clone();
  }

  /**
   * World point under the cursor: model geometry first, then the ground plane,
   * otherwise a point at the camera's focus depth. Always returns a point, so
   * navigation has something sensible to pivot on even over empty sky.
   */
  pick(ndc: THREE.Vector2): THREE.Vector3 {
    const cam = this.camera;
    this.raycaster.setFromCamera(ndc, cam.camera);
    const hit = this.raycaster.intersectObject(this.modelRoot, true)[0];
    if (hit) return hit.point.clone();

    const ground = this.raycaster.ray.intersectPlane(GROUND, new THREE.Vector3());
    if (ground) {
      const depth = cam.depthOf(ground);
      const inFront = cam.projection === 'parallel' || depth > 0;
      if (inFront && Math.abs(depth) < cam.distance * MAX_GROUND_PICK) return ground;
    }
    return cam.pointAtDepth(this.raycaster.ray, cam.distance);
  }

  /** Bounds for Zoom Extents: the model, or the grid when the model is empty. */
  extentsSphere(): THREE.Sphere {
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    if (box.isEmpty()) box.setFromObject(this.grid);
    return box.getBoundingSphere(new THREE.Sphere());
  }

  private clippingSphere(): THREE.Sphere {
    const box = new THREE.Box3().setFromObject(this.modelRoot).union(new THREE.Box3().setFromObject(this.grid));
    return box.getBoundingSphere(new THREE.Sphere());
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-1, -2, 3);
    this.scene.add(sun);
  }

  /**
   * Solid lines on the positive side, dashed on the negative side, like SketchUp.
   * Endpoints are recomputed every frame (see updateAxes) so the "infinite" axes
   * never have a vertex behind the camera, which breaks line rendering.
   */
  private addAxes(): void {
    const axes = new THREE.Group();
    axes.name = 'axes';
    const dirs: [keyof typeof AXIS_COLORS, THREE.Vector3][] = [
      ['x', new THREE.Vector3(1, 0, 0)],
      ['y', new THREE.Vector3(0, 1, 0)],
      ['z', new THREE.Vector3(0, 0, 1)],
    ];
    for (const [key, dir] of dirs) {
      const color = AXIS_COLORS[key];
      for (const sign of [1, -1]) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(6, 3));
        geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute(2, 1));
        const material =
          sign > 0
            ? new THREE.LineBasicMaterial({ color })
            : new THREE.LineDashedMaterial({ color, dashSize: 4, gapSize: 4, opacity: 0.6, transparent: true });
        const line = new THREE.Line(geometry, material);
        line.frustumCulled = false;
        axes.add(line);
        this.axisLines.push({ line, end: dir.clone().multiplyScalar(sign * AXIS_LENGTH) });
      }
    }
    this.scene.add(axes);
  }

  private updateAxes(): void {
    const cam = this.camera;
    const camPos = cam.position;
    const camDir = cam.forward;
    // Keep every drawn vertex in front of the near plane (only matters in perspective).
    const minDepth = cam.projection === 'perspective' ? cam.perspective.near * 2 : -Infinity;
    const origin = new THREE.Vector3();
    for (const { line, end } of this.axisLines) {
      const clipped = clipSegmentInFront(origin, end, camPos, camDir, minDepth);
      line.visible = clipped !== null;
      if (!clipped) continue;
      const [a, b] = clipped;
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, a.x, a.y, a.z);
      pos.setXYZ(1, b.x, b.y, b.z);
      pos.needsUpdate = true;
      // Dash phase measured from the origin so dashes don't crawl while orbiting.
      const dist = line.geometry.getAttribute('lineDistance') as THREE.BufferAttribute;
      dist.setX(0, a.length());
      dist.setX(1, b.length());
      dist.needsUpdate = true;
    }
  }

  /** A 250 mm "build plate" grid with 10 mm cells on the ground plane. */
  private addGrid(): void {
    const grid = new THREE.GridHelper(250, 25, 0xb8bcc4, 0xd6d9de);
    grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; rotate into XY (Z-up)
    grid.position.set(125, 125, 0);
    grid.name = 'grid';
    // Drawn first without writing depth, so it never hides axes or geometry.
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const m of gridMaterials) m.depthWrite = false;
    grid.renderOrder = -1;
    this.grid = grid;
    this.scene.add(grid);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.setSize(w, h);
  }

  /** Viewport size in CSS pixels. */
  get size(): { width: number; height: number } {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight };
  }

  private render(time: number): void {
    for (const fn of this.beforeRender) fn();
    this.camera.update(time);
    this.camera.updateClipping(this.clippingSphere());
    this.updateAxes();
    this.renderer.render(this.scene, this.camera.camera);
    for (const fn of this.afterRender) fn();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}
