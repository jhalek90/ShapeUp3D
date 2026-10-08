// Angles for the Rotate tool, and array entries ("x5", "/5") for Move and Rotate copies.

/** Parses degrees ("30", "30deg", "30°", "-45") into radians, or null if invalid. */
export function parseAngle(text: string): number | null {
  const m = /^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:deg|°)?\s*$/i.exec(text);
  return m ? (Number(m[1]) * Math.PI) / 180 : null;
}

export function formatAngle(radians: number, precision = 1): string {
  return `${((radians * 180) / Math.PI).toFixed(precision)}°`;
}

export interface ArrayEntry {
  /** multiply: copies at 1×, 2×, … the offset; divide: copies evenly between original and offset. */
  mode: 'multiply' | 'divide';
  count: number;
}

/** Parses SketchUp array syntax: "x5", "*5", "5x" (multiply) or "/5", "5/" (divide). */
export function parseArray(text: string): ArrayEntry | null {
  const t = text.trim().toLowerCase();
  let m = /^[x*]\s*(\d+)$/.exec(t) ?? /^(\d+)\s*x$/.exec(t);
  if (m) return Number(m[1]) >= 1 ? { mode: 'multiply', count: Number(m[1]) } : null;
  m = /^\/\s*(\d+)$/.exec(t) ?? /^(\d+)\s*\/$/.exec(t);
  if (m) return Number(m[1]) >= 1 ? { mode: 'divide', count: Number(m[1]) } : null;
  return null;
}
