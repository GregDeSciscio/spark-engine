import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { BoneSocket, findBone } from '../src/animation/BoneSocket';

/**
 * The mount a held weapon hangs from: position comes from the bone's pose,
 * orientation stays with whoever owns the aim. The lesson it encodes is in
 * `docs/architecture/lessons-from-the-showcase.md` — inheriting the bone's
 * twist needs two-hand IK to look right, and the view direction is what a
 * player expects the barrel to follow.
 */

function rig(): { root: THREE.Object3D; hand: THREE.Object3D } {
  const root = new THREE.Object3D();
  root.name = 'root';
  const arm = new THREE.Object3D();
  arm.name = 'mixamorigRightArm';
  const hand = new THREE.Object3D();
  hand.name = 'mixamorigRightHand';
  arm.position.set(0, 1.4, 0);
  hand.position.set(0.3, 0, 0.1);
  arm.add(hand);
  root.add(arm);
  return { root, hand };
}

describe('BoneSocket', () => {
  it('parents its object and starts at the fallback', () => {
    const parent = new THREE.Group();
    const socket = new BoneSocket(parent, null, { fallback: new THREE.Vector3(0.2, 1.3, 0.1) });
    expect(socket.object.parent).toBe(parent);
    expect(socket.object.position.toArray()).toEqual([0.2, 1.3, 0.1]);
  });

  it('sits at the bone in the parent frame, plus the offset', () => {
    const parent = new THREE.Group();
    const { root, hand } = rig();
    parent.add(root);
    const socket = new BoneSocket(parent, hand, { offset: new THREE.Vector3(0, 0, 0.05) });
    socket.update();
    // hand world position is arm (0,1.4,0) + hand (0.3,0,0.1); parent is at the origin.
    expect(socket.object.position.x).toBeCloseTo(0.3, 5);
    expect(socket.object.position.y).toBeCloseTo(1.4, 5);
    expect(socket.object.position.z).toBeCloseTo(0.15, 5);
  });

  it('follows the bone as the pose changes', () => {
    const parent = new THREE.Group();
    const { root, hand } = rig();
    parent.add(root);
    const socket = new BoneSocket(parent, hand);
    socket.update();
    const before = socket.object.position.clone();
    hand.position.set(0.5, 0.2, -0.4);
    socket.update();
    expect(socket.object.position.equals(before)).toBe(false);
    expect(socket.object.position.x).toBeCloseTo(0.5, 5);
    expect(socket.object.position.y).toBeCloseTo(1.6, 5);
    expect(socket.object.position.z).toBeCloseTo(-0.4, 5);
  });

  it('reads the bone in the parent frame, not the world frame', () => {
    // The actor's root is yawed and moved by the render sync every frame; the
    // socket lives under it, so a moved parent must not drag the mount away
    // from the hand.
    const parent = new THREE.Group();
    const { root, hand } = rig();
    parent.add(root);
    const socket = new BoneSocket(parent, hand);
    socket.update();
    const local = socket.object.position.clone();
    parent.position.set(12, 0, -30);
    parent.rotation.y = Math.PI / 3;
    parent.updateWorldMatrix(true, true);
    socket.update();
    expect(socket.object.position.x).toBeCloseTo(local.x, 5);
    expect(socket.object.position.y).toBeCloseTo(local.y, 5);
    expect(socket.object.position.z).toBeCloseTo(local.z, 5);
  });

  it('never inherits the bone rotation', () => {
    const parent = new THREE.Group();
    const { root, hand } = rig();
    parent.add(root);
    const socket = new BoneSocket(parent, hand);
    socket.object.rotation.set(0, 0.75, 0); // whoever owns the aim set this
    hand.rotation.set(1.1, -0.4, 0.9);
    socket.update();
    expect(socket.object.rotation.x).toBe(0);
    expect(socket.object.rotation.y).toBe(0.75);
    expect(socket.object.rotation.z).toBe(0);
  });

  it('falls back when the bone goes away, and picks a new one up', () => {
    const parent = new THREE.Group();
    const { root, hand } = rig();
    parent.add(root);
    const socket = new BoneSocket(parent, hand, { fallback: new THREE.Vector3(0.26, 1.32, 0.12) });
    socket.update();
    expect(socket.object.position.x).toBeCloseTo(0.3, 5);
    socket.setBone(null);
    socket.update();
    expect(socket.object.position.toArray()).toEqual([0.26, 1.32, 0.12]);
    // A new model instance hands over a new hand.
    const second = rig();
    parent.add(second.root);
    second.hand.position.set(-0.2, 0, 0);
    socket.setBone(second.hand);
    socket.update();
    expect(socket.object.position.x).toBeCloseTo(-0.2, 5);
  });

  it('detaches on dispose', () => {
    const parent = new THREE.Group();
    const socket = new BoneSocket(parent, null);
    expect(parent.children).toHaveLength(1);
    socket.dispose();
    expect(parent.children).toHaveLength(0);
    expect(socket.object.parent).toBeNull();
  });
});

describe('findBone', () => {
  it('finds a bone by name anywhere under the model', () => {
    const { root, hand } = rig();
    expect(findBone(root, 'mixamorigRightHand')).toBe(hand);
    expect(findBone(root, 'mixamorigRightArm')?.name).toBe('mixamorigRightArm');
  });

  it('returns null for a name the rig does not have, rather than throwing', () => {
    // A retarget that renames bones should degrade to the fallback mount, not
    // take the scene down.
    const { root } = rig();
    expect(findBone(root, 'weapon_socket')).toBeNull();
  });

  it('keeps the first match when a name repeats', () => {
    const root = new THREE.Object3D();
    const first = new THREE.Object3D();
    first.name = 'hand';
    const second = new THREE.Object3D();
    second.name = 'hand';
    root.add(first, second);
    expect(findBone(root, 'hand')).toBe(first);
  });
});
