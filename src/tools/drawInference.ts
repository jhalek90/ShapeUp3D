import { AXIS_COLORS, type Inference, type InferenceKind } from '../inference/InferenceEngine';
import type { MarkerShape, Overlay } from '../viewport/Overlay';

// Marker shapes and colours follow SketchUp's conventions.
const MARKERS: Partial<Record<InferenceKind, { shape: MarkerShape; color: string }>> = {
  endpoint: { shape: 'circle', color: '#19b019' },
  midpoint: { shape: 'circle', color: '#18b8d2' },
  center: { shape: 'circle', color: '#0b7a2a' },
  intersection: { shape: 'cross', color: '#111' },
  origin: { shape: 'circle', color: '#f0b400' },
  'on-edge': { shape: 'square', color: '#e02424' },
  'on-face': { shape: 'diamond', color: '#2c5ce8' },
  'on-axis': { shape: 'square', color: '#e02424' },
  axis: { shape: 'dot', color: '#111' },
};

/** Draws the marker, tooltip and any dotted reference guide for an inference. */
export function drawInference(o: Overlay, inf: Inference, cursor: { x: number; y: number } | null): void {
  const axisColor = inf.axis ? AXIS_COLORS[inf.axis] : undefined;
  if (inf.ref) o.line(inf.ref, inf.point, { color: axisColor ?? '#555', width: 1, dash: [3, 3] });
  const marker = MARKERS[inf.kind];
  if (marker) {
    const color = (inf.kind === 'on-axis' || inf.kind === 'axis') && axisColor ? axisColor : marker.color;
    o.marker(inf.point, marker.shape, color);
  }
  // A locked line that met something says both, e.g. "On Red Axis · On Face".
  const text = inf.refTooltip && inf.tooltip ? `${inf.tooltip} · ${inf.refTooltip}` : inf.tooltip || inf.refTooltip;
  if (text && cursor) o.tooltip(cursor.x, cursor.y, text);
}
