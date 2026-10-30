import type * as THREE from 'three/webgpu';
import { Fn, positionPrevious } from 'three/tsl';

/**
 * The velocity MRT (motion blur, TAA) and materials that place their own
 * vertices. Three's `VelocityNode` measures motion from `positionLocal` (this
 * frame) to `positionPrevious` (last frame). Instancing and skinning set the
 * previous position; a material that moves its vertices in `positionNode`
 * (a matrix from a texture, a particle from a storage buffer) must set it
 * too. Otherwise the previous position is the raw `position` attribute, the
 * rest pose or a quad corner near the origin, and motion blur smears the
 * object from there into translucent ghosts.
 */

/** Whether this build writes velocity. Three's node builder knows; `@types/three` leaves it out. */
export function writesVelocity(builder: THREE.NodeBuilder): boolean {
  return (builder as unknown as { needsPreviousData(): boolean }).needsPreviousData();
}

/**
 * `position` (a `positionNode`) with no motion of its own in the velocity
 * pass: last frame's position is taken to be this frame's, so only the
 * camera's motion blurs it. Right for alpha-blended effects (particles,
 * smoke) that drift slowly or already stretch along their velocity.
 */
export function withoutOwnMotion(position: THREE.Node<'vec3'>): THREE.Node<'vec3'> {
  return Fn((builder) => {
    if (writesVelocity(builder)) positionPrevious.assign(position);
    return position;
  })() as unknown as THREE.Node<'vec3'>;
}
