import * as THREE from 'three';

/**
 * Clips segment a→b to the half-space at least `minDepth` in front of the camera.
 * Returns the visible part, or null if the segment is entirely behind.
 * Needed because perspective projection of points behind the camera is meaningless.
 */
export function clipSegmentInFront(
  a: THREE.Vector3,
  b: THREE.Vector3,
  camPos: THREE.Vector3,
  camDir: THREE.Vector3,
  minDepth: number,
): [THREE.Vector3, THREE.Vector3] | null {
  const da = a.clone().sub(camPos).dot(camDir) - minDepth;
  const db = b.clone().sub(camPos).dot(camDir) - minDepth;
  if (da < 0 && db < 0) return null;
  if (da >= 0 && db >= 0) return [a.clone(), b.clone()];
  const cut = a.clone().lerp(b, da / (da - db));
  return da >= 0 ? [a.clone(), cut] : [cut, b.clone()];
}
