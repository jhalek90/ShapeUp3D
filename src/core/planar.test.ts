import { describe, expect, it } from 'vitest';
import type { Vec2 } from './math';
import { findRegions } from './planar';

function graph(pts: Record<number, [number, number]>) {
  return new Map<number, Vec2>(Object.entries(pts).map(([id, [x, y]]) => [Number(id), { x, y }]));
}

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('findRegions', () => {
  const square = graph({ 1: [0, 0], 2: [10, 0], 3: [10, 10], 4: [0, 10] });
  const squareEdges: [number, number][] = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 1],
  ];

  it('finds a single square', () => {
    const regions = findRegions(square, squareEdges);
    expect(regions).toHaveLength(1);
    expect(sorted(regions[0]!.outer)).toEqual([1, 2, 3, 4]);
    expect(regions[0]!.area).toBeCloseTo(100);
    expect(regions[0]!.holes).toEqual([]);
  });

  it('returns nothing for an open chain', () => {
    expect(findRegions(square, squareEdges.slice(0, 3))).toEqual([]);
  });

  it('splits a square with a diagonal into two triangles', () => {
    const regions = findRegions(square, [...squareEdges, [1, 3]]);
    expect(regions.map((r) => sorted(r.outer)).sort()).toEqual([
      [1, 2, 3],
      [1, 3, 4],
    ]);
  });

  it('ignores a dangling edge inside a region', () => {
    const pts = graph({ 1: [0, 0], 2: [10, 0], 3: [10, 10], 4: [0, 10], 5: [5, 5] });
    const regions = findRegions(pts, [...squareEdges, [1, 5]]);
    expect(regions).toHaveLength(1);
    expect(sorted(regions[0]!.outer)).toEqual([1, 2, 3, 4]);
  });

  it('makes an island a hole of the surrounding region', () => {
    const pts = graph({
      1: [0, 0], 2: [10, 0], 3: [10, 10], 4: [0, 10],
      5: [3, 3], 6: [6, 3], 7: [6, 6], 8: [3, 6],
    }); // prettier-ignore
    const regions = findRegions(pts, [...squareEdges, [5, 6], [6, 7], [7, 8], [8, 5]]);
    expect(regions).toHaveLength(2);
    const big = regions.find((r) => r.area > 50)!;
    const small = regions.find((r) => r.area < 50)!;
    expect(big.holes).toHaveLength(1);
    expect(sorted(big.holes[0]!)).toEqual([5, 6, 7, 8]);
    expect(small.holes).toEqual([]);
  });

  it('treats a bridge to an island as not bounding anything', () => {
    const pts = graph({
      1: [0, 0], 2: [10, 0], 3: [10, 10], 4: [0, 10],
      5: [3, 3], 6: [6, 3], 7: [6, 6], 8: [3, 6],
    }); // prettier-ignore
    const regions = findRegions(pts, [...squareEdges, [5, 6], [6, 7], [7, 8], [8, 5], [1, 5]]);
    expect(regions).toHaveLength(2);
    expect(regions.find((r) => r.area > 50)!.holes).toHaveLength(1);
  });

  it('nests islands in the smallest surrounding region', () => {
    const pts = graph({
      1: [0, 0], 2: [100, 0], 3: [100, 100], 4: [0, 100],
      5: [10, 10], 6: [90, 10], 7: [90, 90], 8: [10, 90],
      9: [40, 40], 10: [60, 40], 11: [60, 60], 12: [40, 60],
    }); // prettier-ignore
    const loop = (a: number): [number, number][] => [
      [a, a + 1],
      [a + 1, a + 2],
      [a + 2, a + 3],
      [a + 3, a],
    ];
    const regions = findRegions(pts, [...loop(1), ...loop(5), ...loop(9)]);
    const byArea = [...regions].sort((a, b) => b.area - a.area);
    expect(sorted(byArea[0]!.holes[0]!)).toEqual([5, 6, 7, 8]);
    expect(sorted(byArea[1]!.holes[0]!)).toEqual([9, 10, 11, 12]);
    expect(byArea[2]!.holes).toEqual([]);
  });

  it('returns outer loops counter-clockwise and holes clockwise', () => {
    const pts = graph({
      1: [0, 0], 2: [10, 0], 3: [10, 10], 4: [0, 10],
      5: [3, 3], 6: [6, 3], 7: [6, 6], 8: [3, 6],
    }); // prettier-ignore
    const regions = findRegions(pts, [...squareEdges, [5, 6], [6, 7], [7, 8], [8, 5]]);
    const area = (ids: number[]) => {
      let a = 0;
      for (let i = 0; i < ids.length; i++) {
        const p = pts.get(ids[i]!)!;
        const q = pts.get(ids[(i + 1) % ids.length]!)!;
        a += p.x * q.y - q.x * p.y;
      }
      return a;
    };
    for (const r of regions) {
      expect(area(r.outer)).toBeGreaterThan(0);
      for (const h of r.holes) expect(area(h)).toBeLessThan(0);
    }
  });
});
