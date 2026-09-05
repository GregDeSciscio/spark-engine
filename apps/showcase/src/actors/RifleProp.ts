import * as THREE from 'three/webgpu';
import { BoneSocket } from '@spark/engine';

/**
 * A placeholder rifle that rides in a character's weapon socket. The pose owns
 * where the hand is; the shooter's view owns where the barrel points, so the
 * prop sits on a `BoneSocket` (position from the bone, orientation from the
 * aim) instead of inheriting the bone's twist, which would need hand IK to
 * look right with a two-handed grip. Until a real weapon model lands.
 */
export class RifleProp {
  readonly group: THREE.Group;
  /** Where shots leave the barrel, in world space via `getWorldPosition`. */
  readonly muzzle = new THREE.Object3D();
  private readonly socket: BoneSocket;
  private readonly parts: { dispose(): void }[] = [];

  /**
   * @param parent the actor's entity group (yawed by the render sync)
   * @param hand the right hand bone, or null to sit at a fixed offset
   * @param fallback group-local position used when there is no hand
   */
  constructor(parent: THREE.Object3D, hand: THREE.Object3D | null, fallback: THREE.Vector3, color = 0x4a4f58) {
    // The grip sits a little ahead of and above the palm so the receiver clears the fingers.
    this.socket = new BoneSocket(parent, hand, { fallback, offset: new THREE.Vector3(0, 0.02, 0.04) });
    this.group = this.socket.object;
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.7 });
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.07, 0.34), material);
    receiver.position.set(0, 0.02, 0.1);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.36, 8), material);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.04, 0.43);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.22), material);
    stock.position.set(0, 0.0, -0.17);
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.12, 0.06), material);
    mag.position.set(0, -0.07, 0.12);
    for (const m of [receiver, barrel, stock, mag]) {
      m.castShadow = true;
      this.group.add(m);
    }
    this.parts.push(receiver.geometry, barrel.geometry, stock.geometry, mag.geometry, material);
    this.muzzle.position.set(0, 0.04, 0.62);
    this.group.add(this.muzzle);
  }

  /**
   * Place the prop for this frame. `pitch` is the aim pitch in radians,
   * positive looking down (the group's +Z is the body's forward). The hand
   * position is read from the bone's world matrix, so call this after the
   * animation step.
   */
  update(pitch: number): void {
    this.socket.update();
    this.group.rotation.set(pitch, 0, 0);
  }

  dispose(): void {
    this.socket.dispose();
    for (const p of this.parts) p.dispose();
  }
}
