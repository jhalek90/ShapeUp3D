import type { ToolPointerEvent } from '../tools/Tool';
import type { ToolManager } from '../tools/ToolManager';
import { NavDrag, wheelZoom } from './navigation';
import type { Viewport } from './Viewport';

const MIDDLE = 1;
const DOUBLE_CLICK_MS = 350;
const DOUBLE_CLICK_PX = 6;

/**
 * Routes mouse input on the viewport. The middle button and wheel always
 * navigate (so they work mid-operation in any tool); left and right go to the
 * active tool.
 *
 * Uses mouse events rather than pointer events because pointer events don't fire
 * pointerdown for a second button pressed while another is held.
 */
export class InputRouter {
  private nav: NavDrag | null = null;
  /** Buttons pressed on the canvas whose release the tool should see. */
  private toolButtons = new Set<number>();
  private lastMiddleDown = { time: -Infinity, x: 0, y: 0 };

  constructor(
    private readonly viewport: Viewport,
    private readonly tools: ToolManager,
  ) {
    const canvas = viewport.canvas;
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private toolEvent(e: MouseEvent, button = e.button): ToolPointerEvent {
    const { x, y, ndc } = this.viewport.toViewport(e.clientX, e.clientY);
    return {
      x,
      y,
      ndc,
      ray: this.viewport.ray(ndc),
      button,
      clicks: e.detail,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
    };
  }

  private onMouseDown = (e: MouseEvent): void => {
    // Clicking the view ends any typing in the Measurements box.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    const { x, y, ndc } = this.viewport.toViewport(e.clientX, e.clientY);
    if (e.button === MIDDLE) {
      e.preventDefault(); // stop Windows auto-scroll
      const last = this.lastMiddleDown;
      if (e.timeStamp - last.time < DOUBLE_CLICK_MS && Math.hypot(x - last.x, y - last.y) < DOUBLE_CLICK_PX) {
        // Double-click the wheel: center the view on the point under the cursor.
        this.lastMiddleDown.time = -Infinity;
        this.nav = null;
        this.viewport.camera.centerOn(this.viewport.pick(ndc));
        return;
      }
      this.lastMiddleDown = { time: e.timeStamp, x, y };
      this.nav = new NavDrag(this.viewport.camera, x, y, this.viewport.pick(ndc));
      return;
    }
    this.toolButtons.add(e.button);
    this.tools.pointerDown(this.toolEvent(e));
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.nav) {
      const { x, y } = this.viewport.toViewport(e.clientX, e.clientY);
      this.nav.move(x, y, e.shiftKey ? 'pan' : 'orbit');
      return;
    }
    // Hover moves only over the canvas; drags that started on it follow anywhere.
    if (this.toolButtons.size > 0 || e.target === this.viewport.canvas) {
      this.tools.pointerMove(this.toolEvent(e, -1));
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === MIDDLE) {
      this.nav = null;
      return;
    }
    if (!this.toolButtons.delete(e.button)) return;
    this.tools.pointerUp(this.toolEvent(e));
  };

  private onDoubleClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    this.tools.doubleClick(this.toolEvent(e));
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Normalize line/page deltas to pixels.
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? this.viewport.canvas.clientHeight : 1;
    const { ndc } = this.viewport.toViewport(e.clientX, e.clientY);
    wheelZoom(this.viewport.camera, this.viewport.pick(ndc), e.deltaY * scale);
  };
}
