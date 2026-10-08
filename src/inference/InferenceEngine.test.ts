import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../core/math';
import { Mesh } from '../core/Mesh';
import { drawPolyline, drawSegments } from '../core/ops';
import { CameraController } from '../viewport/CameraController';
import { AXIS_DIRS, InferenceEngine, viewFromCamera, type InferenceQuery } from './InferenceEngine';

const W = 1000;
const H = 800;

function setup(build: (mesh: Mesh) => void, view: 'top' | 'iso' = 'iso') {
  const mesh = new Mesh();
  build(mesh);
  const camera = new CameraController();
  camera.setSize(W, H);
  camera.lookAt(new THREE.Vector3(120, -150, 160), new THREE.Vector3(5, 5, 0));
  if (view === 'top') camera.setStandardView('top', false);
  camera.updateClipping(new THREE.Sphere(new THREE.Vector3(), 500));
  const engine = new InferenceEngine(mesh, viewFromCamera(camera, () => ({ width: W, height: H })));

  /** Query with the cursor over a world point, offset by some pixels. */
  const at = (p: Vec3, dx = 0, dy = 0, extra: Partial<InferenceQuery> = {}) => {
    const ndc = new THREE.Vector3(p.x, p.y, p.z).project(camera.camera);
    const x = ((ndc.x + 1) / 2) * W + dx;
    const y = ((1 - ndc.y) / 2) * H + dy;
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera.camera);
    return engine.infer({ x, y, ray: rc.ray, ...extra });
  };
  return { mesh, engine, camera, at };
}

const square = (m: Mesh) => drawPolyline(m, [new Vec3(0, 0, 0), new Vec3(10, 0, 0), new Vec3(10, 10, 0), new Vec3(0, 10, 0)], true);

describe('InferenceEngine', () => {
  it('snaps to an endpoint near the cursor', () => {
    const { at } = setup(square);
    const r = at(new Vec3(10, 10, 0), 4, -3);
    expect(r.kind).toBe('endpoint');
    expect(r.point.equals(new Vec3(10, 10, 0))).toBe(true);
  });

  it('snaps to a midpoint', () => {
    const { at } = setup(square);
    const r = at(new Vec3(5, 0, 0), 2, 2);
    expect(r.kind).toBe('midpoint');
    expect(r.point.equals(new Vec3(5, 0, 0))).toBe(true);
  });

  it('snaps onto an edge between its points', () => {
    const { at } = setup((m) => drawSegments(m, [[new Vec3(10, -40, 0), new Vec3(10, 60, 0)]]));
    const r = at(new Vec3(10, 30, 0), 2, 0);
    expect(r.kind).toBe('on-edge');
    expect(r.point.x).toBeCloseTo(10, 6);
    expect(r.point.z).toBeCloseTo(0, 6);
  });

  it('reports a point on a face', () => {
    const { at } = setup(square);
    const r = at(new Vec3(4, 6, 0));
    expect(r.kind).toBe('on-face');
    expect(r.point.distanceTo(new Vec3(4, 6, 0))).toBeLessThan(1e-6);
  });

  it('snaps to the origin', () => {
    const { at } = setup(() => {});
    expect(at(new Vec3(0, 0, 0), 3, 3).kind).toBe('origin');
  });

  it('falls back to a free point on the ground', () => {
    const { at } = setup(() => {});
    const r = at(new Vec3(40, 70, 0));
    expect(r.kind).toBe('free');
    expect(r.point.distanceTo(new Vec3(40, 70, 0))).toBeLessThan(1e-6);
  });

  it('ignores points hidden behind a face', () => {
    const { at } = setup((m) => {
      drawPolyline(m, [new Vec3(0, 0, 10), new Vec3(10, 0, 10), new Vec3(10, 10, 10), new Vec3(0, 10, 10)], true);
      drawSegments(m, [[new Vec3(5, 5, 0), new Vec3(30, 5, 0)]]);
    }, 'top');
    const r = at(new Vec3(5, 5, 0));
    expect(r.kind).toBe('on-face');
    expect(r.point.z).toBeCloseTo(10, 6);
  });

  it('infers an axis direction from the start point', () => {
    const { at } = setup(() => {});
    const from = new Vec3(20, 20, 0);
    // Cursor a few pixels off the red axis line through the start point.
    const r = at(new Vec3(50, 20, 0), 0, 4, { from });
    expect(r.kind).toBe('axis');
    expect(r.axis).toBe('x');
    expect(r.point.y).toBeCloseTo(20, 6);
    expect(r.point.z).toBeCloseTo(0, 6);
  });

  it('infers the blue axis upward from the start point', () => {
    const { at } = setup(() => {});
    const from = new Vec3(20, 20, 0);
    const r = at(new Vec3(20, 20, 30), 3, 0, { from });
    expect(r.axis).toBe('z');
    expect(r.point.x).toBeCloseTo(20, 6);
    expect(r.point.z).toBeGreaterThan(20);
  });

  it('a line lock constrains the point and projects snapped points onto it', () => {
    const { at } = setup((m) => drawSegments(m, [[new Vec3(40, 0, 25), new Vec3(40, 10, 25)]]));
    const from = new Vec3(0, 0, 0);
    const lock = { kind: 'line' as const, origin: from, dir: AXIS_DIRS.z, axis: 'z' as const, tooltip: 'On Blue Axis' };
    // Hovering an endpoint elsewhere picks up its height.
    const r = at(new Vec3(40, 0, 25), 0, 0, { from, lock });
    expect(r.kind).toBe('axis');
    expect(r.point.x).toBeCloseTo(0, 6);
    expect(r.point.y).toBeCloseTo(0, 6);
    expect(r.point.z).toBeCloseTo(25, 6);
    expect(r.ref?.equals(new Vec3(40, 0, 25))).toBe(true);
  });
});

describe('InferenceEngine visibility', () => {
  it('snaps to edges of the face under the cursor', () => {
    // A vertical wall seen at an angle: its bottom edge must win over "On Face".
    const { at } = setup((m) =>
      drawPolyline(m, [new Vec3(0, 0, 0), new Vec3(80, 0, 0), new Vec3(80, 0, 40), new Vec3(0, 0, 40)], true, { facing: new Vec3(0, -1, 0) }),
    );
    const r = at(new Vec3(40, 0, 0), 0, -2);
    expect(r.kind === 'on-edge' || r.kind === 'midpoint').toBe(true);
    expect(r.point.z).toBeCloseTo(0, 6);
  });
});

describe('InferenceEngine intersections and locked lines', () => {
  it('snaps to where an edge passes through a face', () => {
    const { at } = setup((m) => {
      drawPolyline(m, [new Vec3(0, 0, 0), new Vec3(60, 0, 0), new Vec3(60, 60, 0), new Vec3(0, 60, 0)], true);
      // A post through the floor, not drawn into it.
      m.addEdge(m.addVertex(new Vec3(30, 30, -10)), m.addVertex(new Vec3(30, 30, 30)));
    });
    const r = at(new Vec3(30, 30, 0), 3, 2);
    expect(r.kind).toBe('intersection');
    expect(r.point.distanceTo(new Vec3(30, 30, 0))).toBeLessThan(1e-9);
  });

  it('snaps to where two edges cross', () => {
    const { at } = setup((m) => {
      m.addEdge(m.addVertex(new Vec3(0, 20, 0)), m.addVertex(new Vec3(60, 20, 0)));
      m.addEdge(m.addVertex(new Vec3(25, 0, 0)), m.addVertex(new Vec3(25, 50, 0)));
    });
    const r = at(new Vec3(25, 20, 0), -3, 2);
    expect(r.kind).toBe('intersection');
    expect(r.point.distanceTo(new Vec3(25, 20, 0))).toBeLessThan(1e-9);
  });

  it('a locked line stops exactly where it meets a hovered edge', () => {
    const { at } = setup((m) => drawSegments(m, [[new Vec3(40, -20, 0), new Vec3(40, 30, 0)]]));
    const from = new Vec3(0, 0, 0);
    const lock = { kind: 'line' as const, origin: from, dir: AXIS_DIRS.x, axis: 'x' as const, tooltip: 'On Red Axis' };
    const r = at(new Vec3(40, 18, 0), 2, 0, { from, lock });
    expect(r.point.distanceTo(new Vec3(40, 0, 0))).toBeLessThan(1e-9);
    expect(r.refTooltip).toBe('On Edge');
  });

  it('a locked line stops exactly where it pierces a hovered face', () => {
    const { at } = setup((m) =>
      drawPolyline(m, [new Vec3(-10, -10, 25), new Vec3(30, -10, 25), new Vec3(30, 30, 25), new Vec3(-10, 30, 25)], true, { facing: Vec3.Z }),
    );
    const from = new Vec3(5, 5, 0);
    const lock = { kind: 'line' as const, origin: from, dir: AXIS_DIRS.z, axis: 'z' as const, tooltip: 'On Blue Axis' };
    // Cursor somewhere else on the face, away from its edges.
    const r = at(new Vec3(18, 12, 25), 0, 0, { from, lock });
    expect(r.point.distanceTo(new Vec3(5, 5, 25))).toBeLessThan(1e-9);
    expect(r.refTooltip).toBe('On Face');
  });
});

describe('InferenceEngine guides', () => {
  it('snaps to guide points and guide lines', () => {
    const { at } = setup((m) => {
      m.addGuidePoint(new Vec3(30, 30, 0));
      m.addGuideLine(new Vec3(0, 60, 0), Vec3.X);
    });
    expect(at(new Vec3(30, 30, 0), 3, 2).kind).toBe('guide-point');
    const onLine = at(new Vec3(-40, 60, 0), 0, 3);
    expect(onLine.kind).toBe('on-guide');
    expect(onLine.point.y).toBeCloseTo(60, 6);
  });

  it('snaps to where a guide crosses an edge', () => {
    const { at } = setup((m) => {
      m.addGuideLine(new Vec3(0, 25, 0), Vec3.X);
      drawSegments(m, [[new Vec3(40, 0, 0), new Vec3(40, 80, 0)]]);
    });
    const r = at(new Vec3(40, 25, 0), 2, -2);
    expect(r.kind).toBe('intersection');
    expect(r.point.distanceTo(new Vec3(40, 25, 0))).toBeLessThan(1e-9);
  });

  it('snaps to where two guides cross', () => {
    const { at } = setup((m) => {
      m.addGuideLine(new Vec3(0, 25, 0), Vec3.X);
      m.addGuideLine(new Vec3(15, 0, 0), Vec3.Y);
    });
    const r = at(new Vec3(15, 25, 0), -2, 2);
    expect(r.kind).toBe('intersection');
    expect(r.point.distanceTo(new Vec3(15, 25, 0))).toBeLessThan(1e-9);
  });
});
