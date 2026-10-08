import * as THREE from 'three';
import type { Model } from '../core/Model';
import type { CameraController } from './CameraController';
import { clipSegmentInFront } from './clip';
import type { Overlay } from './Overlay';

const GUIDE_COLOR = 0x5a5f66;
const GUIDE_LENGTH = 1_000_000;
const DASH_PX = 6;
const GAP_PX = 4;

/**
 * Draws construction guides: infinite dashed lines (clipped to the camera each frame,
 * like the axes) and small markers for guide points.
 */
export class GuideRenderer {
  private readonly group = new THREE.Group();
  private readonly material = new THREE.LineDashedMaterial({ color: GUIDE_COLOR, dashSize: 1, gapSize: 1, transparent: true, opacity: 0.85 });
  private lines: { line: THREE.Line; point: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  private builtVersion = -1;

  constructor(
    private readonly model: Model,
    scene: THREE.Scene,
    private readonly camera: CameraController,
  ) {
    this.group.name = 'guides';
    scene.add(this.group);
  }

  /** Call every frame before rendering. */
  update(): void {
    if (this.model.version !== this.builtVersion) this.rebuild();
    const cam = this.camera;
    // Keep dashes a constant size on screen (measured at the focus distance).
    const wpp = cam.worldPerPixel();
    this.material.dashSize = DASH_PX * wpp;
    this.material.gapSize = GAP_PX * wpp;
    const minDepth = cam.projection === 'perspective' ? cam.perspective.near * 2 : -Infinity;
    for (const { line, point, dir } of this.lines) {
      const a = point.clone().addScaledVector(dir, -GUIDE_LENGTH);
      const b = point.clone().addScaledVector(dir, GUIDE_LENGTH);
      const clipped = clipSegmentInFront(a, b, cam.position, cam.forward, minDepth);
      line.visible = clipped !== null;
      if (!clipped) continue;
      const [p, q] = clipped;
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, p.x, p.y, p.z);
      pos.setXYZ(1, q.x, q.y, q.z);
      pos.needsUpdate = true;
      // Dash phase measured from the guide's own point so dashes don't crawl.
      const dist = line.geometry.getAttribute('lineDistance') as THREE.BufferAttribute;
      dist.setX(0, p.clone().sub(point).dot(dir) + GUIDE_LENGTH);
      dist.setX(1, q.clone().sub(point).dot(dir) + GUIDE_LENGTH);
      dist.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    }
  }

  /** Guide points are drawn as small screen-space markers. */
  drawPoints(o: Overlay): void {
    for (const g of this.model.mesh.guides.values()) {
      if (g.kind === 'point') o.marker(g.point, 'cross', '#5a5f66');
    }
  }

  private rebuild(): void {
    this.builtVersion = this.model.version;
    for (const { line } of this.lines) line.geometry.dispose();
    this.group.clear();
    this.lines = [];
    for (const g of this.model.mesh.guides.values()) {
      if (g.kind !== 'line') continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(6, 3));
      geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute(2, 1));
      const line = new THREE.Line(geometry, this.material);
      line.frustumCulled = false;
      this.group.add(line);
      this.lines.push({ line, point: new THREE.Vector3(g.point.x, g.point.y, g.point.z), dir: new THREE.Vector3(g.dir.x, g.dir.y, g.dir.z) });
    }
  }
}
