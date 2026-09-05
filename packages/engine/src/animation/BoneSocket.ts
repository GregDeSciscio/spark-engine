import * as THREE from 'three/webgpu';

/**
 * A mount that follows a bone's world position while the caller owns its
 * orientation: a weapon that sits in the hand but points where the player
 * aims, a lamp that hangs from a limb but stays upright. Inheriting the
 * bone's full transform would need IK to look right; taking position from the
 * pose and rotation from intent is what players expect.
 *
 * `object` lives under `parent` (an actor's root group, typically yawed by the
 * render sync); `update()` puts it at the bone each frame, plus an offset in
 * the parent's frame. Without a bone it sits at `fallback`.
 */
export interface BoneSocketOptions {
  /** Parent-space position used when there is no bone. */
  readonly fallback?: THREE.Vector3 | undefined;
  /** Parent-space offset added to the bone position (a grip a little ahead of the palm). */
  readonly offset?: THREE.Vector3 | undefined;
}

export class BoneSocket {
  readonly object = new THREE.Group();
  private readonly fallback = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    private bone: THREE.Object3D | null,
    options: BoneSocketOptions = {},
  ) {
    if (options.fallback) this.fallback.copy(options.fallback);
    if (options.offset) this.offset.copy(options.offset);
    this.object.position.copy(this.fallback);
    parent.add(this.object);
  }

  /** Swap the bone (a new model instance, a different hand). */
  setBone(bone: THREE.Object3D | null): void {
    this.bone = bone;
  }

  /** Place the mount for this frame. Reads the bone's world matrix, so call after the animation step. */
  update(): void {
    const parent = this.object.parent;
    if (this.bone && parent) {
      this.bone.updateWorldMatrix(true, false);
      this.bone.getWorldPosition(this.scratch);
      parent.worldToLocal(this.scratch);
      this.object.position.copy(this.scratch).add(this.offset);
    } else {
      this.object.position.copy(this.fallback);
    }
  }

  dispose(): void {
    this.object.removeFromParent();
  }
}

/** Find a bone (any Object3D) by name under a model instance. */
export function findBone(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  return found;
}
