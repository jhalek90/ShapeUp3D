import * as THREE from 'three';

// SketchUp-style camera. Holds one pose (position + orientation + focus distance)
// and drives both a perspective and a parallel (orthographic) camera from it.
//
// Conventions: Z is up and the horizon is always kept level (the camera never
// rolls). `distance` is the focus distance: the target point sits that far in
// front of the camera, and in parallel projection it sets the zoom level, so
// toggling projection keeps things at the target depth the same size.
//
// This class has no DOM dependencies so it can be unit-tested in Node.

export type Projection = 'perspective' | 'parallel';
export type StandardView = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

export const STANDARD_VIEWS: Record<StandardView, { forward: THREE.Vector3Tuple; up: THREE.Vector3Tuple }> = {
  iso: { forward: [-1, 1, -1], up: [0, 0, 1] },
  top: { forward: [0, 0, -1], up: [0, 1, 0] },
  bottom: { forward: [0, 0, 1], up: [0, -1, 0] },
  front: { forward: [0, 1, 0], up: [0, 0, 1] },
  back: { forward: [0, -1, 0], up: [0, 0, 1] },
  left: { forward: [1, 0, 0], up: [0, 0, 1] },
  right: { forward: [-1, 0, 0], up: [0, 0, 1] },
};

/** Orbit speed in radians per viewport height of mouse travel. */
const ORBIT_SPEED = 1.25 * Math.PI;
const MIN_DISTANCE = 1e-3;
const TRANSITION_MS = 300;
/** Extra room left around the model by Zoom Extents. */
const EXTENTS_MARGIN = 1.08;

interface Pose {
  target: THREE.Vector3;
  distance: number;
  quaternion: THREE.Quaternion;
}

export class CameraController {
  readonly perspective = new THREE.PerspectiveCamera(35, 1, 1, 1000);
  readonly parallel = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();

  private _distance = 1;
  private _projection: Projection = 'perspective';
  private width = 1;
  private height = 1;
  private transition: { from: Pose; to: Pose; start: number } | null = null;

  constructor() {
    this.perspective.up.set(0, 0, 1);
    this.parallel.up.set(0, 0, 1);
    this.lookAt(new THREE.Vector3(250, -350, 220), new THREE.Vector3(50, 50, 0));
  }

  // ---- State ---------------------------------------------------------------

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this._projection === 'perspective' ? this.perspective : this.parallel;
  }

  get projection(): Projection {
    return this._projection;
  }

  get distance(): number {
    return this._distance;
  }

  /** Vertical field of view in degrees (also sets the parallel projection scale). */
  get fov(): number {
    return this.perspective.fov;
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
  }

  get right(): THREE.Vector3 {
    return new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion);
  }

  get up(): THREE.Vector3 {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
  }

  get target(): THREE.Vector3 {
    return this.position.clone().addScaledVector(this.forward, this._distance);
  }

  get isAnimating(): boolean {
    return this.transition !== null;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.apply();
  }

  setProjection(projection: Projection): void {
    this._projection = projection;
    this.apply();
  }

  toggleProjection(): void {
    this.setProjection(this._projection === 'perspective' ? 'parallel' : 'perspective');
  }

  setFov(degrees: number): void {
    this.perspective.fov = THREE.MathUtils.clamp(degrees, 1, 120);
    this.apply();
  }

  lookAt(position: THREE.Vector3, target: THREE.Vector3): void {
    this.transition = null;
    const forward = target.clone().sub(position);
    this.position.copy(position);
    this._distance = Math.max(forward.length(), MIN_DISTANCE);
    this.quaternion.copy(orientation(forward, new THREE.Vector3(0, 0, 1)));
    this.apply();
  }

  // ---- Navigation ----------------------------------------------------------

  /** Orbits around `pivot` by a mouse movement in pixels ("grab the model" direction). */
  orbit(dxPx: number, dyPx: number, pivot: THREE.Vector3): void {
    this.transition = null;
    const anglePerPx = ORBIT_SPEED / this.height;
    const yaw = -dxPx * anglePerPx;

    // Dragging down lifts the camera, i.e. lowers the view elevation; clamp at straight up/down.
    const elevation = Math.asin(THREE.MathUtils.clamp(this.forward.z, -1, 1));
    const newElevation = THREE.MathUtils.clamp(elevation - dyPx * anglePerPx, -Math.PI / 2, Math.PI / 2);
    const pitch = newElevation - elevation;

    const rotation = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(this.right, pitch));

    this.position.sub(pivot).applyQuaternion(rotation).add(pivot);
    this.quaternion.premultiply(rotation);
    this.level();
    this.apply();
  }

  /** Pans by a mouse movement in pixels, so a point at `depth` stays under the cursor. */
  pan(dxPx: number, dyPx: number, depth = this._distance): void {
    this.transition = null;
    const w = this.worldPerPixel(depth);
    this.position.addScaledVector(this.right, -dxPx * w).addScaledVector(this.up, dyPx * w);
    this.apply();
  }

  /**
   * Zooms by scaling the whole view about `point` (factor < 1 zooms in).
   * The point keeps its screen position in both projections.
   */
  zoomAt(point: THREE.Vector3, factor: number): void {
    this.transition = null;
    if (!(factor > 0)) return;
    // Don't let the camera reach the zoom point or the focus distance collapse.
    const toPoint = this.position.distanceTo(point);
    const minFactor = Math.max(MIN_DISTANCE / this._distance, toPoint > 0 ? MIN_DISTANCE / toPoint : 0);
    factor = Math.max(factor, minFactor);
    this.position.sub(point).multiplyScalar(factor).add(point);
    this._distance *= factor;
    this.apply();
  }

  /** Pans so `point` is in the centre of the view (and, in perspective, becomes the focus). */
  centerOn(point: THREE.Vector3, animate = true): void {
    const forward = this.forward;
    const depth = point.clone().sub(this.position).dot(forward);
    if (this._projection === 'perspective' && depth <= MIN_DISTANCE) return;
    const distance = this._projection === 'perspective' ? depth : this._distance;
    this.animateTo({ target: point.clone(), distance, quaternion: this.quaternion.clone() }, animate);
  }

  /** Fits a bounding sphere in view, keeping the current direction. */
  zoomExtents(sphere: THREE.Sphere, animate = true): void {
    const r = Math.max(sphere.radius, 1);
    const halfV = THREE.MathUtils.degToRad(this.fov) / 2;
    const aspect = this.width / this.height;
    let distance: number;
    if (this._projection === 'perspective') {
      const halfH = Math.atan(Math.tan(halfV) * aspect);
      distance = (r * EXTENTS_MARGIN) / Math.sin(Math.min(halfV, halfH));
    } else {
      distance = (r * EXTENTS_MARGIN * Math.max(1, 1 / aspect)) / Math.tan(halfV);
    }
    this.animateTo({ target: sphere.center.clone(), distance, quaternion: this.quaternion.clone() }, animate);
  }

  /** Looks along a standard direction, keeping the current target and distance. */
  setStandardView(view: StandardView, animate = true): void {
    const { forward, up } = STANDARD_VIEWS[view];
    const quaternion = orientation(new THREE.Vector3(...forward), new THREE.Vector3(...up));
    this.animateTo({ target: this.target, distance: this._distance, quaternion }, animate);
  }

  // ---- Per-frame -----------------------------------------------------------

  /** Advances any running transition. Returns true if the view changed. */
  update(now: number): boolean {
    const tr = this.transition;
    if (!tr) return false;
    const t = Math.min(1, (now - tr.start) / TRANSITION_MS);
    const e = t * t * (3 - 2 * t); // smoothstep
    this.setPose({
      target: tr.from.target.clone().lerp(tr.to.target, e),
      // Interpolate distance geometrically so big zoom changes feel even.
      distance: tr.from.distance * Math.pow(tr.to.distance / tr.from.distance, e),
      quaternion: tr.from.quaternion.clone().slerp(tr.to.quaternion, e),
    });
    if (t >= 1) this.transition = null;
    return true;
  }

  /** Sets near/far planes so `sphere` (everything drawn) is inside the view volume. */
  updateClipping(sphere: THREE.Sphere): void {
    const d = this.position.distanceTo(sphere.center);
    const r = sphere.radius;
    const extent = Math.max(d + r, this._distance) * 4;

    // Perspective: keep near as far out as possible for depth precision,
    // but never beyond the focus point or the nearest scene geometry.
    let near = Math.max((d - r) * 0.5, extent * 1e-5);
    near = Math.max(Math.min(near, this._distance * 0.5), 1e-4);
    this.perspective.near = near;
    this.perspective.far = extent;
    this.perspective.updateProjectionMatrix();

    // Parallel: depth is linear, so a symmetric range around the camera is fine and
    // nothing gets clipped when zooming "into" the model.
    this.parallel.near = -extent;
    this.parallel.far = extent;
    this.parallel.updateProjectionMatrix();
  }

  // ---- Helpers -------------------------------------------------------------

  /** World units per screen pixel at the given depth in front of the camera. */
  worldPerPixel(depth = this._distance): number {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.fov) / 2);
    const d = this._projection === 'perspective' ? depth : this._distance;
    return (2 * d * tanHalf) / this.height;
  }

  /** Depth of a point along the view direction. */
  depthOf(point: THREE.Vector3): number {
    return point.clone().sub(this.position).dot(this.forward);
  }

  /** The point on `ray` at the given depth in front of the camera. */
  pointAtDepth(ray: THREE.Ray, depth: number): THREE.Vector3 {
    const forward = this.forward;
    const along = ray.direction.dot(forward);
    const originDepth = ray.origin.clone().sub(this.position).dot(forward);
    const t = Math.abs(along) < 1e-12 ? 0 : (depth - originDepth) / along;
    return ray.at(t, new THREE.Vector3());
  }

  /** Normalized device coordinates (-1..1) of a world point. */
  projectToNdc(point: THREE.Vector3): THREE.Vector2 {
    const p = point.clone().project(this.camera);
    return new THREE.Vector2(p.x, p.y);
  }

  private animateTo(pose: Pose, animate: boolean): void {
    if (!animate) {
      this.transition = null;
      this.setPose(pose);
      return;
    }
    this.transition = {
      from: { target: this.target, distance: this._distance, quaternion: this.quaternion.clone() },
      to: pose,
      start: performance.now(),
    };
  }

  private setPose(pose: Pose): void {
    this.quaternion.copy(pose.quaternion);
    this._distance = Math.max(pose.distance, MIN_DISTANCE);
    this.position.copy(pose.target).addScaledVector(this.forward, -this._distance);
    this.apply();
  }

  /** Removes accumulated roll so the camera's right vector stays horizontal. */
  private level(): void {
    const right = this.right.setZ(0);
    if (right.lengthSq() < 1e-12) return;
    right.normalize();
    const forward = this.forward;
    forward.addScaledVector(right, -forward.dot(right)).normalize();
    const up = right.clone().cross(forward);
    const m = new THREE.Matrix4().makeBasis(right, up, forward.negate());
    this.quaternion.setFromRotationMatrix(m);
  }

  /** Pushes the pose into both three.js cameras. */
  private apply(): void {
    const aspect = this.width / this.height;
    for (const cam of [this.perspective, this.parallel]) {
      cam.position.copy(this.position);
      cam.quaternion.copy(this.quaternion);
    }
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();

    const halfH = this._distance * Math.tan(THREE.MathUtils.degToRad(this.fov) / 2);
    this.parallel.top = halfH;
    this.parallel.bottom = -halfH;
    this.parallel.left = -halfH * aspect;
    this.parallel.right = halfH * aspect;
    this.parallel.updateProjectionMatrix();

    this.perspective.updateMatrixWorld(true);
    this.parallel.updateMatrixWorld(true);
  }
}

/** Camera orientation looking along `forward` with `up` as the screen-up hint. */
function orientation(forward: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const f = forward.clone().normalize();
  let r = f.clone().cross(up);
  if (r.lengthSq() < 1e-12) r = f.clone().cross(new THREE.Vector3(0, 1, 0)); // looking straight along `up`
  r.normalize();
  const u = r.clone().cross(f);
  const m = new THREE.Matrix4().makeBasis(r, u, f.negate());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
