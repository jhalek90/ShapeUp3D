import { describe, expect, it } from 'vitest';
import { formatAngle, parseAngle, parseArray } from './angle';

describe('parseAngle', () => {
  it('parses degrees with or without a unit', () => {
    expect(parseAngle('90')).toBeCloseTo(Math.PI / 2);
    expect(parseAngle('45deg')).toBeCloseTo(Math.PI / 4);
    expect(parseAngle(' -30° ')).toBeCloseTo(-Math.PI / 6);
    expect(parseAngle('.5')).toBeCloseTo((0.5 * Math.PI) / 180);
  });

  it('rejects junk', () => {
    expect(parseAngle('abc')).toBeNull();
    expect(parseAngle('30mm')).toBeNull();
  });

  it('formats', () => {
    expect(formatAngle(Math.PI / 4)).toBe('45.0°');
  });
});

describe('parseArray', () => {
  it('parses multiply and divide forms', () => {
    expect(parseArray('x5')).toEqual({ mode: 'multiply', count: 5 });
    expect(parseArray('*3')).toEqual({ mode: 'multiply', count: 3 });
    expect(parseArray('4x')).toEqual({ mode: 'multiply', count: 4 });
    expect(parseArray('/6')).toEqual({ mode: 'divide', count: 6 });
    expect(parseArray('6/')).toEqual({ mode: 'divide', count: 6 });
  });

  it('rejects lengths and zero counts', () => {
    expect(parseArray('25')).toBeNull();
    expect(parseArray('x0')).toBeNull();
  });
});
