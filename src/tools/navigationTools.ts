import * as THREE from 'three';
import { NavDrag } from '../viewport/navigation';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

/** Shared left-drag behaviour for the Orbit, Pan and Zoom tools. */
abstract class NavigationTool implements Tool {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly shortcut: string;
  protected abstract readonly cursor: string;
  protected abstract readonly status: string;

  protected ctx!: ToolContext;
  private drag: NavDrag | null = null;

  activate(ctx: ToolContext): void {
    this.ctx = ctx;
    ctx.setCursor(this.cursor);
    ctx.setStatus(this.status);
  }

  pointerDown(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.drag = new NavDrag(this.ctx.camera, e.x, e.y, this.ctx.viewport.pick(e.ndc));
    this.ctx.setCursor(this.dragCursor);
  }

  pointerMove(e: ToolPointerEvent): void {
    this.drag?.move(e.x, e.y, this.mode(e));
  }

  pointerUp(e: ToolPointerEvent): void {
    if (e.button !== 0) return;
    this.cancel();
  }

  cancel(): void {
    this.drag = null;
    this.ctx.setCursor(this.cursor);
  }

  protected get dragCursor(): string {
    return this.cursor;
  }

  protected abstract mode(e: ToolPointerEvent): 'orbit' | 'pan' | 'zoom';
}

export class OrbitTool extends NavigationTool {
  readonly id = 'orbit';
  readonly name = 'Orbit';
  readonly shortcut = 'O';
  protected readonly cursor = 'grab';
  protected readonly status = 'Drag to orbit around the point under the cursor. Shift = Pan.';

  protected override get dragCursor(): string {
    return 'grabbing';
  }

  protected mode(e: ToolPointerEvent) {
    return e.shiftKey ? 'pan' : 'orbit';
  }
}

export class PanTool extends NavigationTool {
  readonly id = 'pan';
  readonly name = 'Pan';
  readonly shortcut = 'H';
  protected readonly cursor = 'move';
  protected readonly status = 'Drag to pan.';

  protected mode() {
    return 'pan' as const;
  }
}

export class ZoomTool extends NavigationTool {
  readonly id = 'zoom';
  readonly name = 'Zoom';
  readonly shortcut = 'Z';
  protected readonly cursor = 'zoom-in';
  protected readonly status = 'Drag up to zoom in, down to zoom out. Shift+drag = change field of view.';

  private fovDrag: { y: number } | null = null;

  override activate(ctx: ToolContext): void {
    super.activate(ctx);
    this.showFov();
  }

  override pointerDown(e: ToolPointerEvent): void {
    if (e.button === 0 && e.shiftKey) {
      this.fovDrag = { y: e.y };
      return;
    }
    super.pointerDown(e);
  }

  override pointerMove(e: ToolPointerEvent): void {
    if (this.fovDrag) {
      const dy = e.y - this.fovDrag.y;
      this.fovDrag.y = e.y;
      this.ctx.camera.setFov(this.ctx.camera.fov * Math.exp(-dy * 0.005));
      this.showFov();
      return;
    }
    super.pointerMove(e);
  }

  override cancel(): void {
    this.fovDrag = null;
    super.cancel();
  }

  /** Accepts a field of view in degrees ("35", "35deg") or a 35 mm-equivalent focal length ("50mm"). */
  enterMeasurement(text: string): void {
    const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(deg|°|mm)?\s*$/i.exec(text);
    if (!m) {
      this.ctx.setStatus(`Invalid field of view: "${text}". Enter degrees (35) or a focal length (50mm).`);
      return;
    }
    const value = Number(m[1]);
    const degrees = m[2]?.toLowerCase() === 'mm' ? THREE.MathUtils.radToDeg(2 * Math.atan(12 / value)) : value;
    if (!(degrees >= 1 && degrees <= 120)) {
      this.ctx.setStatus('Field of view must be between 1° and 120°.');
      return;
    }
    this.ctx.camera.setFov(degrees);
    this.ctx.setStatus(this.status);
    this.showFov();
  }

  protected mode() {
    return 'zoom' as const;
  }

  private showFov(): void {
    this.ctx.setMeasurement('Field of View', `${this.ctx.camera.fov.toFixed(1)} deg`);
  }
}
