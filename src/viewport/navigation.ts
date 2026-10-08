import type * as THREE from 'three';
import type { CameraController } from './CameraController';

export type NavMode = 'orbit' | 'pan' | 'zoom';

/** Zoom factor per pixel of vertical drag (Zoom tool). */
const DRAG_ZOOM_RATE = 0.005;
/** Zoom factor per wheel pixel; one notch (~100px) is ~22%. */
const WHEEL_ZOOM_RATE = 0.002;

/**
 * One navigation drag (middle mouse, or the Orbit/Pan/Zoom tools). The anchor is
 * the world point under the cursor when the drag started: orbit pivots on it,
 * pan keeps it under the cursor, zoom scales about it. The mode may change
 * mid-drag (e.g. holding Shift switches orbit to pan).
 */
export class NavDrag {
  private x: number;
  private y: number;

  constructor(
    private readonly camera: CameraController,
    x: number,
    y: number,
    readonly anchor: THREE.Vector3,
  ) {
    this.x = x;
    this.y = y;
  }

  move(x: number, y: number, mode: NavMode): void {
    const dx = x - this.x;
    const dy = y - this.y;
    this.x = x;
    this.y = y;
    if (dx === 0 && dy === 0) return;
    switch (mode) {
      case 'orbit':
        this.camera.orbit(dx, dy, this.anchor);
        break;
      case 'pan':
        this.camera.pan(dx, dy, this.camera.depthOf(this.anchor));
        break;
      case 'zoom':
        // Drag up to zoom in.
        this.camera.zoomAt(this.anchor, Math.exp(dy * DRAG_ZOOM_RATE));
        break;
    }
  }
}

/** Zooms toward `point` for a wheel event's deltaY (in pixels). */
export function wheelZoom(camera: CameraController, point: THREE.Vector3, deltaY: number): void {
  camera.zoomAt(point, Math.exp(deltaY * WHEEL_ZOOM_RATE));
}
