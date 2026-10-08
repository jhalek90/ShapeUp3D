import { Vec3 } from './math';

// STL reading and writing. STL is a bare list of triangles with no units; by
// convention (and for every slicer) the numbers are millimetres.

export type Triangle = [Vec3, Vec3, Vec3];

/** Parses binary or ASCII STL. Throws an Error with a readable message on bad input. */
export function parseSTL(data: ArrayBuffer): Triangle[] {
  if (data.byteLength >= 84) {
    const view = new DataView(data);
    const count = view.getUint32(80, true);
    // Binary files have an exact size; some start with "solid" too, so check the size first.
    if (84 + count * 50 === data.byteLength) return parseBinary(view, count);
  }
  const text = new TextDecoder().decode(data);
  if (/^\s*solid/i.test(text) && /facet/i.test(text)) return parseAscii(text);
  if (data.byteLength >= 84) {
    throw new Error('This STL file is damaged (its size does not match its triangle count).');
  }
  throw new Error('This is not an STL file.');
}

function parseBinary(view: DataView, count: number): Triangle[] {
  const tris: Triangle[] = [];
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50 + 12; // skip the stored normal; it's recomputed from the winding
    const v = (k: number) => new Vec3(view.getFloat32(o + k * 12, true), view.getFloat32(o + k * 12 + 4, true), view.getFloat32(o + k * 12 + 8, true));
    tris.push([v(0), v(1), v(2)]);
  }
  return tris;
}

function parseAscii(text: string): Triangle[] {
  const tris: Triangle[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  const pts: Vec3[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const p = new Vec3(Number(m[1]), Number(m[2]), Number(m[3]));
    if (![p.x, p.y, p.z].every(Number.isFinite)) throw new Error('This STL file has an invalid number in it.');
    pts.push(p);
  }
  if (pts.length % 3 !== 0) throw new Error('This STL file is damaged (incomplete triangle).');
  for (let i = 0; i < pts.length; i += 3) tris.push([pts[i]!, pts[i + 1]!, pts[i + 2]!]);
  return tris;
}

function normalOf([a, b, c]: Triangle): Vec3 {
  return b.sub(a).cross(c.sub(a)).normalize();
}

export function writeBinarySTL(tris: readonly Triangle[], header = 'ShapeUp3d'): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  const h = new TextEncoder().encode(header.slice(0, 80));
  new Uint8Array(buf, 0, h.length).set(h);
  view.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    let o = 84 + i * 50;
    for (const v of [normalOf(t), ...t]) {
      view.setFloat32(o, v.x, true);
      view.setFloat32(o + 4, v.y, true);
      view.setFloat32(o + 8, v.z, true);
      o += 12;
    }
  });
  return buf;
}

export function writeAsciiSTL(tris: readonly Triangle[], name = 'shapeup3d'): string {
  const f = (n: number) => (Object.is(n, -0) ? 0 : n).toPrecision(9).replace(/\.?0+(e|$)/, '$1');
  const lines = [`solid ${name}`];
  for (const t of tris) {
    const n = normalOf(t);
    lines.push(`  facet normal ${f(n.x)} ${f(n.y)} ${f(n.z)}`, '    outer loop');
    for (const v of t) lines.push(`      vertex ${f(v.x)} ${f(v.y)} ${f(v.z)}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n') + '\n';
}
