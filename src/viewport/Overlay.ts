import * as THREE from 'three';
import type { XYZ } from '../core/math';
import type { CameraController } from './CameraController';
import { clipSegmentInFront } from './clip';

export interface LineStyle {
  color: string;
  width?: number;
  /** Dash pattern in pixels, e.g. [4, 4]. */
  dash?: number[];
}

export type MarkerShape = 'circle' | 'square' | 'diamond' | 'dot' | 'cross';

/**
 * A 2D canvas over the 3D view for things tools draw in screen space: rubber-band
 * lines, inference markers and tooltips. Cleared and redrawn every frame.
 */
export class Overlay {
  readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly camera: CameraController,
  ) {
    this.canvas.className = 'overlay';
    container.append(this.canvas);
    const g = this.canvas.getContext('2d');
    if (!g) throw new Error('2D canvas not supported');
    this.g = g;
  }

  /** Clears the overlay and matches its size to the viewport. */
  begin(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w !== this.width || h !== this.height || this.canvas.width !== Math.round(w * dpr)) {
      this.width = w;
      this.height = h;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.g.clearRect(0, 0, w, h);
  }

  /** Screen position (CSS px) of a world point, or null if it's behind the camera. */
  project(p: XYZ): { x: number; y: number } | null {
    const v = new THREE.Vector3(p.x, p.y, p.z);
    if (this.camera.projection === 'perspective' && this.camera.depthOf(v) <= this.camera.perspective.near) return null;
    v.project(this.camera.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  /** A world-space line, clipped to what's in front of the camera. */
  line(a: XYZ, b: XYZ, style: LineStyle): void {
    let pa = new THREE.Vector3(a.x, a.y, a.z);
    let pb = new THREE.Vector3(b.x, b.y, b.z);
    if (this.camera.projection === 'perspective') {
      const clipped = clipSegmentInFront(pa, pb, this.camera.position, this.camera.forward, this.camera.perspective.near * 1.01);
      if (!clipped) return;
      [pa, pb] = clipped;
    }
    const sa = this.project(pa);
    const sb = this.project(pb);
    if (!sa || !sb) return;
    const g = this.g;
    g.save();
    g.strokeStyle = style.color;
    g.lineWidth = style.width ?? 1.5;
    g.setLineDash(style.dash ?? []);
    g.beginPath();
    g.moveTo(sa.x, sa.y);
    g.lineTo(sb.x, sb.y);
    g.stroke();
    g.restore();
  }

  /** A screen-space rectangle (for window selection). */
  rect(x0: number, y0: number, x1: number, y1: number, style: LineStyle): void {
    const g = this.g;
    g.save();
    g.strokeStyle = style.color;
    g.lineWidth = style.width ?? 1;
    g.setLineDash(style.dash ?? []);
    g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    g.restore();
  }

  /** A world-space polyline (e.g. the Rotate tool's protractor). */
  polyline(points: readonly XYZ[], style: LineStyle, closed = false): void {
    for (let i = 0; i + 1 < points.length; i++) this.line(points[i]!, points[i + 1]!, style);
    if (closed && points.length > 2) this.line(points[points.length - 1]!, points[0]!, style);
  }

  /** An inference marker at a world point. */
  marker(p: XYZ, shape: MarkerShape, color: string): void {
    const s = this.project(p);
    if (!s) return;
    const g = this.g;
    g.save();
    g.fillStyle = color;
    g.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    g.lineWidth = 1;
    g.beginPath();
    switch (shape) {
      case 'circle':
        g.arc(s.x, s.y, 5, 0, Math.PI * 2);
        break;
      case 'square':
        g.rect(s.x - 4, s.y - 4, 8, 8);
        break;
      case 'diamond':
        g.moveTo(s.x, s.y - 6);
        g.lineTo(s.x + 6, s.y);
        g.lineTo(s.x, s.y + 6);
        g.lineTo(s.x - 6, s.y);
        g.closePath();
        break;
      case 'dot':
        g.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
        break;
      case 'cross':
        g.strokeStyle = color;
        g.lineWidth = 2.5;
        g.moveTo(s.x - 5, s.y - 5);
        g.lineTo(s.x + 5, s.y + 5);
        g.moveTo(s.x + 5, s.y - 5);
        g.lineTo(s.x - 5, s.y + 5);
        g.stroke();
        g.restore();
        return;
    }
    g.fill();
    if (shape !== 'dot') g.stroke();
    g.restore();
  }

  /** A SketchUp-style tooltip near a screen position. */
  tooltip(x: number, y: number, text: string): void {
    const g = this.g;
    g.save();
    g.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const padX = 6;
    const w = g.measureText(text).width + padX * 2;
    const h = 20;
    // Keep it on screen.
    const tx = Math.min(x + 14, this.width - w - 2);
    const ty = Math.min(y + 18, this.height - h - 2);
    g.fillStyle = '#ffffe6';
    g.strokeStyle = '#8a8a7a';
    g.lineWidth = 1;
    g.beginPath();
    g.roundRect(tx + 0.5, ty + 0.5, w, h, 3);
    g.fill();
    g.stroke();
    g.fillStyle = '#222';
    g.textBaseline = 'middle';
    g.fillText(text, tx + padX + 0.5, ty + h / 2 + 0.5);
    g.restore();
  }
}
