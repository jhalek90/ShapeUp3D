import type { Vec3 } from '../core/math';
import { AXIS_DIRS, type Axis, type Inference, type InferenceLock } from '../inference/InferenceEngine';

const ARROW_AXES: Partial<Record<string, Axis>> = { ArrowRight: 'x', ArrowLeft: 'y', ArrowUp: 'z' };
export const AXIS_NAMES: Record<Axis, string> = { x: 'Red', y: 'Green', z: 'Blue' };

/**
 * SketchUp's inference locks for tools that pick a second point from a first:
 * arrow keys lock an axis (→ red, ← green, ↑ blue, ↓ unlock) and holding Shift
 * locks whatever is currently inferred (an axis direction or a face's plane).
 */
export class InferenceLocks {
  private axis: Axis | null = null;
  private shift: InferenceLock | null = null;

  /** Handles a key press. Returns true if it changed a lock. */
  keyDown(e: KeyboardEvent, current: Inference | null, from: Vec3 | null): boolean {
    const axis = ARROW_AXES[e.key];
    if (axis) {
      this.axis = this.axis === axis ? null : axis;
      return true;
    }
    if (e.key === 'ArrowDown') {
      this.axis = null;
      return true;
    }
    if (e.key === 'Shift' && !e.repeat && !this.shift && current) {
      this.shift = lockFrom(current, from);
      return this.shift !== null;
    }
    return false;
  }

  keyUp(e: KeyboardEvent): boolean {
    if (e.key !== 'Shift' || !this.shift) return false;
    this.shift = null;
    return true;
  }

  /** The active lock for picking a point from `from`. */
  lock(from: Vec3 | null): InferenceLock | null {
    if (this.shift) return this.shift;
    if (this.axis && from) {
      return { kind: 'line', origin: from, dir: AXIS_DIRS[this.axis], axis: this.axis, tooltip: `On ${AXIS_NAMES[this.axis]} Axis` };
    }
    return null;
  }

  /** The locked axis from the arrow keys, if any. */
  get lockedAxis(): Axis | null {
    return this.axis;
  }

  reset(): void {
    this.axis = null;
    this.shift = null;
  }
}

function lockFrom(inf: Inference, from: Vec3 | null): InferenceLock | null {
  if (inf.kind === 'axis' && inf.axis && from) {
    return { kind: 'line', origin: from, dir: AXIS_DIRS[inf.axis], axis: inf.axis, tooltip: inf.tooltip };
  }
  if (inf.kind === 'on-face' && inf.face) return { kind: 'plane', plane: inf.face.plane, tooltip: 'On Face' };
  return null;
}

/**
 * Detects a lone tap of Ctrl (pressed and released with no other key), so Ctrl
 * can toggle copy mode without Ctrl+Z and friends flipping it as a side effect.
 */
export class CtrlTap {
  private armed = false;

  keyDown(e: KeyboardEvent): void {
    if (e.key === 'Control') {
      if (!e.repeat) this.armed = true;
    } else {
      this.armed = false;
    }
  }

  /** True if this key-up completes a lone Ctrl tap. */
  keyUp(e: KeyboardEvent): boolean {
    const tap = e.key === 'Control' && this.armed;
    if (e.key === 'Control') this.armed = false;
    return tap;
  }
}
