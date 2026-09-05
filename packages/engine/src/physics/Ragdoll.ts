import * as THREE from 'three/webgpu';
import type { Disposable } from '../core/Disposable';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import type { System } from '../ecs/System';
import type { LayerSpec } from './Layers';
import type { PhysicsWorld, Vec3Like } from './PhysicsWorld';

/**
 * Ragdolls (docs/design/gore-scope.md, tier two): a skeleton's bones become
 * capsule rigid bodies chained by spherical joints, and from then on the
 * bodies drive the bones. Activation carries the animated momentum in as a
 * velocity plus an impulse at the hit, and the first fraction of a second
 * blends from the animated pose so the body does not snap.
 *
 * Bodies are ordinary engine entities with `RigidBody` and `Transform`, so
 * the physics systems sync them like anything else; `RagdollWorld.system()`
 * runs after the animation step and writes bone locals from those
 * transforms. Determinism follows from the fixed step.
 */
export interface RagdollBoneSpec {
  /** Bone name in the skeleton. */
  readonly bone: string;
  /** Capsule radius, world units. */
  readonly radius: number;
  /**
   * Segment length along the bone. Default: distance to the first child that
   * is also in the config, else `leafLength`.
   */
  readonly length?: number | undefined;
  /** Mass in kg; default the capsule volume at the config's density. */
  readonly mass?: number | undefined;
}

export interface RagdollConfig {
  /** Parents before children. The first entry is the root body. */
  readonly bones: readonly RagdollBoneSpec[];
  /** Length for bones with no configured child and no explicit length. Default 0.25. */
  readonly leafLength?: number | undefined;
  /**
   * kg per cubic metre for parts without an explicit mass. Default 1000
   * (people are mostly water). Rapier's own default is 1, which makes a
   * forearm weigh three grams and any impulse launch it.
   */
  readonly density?: number | undefined;
  readonly layer?: LayerSpec | undefined;
  readonly collidesWith?: LayerSpec | undefined;
  readonly linearDamping?: number | undefined;
  readonly angularDamping?: number | undefined;
  readonly friction?: number | undefined;
  /**
   * Emit physics contact events for the root part (the hips), so a game can
   * hear the body land instead of timing it. Other parts stay silent: a
   * ragdoll's limbs touch things constantly. Default false.
   */
  readonly contactEvents?: boolean | undefined;
}

/** The engine's mannequin skeleton (tools/asset-pipeline/make-test-assets.mjs). */
export const MANNEQUIN_RAGDOLL: RagdollConfig = {
  bones: [
    { bone: 'hips', radius: 0.16 },
    { bone: 'spine', radius: 0.15 },
    { bone: 'chest', radius: 0.16 },
    { bone: 'head', radius: 0.12, length: 0.24 },
    { bone: 'upperArm_L', radius: 0.06 },
    { bone: 'lowerArm_L', radius: 0.05, length: 0.28 },
    { bone: 'upperArm_R', radius: 0.06 },
    { bone: 'lowerArm_R', radius: 0.05, length: 0.28 },
    { bone: 'upperLeg_L', radius: 0.08 },
    { bone: 'lowerLeg_L', radius: 0.07, length: 0.46 },
    { bone: 'upperLeg_R', radius: 0.08 },
    { bone: 'lowerLeg_R', radius: 0.07, length: 0.46 },
  ],
  leafLength: 0.25,
  linearDamping: 0.4,
  angularDamping: 2.5,
  friction: 0.9,
};

export interface RagdollActivation {
  /** Initial linear velocity for every part (the animated momentum). */
  readonly velocity?: Vec3Like | undefined;
  /**
   * An impulse (kg·m/s) applied to the part nearest `point`, capped so that
   * part gains at most `maxSpeed` m/s (default 8): a round that hits a
   * forearm must not send it into orbit while the same round barely moves
   * the chest.
   */
  readonly impulse?: { readonly point: Vec3Like; readonly direction: Vec3Like; readonly strength: number; readonly maxSpeed?: number | undefined } | undefined;
}

export interface RagdollOptions {
  /** Seconds to blend from the animated pose. Default 0.15. */
  readonly blendSeconds?: number | undefined;
  readonly activation?: RagdollActivation | undefined;
}

export interface RagdollPart {
  readonly bone: THREE.Object3D;
  readonly eid: Entity;
  /** kg. */
  readonly mass: number;
}

interface Part extends RagdollPart {
  readonly parent: Part | null;
  /** Bone origin in body space. */
  readonly offsetPos: THREE.Vector3;
  /** Bone world rotation = body rotation × this. */
  readonly offsetQuat: THREE.Quaternion;
  readonly worldPos: THREE.Vector3;
  readonly worldQuat: THREE.Quaternion;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const DEFAULT_DENSITY = 1000;
const DEFAULT_MAX_IMPULSE_SPEED = 8;

/** Volume of a capsule: the cylinder plus the two half-spheres. */
export function capsuleVolume(halfHeight: number, radius: number): number {
  return Math.PI * radius * radius * (2 * halfHeight) + (4 / 3) * Math.PI * radius * radius * radius;
}
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _bodyQuat = new THREE.Quaternion();
const _localPos = new THREE.Vector3();
const _localQuat = new THREE.Quaternion();
const _parentPos = new THREE.Vector3();
const _parentQuat = new THREE.Quaternion();
const _parentScale = new THREE.Vector3();

export class Ragdoll implements Disposable {
  readonly owner: Entity;
  readonly parts: readonly Part[];
  /** Seconds since activation. */
  age = 0;
  /** 0..1 blend from animation to physics. */
  weight = 0;
  private readonly blendSeconds: number;
  private readonly entities: EntityWorld;
  private readonly physics: PhysicsWorld;
  private disposed = false;

  constructor(owner: Entity, parts: Part[], blendSeconds: number, entities: EntityWorld, physics: PhysicsWorld) {
    this.owner = owner;
    this.parts = parts;
    this.blendSeconds = blendSeconds;
    this.entities = entities;
    this.physics = physics;
  }

  /** The root part's entity (the hips), whose contacts `contactEvents` reports. */
  get rootEid(): Entity | null {
    return this.parts[0]?.eid ?? null;
  }

  /** Whether `eid` is one of this ragdoll's bodies. */
  hasPart(eid: Entity): boolean {
    for (const p of this.parts) if (p.eid === eid) return true;
    return false;
  }

  /** Every part asleep: the body has come to rest. */
  settled(): boolean {
    for (const p of this.parts) if (!this.physics.isSleeping(p.eid)) return false;
    return true;
  }

  /** World position of the root part (the hips), for blood pools and cameras. */
  rootPosition(out: Vec3Like): Vec3Like {
    const t = this.entities.store(Transform);
    const root = this.parts[0];
    if (!root) return out;
    out.x = t.x[root.eid] ?? 0;
    out.y = t.y[root.eid] ?? 0;
    out.z = t.z[root.eid] ?? 0;
    return out;
  }

  /** Advance the blend and write bone locals from the bodies. Called by the system. */
  sync(dt: number): void {
    if (this.disposed) return;
    this.age += dt;
    this.weight = this.blendSeconds <= 0 ? 1 : Math.min(1, this.age / this.blendSeconds);
    const t = this.entities.store(Transform);
    for (const part of this.parts) {
      _pos.set(t.x[part.eid] ?? 0, t.y[part.eid] ?? 0, t.z[part.eid] ?? 0);
      _bodyQuat.set(t.qx[part.eid] ?? 0, t.qy[part.eid] ?? 0, t.qz[part.eid] ?? 0, t.qw[part.eid] ?? 1);
      part.worldQuat.copy(_bodyQuat).multiply(part.offsetQuat);
      part.worldPos.copy(part.offsetPos).applyQuaternion(_bodyQuat).add(_pos);

      if (part.parent) {
        _parentPos.copy(part.parent.worldPos);
        _parentQuat.copy(part.parent.worldQuat);
        _parentScale.set(1, 1, 1);
      } else if (part.bone.parent) {
        part.bone.parent.matrixWorld.decompose(_parentPos, _parentQuat, _parentScale);
      } else {
        _parentPos.set(0, 0, 0);
        _parentQuat.identity();
        _parentScale.set(1, 1, 1);
      }
      _q.copy(_parentQuat).invert();
      _localQuat.copy(_q).multiply(part.worldQuat);
      _localPos.copy(part.worldPos).sub(_parentPos).applyQuaternion(_q);
      _localPos.x /= _parentScale.x || 1;
      _localPos.y /= _parentScale.y || 1;
      _localPos.z /= _parentScale.z || 1;
      if (this.weight >= 1) {
        part.bone.position.copy(_localPos);
        part.bone.quaternion.copy(_localQuat);
      } else {
        part.bone.position.lerp(_localPos, this.weight);
        part.bone.quaternion.slerp(_localQuat, this.weight);
      }
      part.bone.updateMatrix();
      part.bone.updateMatrixWorld(false);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.parts) if (this.entities.exists(p.eid)) this.entities.destroy(p.eid);
  }
}

export class RagdollWorld implements Disposable {
  private readonly entities: EntityWorld;
  private readonly physics: PhysicsWorld;
  private readonly ragdolls = new Map<Entity, Ragdoll>();
  private disposed = false;

  constructor(entities: EntityWorld, physics: PhysicsWorld) {
    this.entities = entities;
    this.physics = physics;
  }

  /** Update-stage system, after the animation step (0) and before the late-stage render sync. */
  system(order = 1): System {
    return {
      name: 'RagdollSync',
      stage: 'update',
      order,
      run: (_world, dt) => this.step(dt),
    };
  }

  get count(): number {
    return this.ragdolls.size;
  }

  has(owner: Entity): boolean {
    return this.ragdolls.has(owner);
  }

  get(owner: Entity): Ragdoll | undefined {
    return this.ragdolls.get(owner);
  }

  /** Every ragdoll, oldest first. */
  list(): Ragdoll[] {
    return [...this.ragdolls.values()];
  }

  /**
   * Turn `root`'s skeleton into a ragdoll from its current (animated) pose.
   * `root` must have its world matrices up to date.
   */
  create(owner: Entity, root: THREE.Object3D, config: RagdollConfig, options: RagdollOptions = {}): Ragdoll {
    if (this.disposed) throw new Error('RagdollWorld: disposed');
    if (this.ragdolls.has(owner)) throw new Error(`RagdollWorld: entity ${owner} already has a ragdoll`);
    root.updateMatrixWorld(true);
    const bones = new Map<string, THREE.Object3D>();
    root.traverse((o) => {
      if (config.bones.some((b) => b.bone === o.name)) bones.set(o.name, o);
    });
    const parts: Part[] = [];
    const byBone = new Map<THREE.Object3D, Part>();
    const specOf = new Map(config.bones.map((b) => [b.bone, b] as const));
    const leaf = config.leafLength ?? 0.25;
    if (config.layer) this.physics.layers.define(typeof config.layer === 'string' ? config.layer : 'ragdoll');

    for (const spec of config.bones) {
      const bone = bones.get(spec.bone);
      if (!bone) throw new Error(`RagdollWorld: bone "${spec.bone}" not found under ${root.name || 'root'}`);
      bone.getWorldPosition(_a);
      bone.getWorldQuaternion(_q);
      // Segment end: an explicit length along the bone's +Y, else the first configured child, else the leaf length.
      let length = spec.length;
      if (length === undefined) {
        const child = bone.children.find((c) => specOf.has(c.name));
        if (child) {
          child.getWorldPosition(_b);
          length = _b.distanceTo(_a);
          _b.sub(_a);
        } else length = leaf;
      }
      if (spec.length !== undefined || !bone.children.some((c) => specOf.has(c.name))) {
        _b.set(0, 1, 0).applyQuaternion(_q).multiplyScalar(length);
      }
      const len = Math.max(length, 0.02);
      const dir = _b.lengthSq() > 1e-8 ? _b.normalize() : _s.set(0, 1, 0).applyQuaternion(_q);
      const center = _s.copy(_a).addScaledVector(dir, len / 2);
      const bodyQuat = _q2.setFromUnitVectors(Y_AXIS, dir);
      const halfHeight = Math.max(0.01, len / 2 - spec.radius);
      const mass = spec.mass ?? capsuleVolume(halfHeight, spec.radius) * (config.density ?? DEFAULT_DENSITY);

      const eid = this.entities.create([Transform, { x: center.x, y: center.y, z: center.z, qx: bodyQuat.x, qy: bodyQuat.y, qz: bodyQuat.z, qw: bodyQuat.w }]);
      this.physics.addBody(eid, {
        type: 'dynamic',
        shape: { kind: 'capsule', halfHeight, radius: spec.radius },
        mass,
        layer: config.layer ?? 'ragdoll',
        collidesWith: config.collidesWith ?? ['world'],
        friction: config.friction ?? 0.8,
        linearDamping: config.linearDamping ?? 0.3,
        angularDamping: config.angularDamping ?? 2,
        events: Boolean(config.contactEvents) && parts.length === 0,
      });

      // Nearest configured ancestor becomes the parent body.
      let ancestor: THREE.Object3D | null = bone.parent;
      let parent: Part | null = null;
      while (ancestor) {
        const found = byBone.get(ancestor);
        if (found) {
          parent = found;
          break;
        }
        ancestor = ancestor.parent;
      }
      const invBody = _bodyQuatInv.copy(bodyQuat).invert();
      const part: Part = {
        bone,
        eid,
        mass,
        parent,
        offsetPos: _a.clone().sub(center).applyQuaternion(invBody),
        offsetQuat: invBody.clone().multiply(_q),
        worldPos: _a.clone(),
        worldQuat: _q.clone(),
      };
      if (parent) {
        const t = this.entities.store(Transform);
        _parentPos.set(t.x[parent.eid] ?? 0, t.y[parent.eid] ?? 0, t.z[parent.eid] ?? 0);
        _parentQuat.set(t.qx[parent.eid] ?? 0, t.qy[parent.eid] ?? 0, t.qz[parent.eid] ?? 0, t.qw[parent.eid] ?? 1).invert();
        const anchorA = _localPos.copy(_a).sub(_parentPos).applyQuaternion(_parentQuat);
        this.physics.addJoint(parent.eid, eid, { kind: 'spherical', anchorA: { x: anchorA.x, y: anchorA.y, z: anchorA.z }, anchorB: { x: part.offsetPos.x, y: part.offsetPos.y, z: part.offsetPos.z } });
      }
      parts.push(part);
      byBone.set(bone, part);
    }

    const ragdoll = new Ragdoll(owner, parts, options.blendSeconds ?? 0.15, this.entities, this.physics);
    this.ragdolls.set(owner, ragdoll);
    const activation = options.activation;
    if (activation) {
      if (activation.velocity) for (const p of parts) this.physics.setLinearVelocity(p.eid, activation.velocity);
      if (activation.impulse) {
        const t = this.entities.store(Transform);
        let best: Part | null = null;
        let bestD = Infinity;
        for (const p of parts) {
          const dx = (t.x[p.eid] ?? 0) - activation.impulse.point.x;
          const dy = (t.y[p.eid] ?? 0) - activation.impulse.point.y;
          const dz = (t.z[p.eid] ?? 0) - activation.impulse.point.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        if (best) {
          const s = Math.min(activation.impulse.strength, best.mass * (activation.impulse.maxSpeed ?? DEFAULT_MAX_IMPULSE_SPEED));
          const d = activation.impulse.direction;
          this.physics.applyImpulse(best.eid, { x: d.x * s, y: d.y * s, z: d.z * s });
        }
      }
    }
    return ragdoll;
  }

  remove(owner: Entity): boolean {
    const r = this.ragdolls.get(owner);
    if (!r) return false;
    this.ragdolls.delete(owner);
    r.dispose();
    return true;
  }

  step(dt: number): void {
    if (this.disposed) return;
    for (const r of this.ragdolls.values()) r.sync(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const r of this.ragdolls.values()) r.dispose();
    this.ragdolls.clear();
  }
}

const _bodyQuatInv = new THREE.Quaternion();
