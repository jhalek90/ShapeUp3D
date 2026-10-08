import { pointInPolygon2D, signedArea2D, type Vec2 } from './math';

// Finds the enclosed regions of a planar straight-line graph in 2D.
//
// The graph must already be split at every crossing (ops.insertSegment guarantees
// that), so edges only meet at shared vertices.
//
// Method: walk every half-edge, always turning to the next edge clockwise at each
// vertex. Each walk traces the boundary of one region, with the region on the left.
// Counter-clockwise walks (positive area) are region outlines; clockwise walks are
// the outside of a connected cluster of edges, which become holes in whichever
// region surrounds them. Edges that the same walk passes along both sides of (dangling
// edges, or bridges joining an island to its surroundings) don't bound anything, so
// they're dropped and the walk repeated.

export interface PlanarRegion {
  /** Vertex ids, counter-clockwise. */
  outer: number[];
  /** Vertex id loops, clockwise. */
  holes: number[][];
  /** Area of the outer loop (holes not subtracted). */
  area: number;
}

const AREA_EPS = 1e-9;

export function findRegions(points: ReadonlyMap<number, Vec2>, edges: Iterable<readonly [number, number]>): PlanarRegion[] {
  const pt = (id: number): Vec2 => {
    const p = points.get(id);
    if (!p) throw new Error(`No point for vertex ${id}`);
    return p;
  };

  let active = new Map<string, [number, number]>();
  for (const [a, b] of edges) {
    if (a === b) continue;
    active.set(edgeKey(a, b), a < b ? [a, b] : [b, a]);
  }

  let cycles: number[][] = [];
  for (;;) {
    cycles = traceCycles(active, pt);
    // Drop edges a single walk passes along both sides of.
    const drop = new Set<string>();
    for (const cycle of cycles) {
      const seen = new Set<string>();
      for (let i = 0; i < cycle.length; i++) {
        const key = edgeKey(cycle[i]!, cycle[(i + 1) % cycle.length]!);
        if (seen.has(key)) drop.add(key);
        seen.add(key);
      }
    }
    if (drop.size === 0) break;
    active = new Map([...active].filter(([key]) => !drop.has(key)));
  }

  // Connected components, so a cluster's outside walk isn't made a hole of its own regions.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of active.values()) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }

  const regions: (PlanarRegion & { comp: number; poly: Vec2[] })[] = [];
  const outsides: { ids: number[]; comp: number }[] = [];
  for (const ids of cycles) {
    const poly = ids.map(pt);
    const area = signedArea2D(poly);
    if (area > AREA_EPS) regions.push({ outer: ids, holes: [], area, comp: find(ids[0]!), poly });
    else if (area < -AREA_EPS) outsides.push({ ids, comp: find(ids[0]!) });
  }

  // Each cluster outside becomes a hole of the smallest region (of another cluster) around it.
  for (const out of outsides) {
    const probe = pt(out.ids[0]!);
    let best: (typeof regions)[number] | undefined;
    for (const r of regions) {
      if (r.comp === out.comp) continue;
      if (best && r.area >= best.area) continue;
      if (pointInPolygon2D(probe, r.poly)) best = r;
    }
    best?.holes.push(out.ids);
  }

  return regions.map(({ outer, holes, area }) => ({ outer, holes, area }));
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

function traceCycles(active: Map<string, [number, number]>, pt: (id: number) => Vec2): number[][] {
  // Neighbours of each vertex sorted counter-clockwise by angle.
  const adj = new Map<number, number[]>();
  for (const [a, b] of active.values()) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  for (const [v, ns] of adj) {
    const p = pt(v);
    const angle = new Map(ns.map((n) => [n, Math.atan2(pt(n).y - p.y, pt(n).x - p.x)]));
    ns.sort((m, n) => angle.get(m)! - angle.get(n)!);
  }

  const visited = new Set<string>();
  const cycles: number[][] = [];
  for (const [a, b] of active.values()) {
    for (const [u0, v0] of [
      [a, b],
      [b, a],
    ] as const) {
      if (visited.has(`${u0}>${v0}`)) continue;
      const cycle: number[] = [];
      let u = u0;
      let v = v0;
      // Bounded by the number of half-edges; guards against malformed input.
      for (let guard = 0; guard <= active.size * 2; guard++) {
        visited.add(`${u}>${v}`);
        cycle.push(u);
        const ns = adj.get(v)!;
        const i = ns.indexOf(u);
        const w = ns[(i - 1 + ns.length) % ns.length]!; // next clockwise from the way back
        u = v;
        v = w;
        if (u === u0 && v === v0) break;
      }
      cycles.push(cycle);
    }
  }
  return cycles;
}
