import * as RAPIER from '@dimforge/rapier3d-compat';
import type { BodyRecord, Bodies } from './Bodies';
import type { BodyHandle, JointAnchors, JointDesc, JointHandle, JointOptions, QuatLike } from './types';

const IDENTITY: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

/** @internal */
export interface JointRecord {
  readonly id: JointHandle;
  readonly rj: RAPIER.ImpulseJoint;
  readonly a: BodyRecord;
  readonly b: BodyRecord;
  readonly kind: JointDesc['kind'];
  readonly anchors: JointAnchors;
  alive: boolean;
}

function jointData(desc: JointDesc): RAPIER.JointData {
  switch (desc.kind) {
    case 'spherical':
      return RAPIER.JointData.spherical(desc.anchorA, desc.anchorB);
    case 'revolute':
      return RAPIER.JointData.revolute(desc.anchorA, desc.anchorB, desc.axis);
    case 'fixed':
      return RAPIER.JointData.fixed(desc.anchorA, IDENTITY, desc.anchorB, IDENTITY);
    case 'rope':
      return RAPIER.JointData.rope(desc.length, desc.anchorA, desc.anchorB);
  }
}

/**
 * Impulse joints between any two bodies (`physics.joints`, ADR-010).
 *
 * The engine keeps its own index of the joints on each body, and that index
 * is what `of(body)` answers from and what `bodies.destroy` walks to remove a
 * body's joints before the body itself. Rapier 0.20's per-body walk
 * (`forEachJointHandleAttachedToRigidBody`) disagreed with the joints
 * themselves on dozens of bodies in the destruction sandbox's busy scenes, so
 * nothing here asks Rapier which joints a body has.
 */
export class Joints {
  private readonly raw: RAPIER.World;
  private readonly bodies: Bodies;
  private readonly records = new Map<number, JointRecord>();
  private nextId = 1;

  /** @internal Made by `PhysicsWorld`. */
  constructor(raw: RAPIER.World, bodies: Bodies) {
    this.raw = raw;
    this.bodies = bodies;
    bodies.beforeDestroy = (rec) => this.removeAllOf(rec);
  }

  /** Joints alive. */
  get count(): number {
    return this.records.size;
  }

  /**
   * Join two bodies. Anchors are in each body's local frame. Wakes both. The
   * joint goes away with either body.
   */
  create(a: BodyHandle, b: BodyHandle, desc: JointOptions): JointHandle {
    const ra = this.bodies.require(a, 'joints.create');
    const rb = this.bodies.require(b, 'joints.create');
    if (ra === rb) throw new Error(`Joints.create: body ${a} cannot be joined to itself`);
    const rj = this.raw.createImpulseJoint(jointData(desc), ra.rb, rb.rb, true);
    if (desc.contacts === false) rj.setContactsEnabled(false);
    const rec: JointRecord = {
      id: this.nextId++ as JointHandle,
      rj,
      a: ra,
      b: rb,
      kind: desc.kind,
      anchors: {
        bodyA: a,
        bodyB: b,
        anchorA: { x: desc.anchorA.x, y: desc.anchorA.y, z: desc.anchorA.z },
        anchorB: { x: desc.anchorB.x, y: desc.anchorB.y, z: desc.anchorB.z },
      },
      alive: true,
    };
    (ra.joints ??= new Set()).add(rec);
    (rb.joints ??= new Set()).add(rec);
    this.records.set(rec.id, rec);
    return rec.id;
  }

  /** Remove a joint and wake both bodies. Returns false if it was already gone. */
  remove(j: JointHandle): boolean {
    const rec = this.records.get(j);
    if (!rec) return false;
    this.drop(rec);
    return true;
  }

  exists(j: JointHandle): boolean {
    return this.records.has(j);
  }

  /** The joints on a body, from the engine's index. Allocates. */
  of(body: BodyHandle): JointHandle[] {
    const set = this.bodies.record(body)?.joints;
    if (!set) return [];
    const out: JointHandle[] = [];
    for (const rec of set) out.push(rec.id);
    return out;
  }

  /** How many joints a body has, without allocating. */
  countOf(body: BodyHandle): number {
    return this.bodies.record(body)?.joints?.size ?? 0;
  }

  /** The joint's bodies and its anchors in each body's frame (stored, not copied). */
  anchors(j: JointHandle): JointAnchors | undefined {
    return this.records.get(j)?.anchors;
  }

  kind(j: JointHandle): JointDesc['kind'] | undefined {
    return this.records.get(j)?.kind;
  }

  /** @internal Every joint on a body, removed before the body. */
  removeAllOf(rec: BodyRecord): void {
    const set = rec.joints;
    if (!set) return;
    for (const joint of [...set]) this.drop(joint);
    rec.joints = null;
  }

  private drop(rec: JointRecord): void {
    rec.alive = false;
    this.records.delete(rec.id);
    rec.a.joints?.delete(rec);
    rec.b.joints?.delete(rec);
    // The record holds Rapier's joint object, so removal never depends on Rapier's own handle maps.
    this.raw.removeImpulseJoint(rec.rj, true);
  }

  /** @internal */
  dispose(): void {
    for (const rec of this.records.values()) rec.alive = false;
    this.records.clear();
  }
}
