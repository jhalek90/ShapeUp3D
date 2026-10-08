import type { Overlay } from '../viewport/Overlay';
import type { Tool, ToolContext, ToolPointerEvent } from './Tool';

/** Owns the registered tools and routes input to the active one. */
export class ToolManager {
  private readonly tools = new Map<string, Tool>();
  private _active: Tool | null = null;
  private readonly listeners = new Set<(tool: Tool) => void>();

  constructor(private readonly ctx: ToolContext) {}

  register(...tools: Tool[]): void {
    for (const tool of tools) this.tools.set(tool.id, tool);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  get active(): Tool | null {
    return this._active;
  }

  /** Activates a tool. Re-activating the current tool resets it, like SketchUp. */
  activate(id: string): void {
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`Unknown tool: ${id}`);
    if (this._active) {
      this._active.cancel?.();
      this._active.deactivate?.();
    }
    this._active = tool;
    this.ctx.setCursor('default');
    this.ctx.setStatus('');
    this.ctx.setMeasurement('');
    tool.activate(this.ctx);
    for (const fn of this.listeners) fn(tool);
  }

  /** Subscribes to tool changes. Returns an unsubscribe function. */
  onChange(fn: (tool: Tool) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  pointerDown(e: ToolPointerEvent): void {
    this._active?.pointerDown?.(e);
  }

  pointerMove(e: ToolPointerEvent): void {
    this._active?.pointerMove?.(e);
  }

  pointerUp(e: ToolPointerEvent): void {
    this._active?.pointerUp?.(e);
  }

  doubleClick(e: ToolPointerEvent): void {
    this._active?.doubleClick?.(e);
  }

  keyDown(e: KeyboardEvent): boolean {
    return this._active?.keyDown?.(e) ?? false;
  }

  keyUp(e: KeyboardEvent): boolean {
    return this._active?.keyUp?.(e) ?? false;
  }

  /** Returns false if the active tool doesn't accept Measurements input. */
  enterMeasurement(text: string): boolean {
    const tool = this._active;
    if (!tool?.enterMeasurement) return false;
    tool.enterMeasurement(text);
    return true;
  }

  cancel(): void {
    this._active?.cancel?.();
  }

  draw(overlay: Overlay): void {
    this._active?.draw?.(overlay);
  }
}
