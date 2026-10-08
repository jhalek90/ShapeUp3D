// Length units, formatting and Measurements-box parsing.
// All model values are stored in millimetres; units only affect display and input.

export type LengthUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];

export const MM_PER_UNIT: Record<LengthUnit, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export interface LengthFormat {
  unit: LengthUnit;
  /** Decimal places shown. For 'ft' this applies to the inches part. */
  precision: number;
}

const SUFFIXES: Record<string, LengthUnit> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  '"': 'in',
  in: 'in',
  inch: 'in',
  inches: 'in',
  "'": 'ft',
  ft: 'ft',
  foot: 'ft',
  feet: 'ft',
};

/** Unit applied to a bare number. Like SketchUp, a bare number in feet mode means inches. */
function bareUnit(unit: LengthUnit): LengthUnit {
  return unit === 'ft' ? 'in' : unit;
}

interface Quantity {
  value: number;
  unit: LengthUnit | null;
  rest: string;
}

/** Parses a number ("6", "6.5", ".5", "1/2", "6 1/2") followed by an optional unit suffix. */
function parseQuantity(s: string): Quantity | null {
  let value: number;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)/.exec(s))) {
    const den = Number(m[3]);
    if (den === 0) return null;
    value = Number(m[1]) + Number(m[2]) / den;
  } else if ((m = /^(\d+)\s*\/\s*(\d+)/.exec(s))) {
    const den = Number(m[2]);
    if (den === 0) return null;
    value = Number(m[1]) / den;
  } else if ((m = /^(\d+(?:\.\d*)?|\.\d+)/.exec(s))) {
    value = Number(m[1]);
  } else {
    return null;
  }
  let rest = s.slice(m[0].length).trimStart();
  const u = /^(inches|inch|feet|foot|mm|cm|in|ft|m|"|')/.exec(rest);
  let unit: LengthUnit | null = null;
  if (u) {
    unit = SUFFIXES[u[1]!]!;
    rest = rest.slice(u[0].length).trimStart();
  }
  return { value, unit, rest };
}

/**
 * Parses a single length typed by the user and returns millimetres, or null if invalid.
 * Accepts any unit regardless of the model unit: "25", "25mm", "2.5 cm", "1.5m",
 * `1"`, "3'6\"", "3' 6 1/2\"", "1/2in". Bare numbers use `defaultUnit`.
 */
export function parseLength(text: string, defaultUnit: LengthUnit): number | null {
  let s = text.trim().toLowerCase();
  let sign = 1;
  if (s.startsWith('-') || s.startsWith('+')) {
    if (s[0] === '-') sign = -1;
    s = s.slice(1).trimStart();
  }
  const first = parseQuantity(s);
  if (!first) return null;

  const firstUnit = first.unit ?? bareUnit(defaultUnit);
  let mm = first.value * MM_PER_UNIT[firstUnit];

  if (first.rest !== '') {
    // Only feet may be followed by a second (inches) quantity: 3' 6"
    if (firstUnit !== 'ft') return null;
    const second = parseQuantity(first.rest);
    if (!second || second.rest !== '') return null;
    if (second.unit !== null && second.unit !== 'in') return null;
    mm += second.value * MM_PER_UNIT.in;
  }
  return sign * mm;
}

/** Parses comma/semicolon separated lengths, e.g. "30,20" for a rectangle. Empty entries are null. */
export function parseLengthList(text: string, defaultUnit: LengthUnit): (number | null)[] | null {
  const parts = text.split(/[,;]/);
  const out: (number | null)[] = [];
  for (const part of parts) {
    if (part.trim() === '') {
      out.push(null);
      continue;
    }
    const v = parseLength(part, defaultUnit);
    if (v === null) return null;
    out.push(v);
  }
  return out;
}

function roundTo(value: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round(value * f) / f;
}

function trimNumber(value: number, precision: number): string {
  const s = value.toFixed(precision);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Formats millimetres for display. Prefixes "~ " when the shown value is rounded, like SketchUp. */
export function formatLength(mm: number, format: LengthFormat): string {
  const { unit, precision } = format;
  const sign = mm < 0 ? '-' : '';
  const abs = Math.abs(mm);
  let approx: boolean;
  let isZero: boolean;
  let text: string;

  if (unit === 'ft') {
    const totalIn = abs / MM_PER_UNIT.in;
    let feet = Math.floor(totalIn / 12);
    let inches = roundTo(totalIn - feet * 12, precision);
    approx = Math.abs(feet * 12 + inches - totalIn) > 1e-9;
    if (inches >= 12) {
      feet += 1;
      inches -= 12;
    }
    isZero = feet === 0 && inches === 0;
    const inStr = `${trimNumber(inches, precision)}"`;
    text = feet > 0 ? `${feet}' ${inStr}` : inStr;
  } else {
    const v = abs / MM_PER_UNIT[unit];
    const r = roundTo(v, precision);
    approx = Math.abs(r - v) > 1e-9;
    isZero = r === 0;
    const n = trimNumber(r, precision);
    text = unit === 'in' ? `${n}"` : `${n} ${unit}`;
  }

  // Don't show "-0 mm"
  return (approx ? '~ ' : '') + (isZero ? '' : sign) + text;
}
