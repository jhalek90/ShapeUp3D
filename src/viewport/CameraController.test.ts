import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CameraController, STANDARD_VIEWS, type Projection, type StandardView } from './CameraController';

const W = 1200;
const H = 800;

function make(projection: Projection = 'perspective'): CameraController {
  const c = new CameraController();
  c.setSize(W, H);
  c.setProjection(projection);
  return c;
}

function expectVec(actual: THREE.Vector3 | THREE.Vector2, expected: THREE.Vector3 | THREE.Vector2, digits = 6) {
  expect(actual.toArray().length).toBe(expected.toArray().length);
  actual.toArray().forEach((v, i) => expect(v).toBeCloseTo(expected.toArray()[i]!, digits));
}

const projections: Projection[] = ['perspective', 'parallel'];

describe('CameraController orbit', () => {
  it('keeps the pivot fixed on screen', () => {
    const c = make();
    const pivot = new THREE.Vector3(80, 20, 10);
    const before = c.projectToNdc(pivot);
    c.orbit(137, -64, pivot);
    expectVec(c.projectToNdc(pivot), before);
  });

  it('keeps the horizon level after many orbits', () => {
    const c = make();
    const pivot = new THREE.Vector3(10, -40, 5);
    for (let i = 0; i < 200; i++) c.orbit(Math.sin(i) * 40, Math.cos(i * 1.3) * 40, pivot);
    expect(c.right.z).toBeCloseTo(0, 9);
    expect(c.up.z).toBeGreaterThanOrEqual(0);
  });

  it('clamps at straight down instead of flipping over the top', () => {
    const c = make();
    c.orbit(0, 5000, c.target);
    expect(c.forward.z).toBeCloseTo(-1, 9);
    c.orbit(0, 500, c.target);
    expect(c.forward.z).toBeCloseTo(-1, 9);
    expect(c.up.z).toBeGreaterThanOrEqual(-1e-9);
    // Can still orbit back out of the top view.
    c.orbit(0, -200, c.target);
    expect(c.forward.z).toBeGreaterThan(-1);
  });

  it('dragging down raises the camera', () => {
    const c = make();
    const pivot = c.target;
    const before = c.position.z;
    c.orbit(0, 50, pivot);
    expect(c.position.z).toBeGreaterThan(before);
  });
});

describe.each(projections)('CameraController (%s)', (projection) => {
  it('pan keeps the grabbed point under the cursor', () => {
    const c = make(projection);
    const anchor = new THREE.Vector3(120, 60, 0);
    const before = c.projectToNdc(anchor);
    c.pan(40, -25, c.depthOf(anchor));
    const after = c.projectToNdc(anchor);
    expect(after.x - before.x).toBeCloseTo((2 * 40) / W, 6);
    expect(after.y - before.y).toBeCloseTo((2 * 25) / H, 6);
  });

  it('zoomAt keeps the zoom point fixed on screen', () => {
    const c = make(projection);
    const point = new THREE.Vector3(150, 90, 0);
    const before = c.projectToNdc(point);
    const distance = c.distance;
    c.zoomAt(point, 0.5);
    expectVec(c.projectToNdc(point), before);
    expect(c.distance).toBeCloseTo(distance * 0.5, 9);
  });

  it('zoomAt never reaches the zoom point', () => {
    const c = make(projection);
    const point = c.target;
    for (let i = 0; i < 100; i++) c.zoomAt(point, 0.01);
    expect(c.distance).toBeGreaterThan(0);
    expect(c.position.distanceTo(point)).toBeGreaterThan(0);
  });

  it('zoomExtents fits the whole box on screen', () => {
    const c = make(projection);
    c.orbit(300, 120, c.target);
    const box = new THREE.Box3(new THREE.Vector3(-500, 200, 0), new THREE.Vector3(-100, 900, 300));
    c.zoomExtents(box.getBoundingSphere(new THREE.Sphere()), false);
    c.updateClipping(box.getBoundingSphere(new THREE.Sphere()));
    for (let i = 0; i < 8; i++) {
      const corner = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      const ndc = corner.clone().project(c.camera);
      expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(ndc.z)).toBeLessThanOrEqual(1); // inside near/far
    }
  });

  it('centerOn moves a point to the middle of the screen', () => {
    const c = make(projection);
    const point = new THREE.Vector3(200, 150, 40);
    c.centerOn(point, false);
    expectVec(c.projectToNdc(point), new THREE.Vector2(0, 0));
  });
});

describe('CameraController views and projection', () => {
  it('toggling projection keeps the focus plane the same size', () => {
    const c = make('perspective');
    // A point on the focus plane, offset sideways and up.
    const p = c.target.addScaledVector(c.right, 37).addScaledVector(c.up, -21);
    const persp = c.projectToNdc(p);
    c.toggleProjection();
    expect(c.projection).toBe('parallel');
    expectVec(c.projectToNdc(p), persp);
  });

  it.each(Object.keys(STANDARD_VIEWS) as StandardView[])('%s view has the expected orientation', (view) => {
    const c = make();
    const target = c.target;
    c.setStandardView(view, false);
    const { forward } = STANDARD_VIEWS[view];
    expectVec(c.forward, new THREE.Vector3(...forward).normalize());
    expectVec(c.target, target, 4);
    expect(c.right.z).toBeCloseTo(0, 9);
  });

  it('standard views put the red axis to the right where it is visible', () => {
    for (const view of ['top', 'bottom', 'front', 'back', 'iso'] as const) {
      const c = make();
      c.setStandardView(view, false);
      const xDir = new THREE.Vector3(1, 0, 0).dot(c.right);
      if (view === 'back') expect(xDir).toBeLessThan(0);
      else expect(xDir).toBeGreaterThan(0);
    }
  });

  it('updateClipping keeps the scene between near and far', () => {
    const c = make();
    const sphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 5000);
    c.updateClipping(sphere);
    expect(c.perspective.near).toBeGreaterThan(0);
    expect(c.perspective.near).toBeLessThan(c.distance);
    expect(c.perspective.far).toBeGreaterThan(c.position.distanceTo(sphere.center) + sphere.radius);
  });

  it('pointAtDepth returns a point at the requested depth on the ray', () => {
    for (const projection of projections) {
      const c = make(projection);
      c.updateClipping(new THREE.Sphere(new THREE.Vector3(), 500));
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(0.3, -0.4), c.camera);
      const p = c.pointAtDepth(ray.ray, 123);
      expect(c.depthOf(p)).toBeCloseTo(123, 6);
      expect(ray.ray.distanceToPoint(p)).toBeCloseTo(0, 6);
    }
  });
});
