import type * as THREE from 'three';
import type { Selection } from '../app/Selection';
import type { Vec3 } from '../core/math';
import type { Edge, Face, Instance } from '../core/Mesh';
import type { Model } from '../core/Model';
import type { InferenceEngine } from '../inference/InferenceEngine';
import type { LengthFormat } from '../units/length';
import type { CameraController } from '../viewport/CameraController';
import type { Overlay } from '../viewport/Overlay';
import type { Viewport } from '../viewport/Viewport';

/** Mouse event in viewport terms, handed to the active tool. */
export interface ToolPointerEvent {
  /** Pixels from the viewport's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** Normalized device coordinates (-1..1, y up). */
  readonly ndc: THREE.Vector2;
  /** World-space ray under the cursor. */
  readonly ray: THREE.Ray;
  /** Button that changed (0 left, 2 right); -1 for plain moves. */
  readonly button: number;
  /** Click count for presses: 1, 2 (double-click), 3 (triple-click). */
  readonly clicks: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/** What a tool can reach: the model, the view, units, and the status bar. */
export interface ToolContext {
  readonly model: Model;
  readonly viewport: Viewport;
  readonly camera: CameraController;
  readonly inference: InferenceEngine;
  readonly selection: Selection;
  readonly format: LengthFormat;
  /** Highlights geometry the tool is about to act on (pass nothing to clear). */
  highlight(faces?: Iterable<Face>, edges?: Iterable<Edge>, instances?: Iterable<Instance>): void;
  /** Direction toward the viewer; new faces face this way when nothing else decides. */
  facing(): Vec3;
  /** Hint text in the status bar. */
  setStatus(text: string): void;
  /** Measurements box label and displayed value (value is ignored while the user is typing). */
  setMeasurement(label: string, value?: string): void;
  /** CSS cursor for the viewport. */
  setCursor(cursor: string): void;
}

/**
 * A modeling or navigation tool. Only the left and right mouse buttons reach tools;
 * the middle button and wheel always navigate, so tools never need to handle them.
 * All handlers are optional.
 */
export interface Tool {
  readonly id: string;
  readonly name: string;
  /** Display string for the keyboard shortcut, e.g. "L" or "Shift+Z". */
  readonly shortcut?: string;

  /** Called when the tool becomes active. Set cursor, status and Measurements label here. */
  activate(ctx: ToolContext): void;
  deactivate?(): void;

  pointerDown?(e: ToolPointerEvent): void;
  pointerMove?(e: ToolPointerEvent): void;
  pointerUp?(e: ToolPointerEvent): void;
  doubleClick?(e: ToolPointerEvent): void;

  /** Return true if the tool handled the key (stops shortcuts from firing). */
  keyDown?(e: KeyboardEvent): boolean;
  keyUp?(e: KeyboardEvent): boolean;

  /** Text submitted from the Measurements box. */
  enterMeasurement?(text: string): void;

  /** Esc: abandon the operation in progress. */
  cancel?(): void;

  /** Draws previews, inference markers and tooltips. Called every frame. */
  draw?(overlay: Overlay): void;
}
