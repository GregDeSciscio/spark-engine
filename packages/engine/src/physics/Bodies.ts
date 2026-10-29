import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import type { BodyType } from './components';
import type { JointRecord } from './Joints';
import type { Layers } from './Layers';
import {
  NO_PART,
  type BodyHandle,
  type BodyInit,
  type ColliderHandle,
  type ColliderInfo,
  type ColliderInit,
  type QuatLike,
  type ShapeDesc,
  type Vec3Like,
} from './types';

/**
 * Most colliders one Rapier body holds before a fixed body made by
 * `Bodies.create` grows another shard. Adding or removing a collider makes
 * Rapier re-place every collider on that body and recompute its mass on the
 * next step: 1.8 ms for a 1,800-hull body, 0.04 ms for a 64-hull shard.
 */
export const SHARD_CAPACITY = 64;

const ZERO: Vec3Like = { x: 0, y: 0, z: 0 };
const IDENTITY: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

/** @internal The engine's record of a body. */
export interface BodyRecord {
  readonly id: BodyHandle;
  readonly type: BodyType;
  /** The Rapier body; for a sharded fixed body, its first shard (joints attach here). */
  readonly rb: RAPIER.RigidBody;
  /** Every Rapier body this one is made of, all at the same pose. One unless sharded. */
  readonly shards: RAPIER.RigidBody[];
  /** Colliders on each shard. */
  readonly shardFill: number[];
  /** Fixed bodies made through `Bodies.create` shard; entity bodies never do. */
  readonly sharded: boolean;
  readonly colliders: Set<ColliderRecord>;
  /** Joints on this body: the engine's own index (Rapier 0.20's per-body walk is not trusted). */
  joints: Set<JointRecord> | null;
  /** The entity whose body this is (`PhysicsWorld.addBody`), or -1. */
  readonly eid: Entity;
  alive: boolean;
}

/** @internal The engine's record of a collider. Handed out as its read-only `ColliderInfo`. */
export interface ColliderRecord extends ColliderInfo {
  readonly id: ColliderHandle;
  readonly rc: RAPIER.Collider;
  /** Rapier's handle, what queries and events report. */
  readonly rapierHandle: number;
  readonly bodyRec: BodyRecord;
  readonly shard: number;
  readonly sensor: boolean;
  alive: boolean;
  /**
   * Its contacts were already ended by the engine (its owner was destroyed or
   * its entity body removed), so the stop events Rapier sends for it on the
   * next step are ignored.
   */
  ended: boolean;
}

/** @internal Rapier collider description for a shape. Throws on a degenerate convex shape. */
export function colliderDescFor(shape: ShapeDesc): RAPIER.ColliderDesc {
  switch (shape.kind) {
    case 'box':
      return RAPIER.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz);
    case 'sphere':
      return RAPIER.ColliderDesc.ball(shape.radius);
    case 'capsule':
      return RAPIER.ColliderDesc.capsule(shape.halfHeight, shape.radius);
    case 'trimesh':
      return RAPIER.ColliderDesc.trimesh(shape.vertices, shape.indices);
    case 'heightfield':
      return RAPIER.ColliderDesc.heightfield(shape.rows, shape.cols, shape.heights, shape.scale);
    // Rapier builds convex shapes when the collider is created; `createConvex` checks the result.
    case 'convexHull': {
      const desc = RAPIER.ColliderDesc.convexHull(shape.points);
      if (!desc) throw new Error(`convexHull: ${shape.points.length / 3} points have no volume`);
      return desc;
    }
    case 'convexMesh': {
      const desc = RAPIER.ColliderDesc.convexMesh(shape.vertices, shape.indices);
      if (!desc) throw new Error('convexMesh: the mesh is not a closed convex polyhedron');
      return desc;
    }
  }
}

/** @internal A Rapier query shape for a shape description. */
export function queryShapeFor(shape: ShapeDesc): RAPIER.Shape {
  switch (shape.kind) {
    case 'box':
      return new RAPIER.Cuboid(shape.hx, shape.hy, shape.hz);
    case 'sphere':
      return new RAPIER.Ball(shape.radius);
    case 'capsule':
      return new RAPIER.Capsule(shape.halfHeight, shape.radius);
    case 'trimesh':
      return new RAPIER.TriMesh(shape.vertices, shape.indices);
    case 'heightfield':
      return new RAPIER.Heightfield(shape.rows, shape.cols, shape.heights, shape.scale);
    case 'convexHull':
      return new RAPIER.ConvexPolyhedron(shape.points, null);
    case 'convexMesh':
      return new RAPIER.ConvexPolyhedron(shape.vertices, shape.indices);
  }
}

function rapierBodyDesc(type: BodyType): RAPIER.RigidBodyDesc {
  switch (type) {
    case 'dynamic':
      return RAPIER.RigidBodyDesc.dynamic();
    case 'fixed':
      return RAPIER.RigidBodyDesc.fixed();
    case 'kinematicPosition':
      return RAPIER.RigidBodyDesc.kinematicPositionBased();
  }
}

/**
 * The handle layer under the entity API (ADR-010): rigid bodies with any
 * number of colliders, each collider owned by an entity and tagged with a
 * part id. `physics.bodies`. Nothing here needs an entity per body, so a
 * destruction system can keep one fixed body of a thousand hulls, or make and
 * drop hundreds of debris bodies a second, and still have a game's raycasts
 * name the building and the chunk they hit.
 *
 * Handles are integers that are never reused; a stale one is simply unknown
 * (`exists` is false, getters return defaults, removals return false).
 *
 * Fixed bodies made here hold no mass and spread their colliders across
 * internal shards of `SHARD_CAPACITY`, so adding or removing one collider
 * costs the same whether the body holds ten or two thousand. A joint to a
 * sharded body attaches to its first shard; with `contacts: false` only that
 * shard's colliders stop colliding with the other body.
 */
export class Bodies {
  private readonly raw: RAPIER.World;
  private readonly layers: Layers;
  private readonly entities: EntityWorld;
  private readonly records = new Map<number, BodyRecord>();
  private readonly colliderRecords = new Map<number, ColliderRecord>();
  private readonly byRapier = new Map<number, ColliderRecord>();
  private readonly owned = new Map<Entity, Set<ColliderRecord>>();
  /** Per owner, its colliders removed since the last drain (still in the graveyard). */
  private readonly removedOf = new Map<Entity, Set<ColliderRecord>>();
  /** Colliders removed since the last event drain: Rapier still names them in that drain's stop events. */
  private graveyard: ColliderRecord[] = [];
  private nextBodyId = 1;
  private nextColliderId = 1;
  private liveColliders = 0;
  private disposed = false;
  /** @internal Runs before a body's Rapier objects are removed (the joint index drops its joints). */
  beforeDestroy: ((rec: BodyRecord) => void) | null = null;

  /** @internal Made by `PhysicsWorld`. */
  constructor(raw: RAPIER.World, layers: Layers, entities: EntityWorld) {
    this.raw = raw;
    this.layers = layers;
    this.entities = entities;
  }

  /** Bodies alive, entity bodies included. */
  get count(): number {
    return this.records.size;
  }

  /** Colliders alive. */
  get colliderCount(): number {
    return this.liveColliders;
  }

  // ---- bodies ------------------------------------------------------------------

  create(init: BodyInit): BodyHandle {
    this.assertLive();
    return this.createRecord(init, -1).id;
  }

  /** Remove a body with its colliders and joints. Entity bodies go through `physics.removeBody`. */
  destroy(b: BodyHandle): boolean {
    const rec = this.records.get(b);
    if (!rec || this.disposed) return false;
    if (rec.eid >= 0) throw new Error(`Bodies.destroy: body ${b} belongs to entity ${rec.eid}; use physics.removeBody`);
    this.destroyRecord(rec);
    return true;
  }

  exists(b: BodyHandle): boolean {
    return this.records.has(b);
  }

  type(b: BodyHandle): BodyType | undefined {
    return this.records.get(b)?.type;
  }

  /** The body's live colliders, in the order they were added. Allocates. */
  colliders(b: BodyHandle): ColliderHandle[] {
    const rec = this.records.get(b);
    if (!rec) return [];
    const out: ColliderHandle[] = [];
    for (const c of rec.colliders) out.push(c.id);
    return out;
  }

  /** World pose into `outP` (and `outQ`). Returns false for an unknown body. */
  pose(b: BodyHandle, outP: Vec3Like, outQ?: QuatLike): boolean {
    const rec = this.records.get(b);
    if (!rec) return false;
    rec.rb.translation(outP);
    if (outQ) rec.rb.rotation(outQ);
    return true;
  }

  /**
   * Teleport a body (dynamic bodies keep their velocity) and wake it. Colliders
   * follow on the next step. For an entity's body use `physics.setPose`, which
   * also writes its Transform.
   */
  setPose(b: BodyHandle, position: Vec3Like, rotation: QuatLike = IDENTITY): void {
    const rec = this.require(b, 'setPose');
    for (const shard of rec.shards) {
      shard.setTranslation(position, true);
      shard.setRotation(rotation, true);
    }
  }

  /** Linear velocity into `outLin` (and angular into `outAng`). Zero for fixed bodies. */
  velocity(b: BodyHandle, outLin: Vec3Like, outAng?: Vec3Like): boolean {
    const rec = this.records.get(b);
    if (!rec) return false;
    rec.rb.linvel(outLin);
    if (outAng) rec.rb.angvel(outAng);
    return true;
  }

  /** Set either velocity (null or left out keeps it) and wake the body. */
  setVelocity(b: BodyHandle, linear?: Vec3Like | null, angular?: Vec3Like | null): void {
    const rec = this.require(b, 'setVelocity');
    if (linear) rec.rb.setLinvel(linear, true);
    if (angular) rec.rb.setAngvel(angular, true);
  }

  /** An instantaneous push at the centre of mass, plus an optional spin (torque impulse). Wakes the body. */
  applyImpulse(b: BodyHandle, impulse: Vec3Like, torque?: Vec3Like): void {
    const rec = this.require(b, 'applyImpulse');
    rec.rb.applyImpulse(impulse, true);
    if (torque) rec.rb.applyTorqueImpulse(torque, true);
  }

  /**
   * Where the body's mass is centred, in the world, into `out`. Not its pose:
   * a body that has lost colliders keeps its frame, whose origin can sit well
   * away from what is left. Fixed bodies made here are massless: their pose.
   */
  centerOfMass(b: BodyHandle, out: Vec3Like): boolean {
    const rec = this.records.get(b);
    if (!rec) return false;
    if (rec.sharded) rec.rb.translation(out);
    else rec.rb.worldCom(out);
    return true;
  }

  /** Total mass from the colliders' densities. 0 for fixed bodies made here and for unknown bodies. */
  mass(b: BodyHandle): number {
    return this.records.get(b)?.rb.mass() ?? 0;
  }

  isSleeping(b: BodyHandle): boolean {
    return this.records.get(b)?.rb.isSleeping() ?? false;
  }

  wake(b: BodyHandle): void {
    this.records.get(b)?.rb.wakeUp();
  }

  // ---- colliders -----------------------------------------------------------------

  addCollider(b: BodyHandle, init: ColliderInit): ColliderHandle {
    this.assertLive();
    return this.addColliderTo(this.require(b, 'addCollider'), init).id;
  }

  /**
   * Remove one collider. The body stays (with no colliders it simply touches
   * nothing). `wake` wakes the body it was on; Rapier still wakes whatever was
   * touching it. Its `info` stays readable until the next physics step's
   * events are delivered. Returns false if it was already gone.
   */
  removeCollider(c: ColliderHandle, wake = false): boolean {
    const crec = this.colliderRecords.get(c);
    if (!crec || !crec.alive || this.disposed) return false;
    if (crec.bodyRec.eid >= 0 && crec.owner === crec.bodyRec.eid && crec === this.primaryOf(crec.bodyRec)) {
      throw new Error(`Bodies.removeCollider: collider ${c} is entity ${crec.owner}'s own; use physics.removeBody`);
    }
    this.dropCollider(crec, wake);
    return true;
  }

  /**
   * The collider's body, owner and part. Still answers for a collider removed
   * since the last physics step, so code handling that step's events can
   * resolve it; undefined after that or for a handle never issued.
   */
  info(c: ColliderHandle): ColliderInfo | undefined {
    return this.colliderRecords.get(c);
  }

  /** Is this collider alive? */
  hasCollider(c: ColliderHandle): boolean {
    return this.colliderRecords.get(c)?.alive ?? false;
  }

  /** World pose of a live collider, as the physics world last placed it (at creation or the last step). */
  colliderPose(c: ColliderHandle, outP: Vec3Like, outQ?: QuatLike): boolean {
    const crec = this.colliderRecords.get(c);
    if (!crec?.alive) return false;
    crec.rc.translation(outP);
    if (outQ) crec.rc.rotation(outQ);
    return true;
  }

  // ---- engine internals ---------------------------------------------------------------

  /** @internal */
  record(b: BodyHandle): BodyRecord | undefined {
    return this.records.get(b);
  }

  /** @internal */
  require(b: BodyHandle, where: string): BodyRecord {
    this.assertLive();
    const rec = this.records.get(b);
    if (!rec) throw new Error(`Bodies.${where}: body ${b} does not exist`);
    return rec;
  }

  /** @internal */
  colliderRecord(c: ColliderHandle): ColliderRecord | undefined {
    return this.colliderRecords.get(c);
  }

  /** @internal The record behind a Rapier collider handle, including colliders removed since the last drain. */
  ofRapier(handle: number): ColliderRecord | undefined {
    return this.byRapier.get(handle);
  }

  /** @internal Live colliders an entity owns. */
  ownedBy(eid: Entity): ReadonlySet<ColliderRecord> | undefined {
    return this.owned.get(eid);
  }

  /** @internal An entity's colliders removed since the last drain, whose stop events are still to come. */
  removedBy(eid: Entity): ReadonlySet<ColliderRecord> | undefined {
    return this.removedOf.get(eid);
  }

  /** @internal The first collider on an entity body: the one `addBody` made. */
  primaryOf(rec: BodyRecord): ColliderRecord | undefined {
    for (const c of rec.colliders) return c;
    return undefined;
  }

  /** @internal */
  createRecord(init: BodyInit, eid: Entity): BodyRecord {
    const desc = rapierBodyDesc(init.type);
    if (init.position) desc.setTranslation(init.position.x, init.position.y, init.position.z);
    if (init.rotation) desc.setRotation(init.rotation);
    if (init.linearVelocity) desc.setLinvel(init.linearVelocity.x, init.linearVelocity.y, init.linearVelocity.z);
    if (init.angularVelocity) desc.setAngvel(init.angularVelocity);
    if (init.ccd) desc.setCcdEnabled(true);
    if (init.lockRotations) desc.lockRotations();
    if (init.linearDamping !== undefined) desc.setLinearDamping(init.linearDamping);
    if (init.angularDamping !== undefined) desc.setAngularDamping(init.angularDamping);
    const rb = this.raw.createRigidBody(desc);
    const rec: BodyRecord = {
      id: this.nextBodyId++ as BodyHandle,
      type: init.type,
      rb,
      shards: [rb],
      shardFill: [0],
      sharded: init.type === 'fixed' && eid < 0,
      colliders: new Set(),
      joints: null,
      eid,
      alive: true,
    };
    this.records.set(rec.id, rec);
    return rec;
  }

  /** @internal */
  addColliderTo(rec: BodyRecord, init: ColliderInit): ColliderRecord {
    if (!this.entities.exists(init.owner)) throw new Error(`Bodies.addCollider: owner entity ${init.owner} does not exist`);
    const sensor = init.isSensor ?? false;
    const desc = colliderDescFor(init.shape)
      .setFriction(init.friction ?? 0.5)
      .setRestitution(init.restitution ?? 0)
      .setCollisionGroups(this.layers.groups(init.layer ?? 'default', init.collidesWith ?? 'all'))
      .setSensor(sensor);
    if (init.position) desc.setTranslation(init.position.x, init.position.y, init.position.z);
    if (init.rotation) desc.setRotation(init.rotation);
    if (rec.sharded) {
      // A fixed body's mass is never used; computing it from a thousand hulls on every change is pure cost.
      desc.setMassProperties(0, ZERO, ZERO, IDENTITY);
    } else if (init.mass !== undefined) {
      desc.setMass(init.mass);
    } else if (init.density !== undefined) {
      desc.setDensity(init.density);
    }
    const force = init.forceEvents !== undefined;
    if (init.events || force) desc.setActiveEvents((init.events ? RAPIER.ActiveEvents.COLLISION_EVENTS : 0) | (force ? RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS : 0));
    if (init.forceEvents !== undefined) desc.setContactForceEventThreshold(init.forceEvents);
    // Sensors should notice kinematic and fixed bodies too, not only dynamic ones. (Rapier never pairs
    // two fixed bodies, so a sensor on a sharded body still never sees that body's other shards.)
    if (sensor) desc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);

    const shard = this.pickShard(rec);
    const rc = this.createChecked(desc, rec.shards[shard] as RAPIER.RigidBody, init.shape);
    rec.shardFill[shard] = (rec.shardFill[shard] ?? 0) + 1;
    const crec: ColliderRecord = {
      id: this.nextColliderId++ as ColliderHandle,
      body: rec.id,
      owner: init.owner,
      part: init.part ?? NO_PART,
      rc,
      rapierHandle: rc.handle,
      bodyRec: rec,
      shard,
      sensor,
      alive: true,
      ended: false,
    };
    rec.colliders.add(crec);
    this.liveColliders += 1;
    this.colliderRecords.set(crec.id, crec);
    this.byRapier.set(crec.rapierHandle, crec);
    let set = this.owned.get(init.owner);
    if (!set) {
      set = new Set();
      this.owned.set(init.owner, set);
    }
    set.add(crec);
    return crec;
  }

  /**
   * Create the collider, refusing a convex shape with no volume: Rapier 0.20
   * computes the hull only now, and throws an unhelpful error for a point or a
   * line and quietly makes a massless flat polygon for a plane.
   */
  private createChecked(desc: RAPIER.ColliderDesc, body: RAPIER.RigidBody, shape: ShapeDesc): RAPIER.Collider {
    const convex = shape.kind === 'convexHull' || shape.kind === 'convexMesh';
    const what = shape.kind === 'convexHull' ? `convexHull: ${shape.points.length / 3} points` : 'convexMesh: the mesh';
    let rc: RAPIER.Collider;
    try {
      rc = this.raw.createCollider(desc, body);
    } catch (error) {
      if (convex) throw new Error(`${what} has no volume`, { cause: error });
      throw error;
    }
    if (convex && !(rc.volume() > 1e-9)) {
      this.raw.removeCollider(rc, false);
      throw new Error(`${what} has no volume`);
    }
    return rc;
  }

  private pickShard(rec: BodyRecord): number {
    if (!rec.sharded) return 0;
    for (let i = 0; i < rec.shards.length; i++) if ((rec.shardFill[i] ?? 0) < SHARD_CAPACITY) return i;
    const t = rec.rb.translation();
    const shard = this.raw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(t.x, t.y, t.z).setRotation(rec.rb.rotation()));
    rec.shards.push(shard);
    rec.shardFill.push(0);
    return rec.shards.length - 1;
  }

  /** Forget a collider (already removed from Rapier, or about to be with its body). */
  private unlinkCollider(crec: ColliderRecord): void {
    crec.alive = false;
    this.liveColliders -= 1;
    const set = this.owned.get(crec.owner);
    if (set) {
      set.delete(crec);
      if (set.size === 0) this.owned.delete(crec.owner);
    }
    let removed = this.removedOf.get(crec.owner);
    if (!removed) {
      removed = new Set();
      this.removedOf.set(crec.owner, removed);
    }
    removed.add(crec);
    this.graveyard.push(crec);
  }

  /** @internal */
  dropCollider(crec: ColliderRecord, wake: boolean): void {
    const rec = crec.bodyRec;
    rec.colliders.delete(crec);
    rec.shardFill[crec.shard] = (rec.shardFill[crec.shard] ?? 1) - 1;
    this.raw.removeCollider(crec.rc, wake);
    this.unlinkCollider(crec);
  }

  /** @internal Remove a body: its joints first (through the index), then its colliders and Rapier bodies. */
  destroyRecord(rec: BodyRecord): void {
    if (!rec.alive) return;
    this.beforeDestroy?.(rec);
    for (const crec of rec.colliders) this.unlinkCollider(crec);
    rec.colliders.clear();
    rec.alive = false;
    this.records.delete(rec.id);
    // Rapier removes the colliders with the body and reports their contacts as stopped on the next step.
    for (const shard of rec.shards) this.raw.removeRigidBody(shard);
  }

  /**
   * @internal Hand over the colliders removed so far; `purge` them after the
   * next drain. Removals made while that drain's events are delivered land in
   * the fresh list and survive until the drain after.
   */
  takeGraveyard(): ColliderRecord[] {
    const list = this.graveyard;
    this.graveyard = [];
    return list;
  }

  /** @internal */
  purge(list: readonly ColliderRecord[]): void {
    for (const crec of list) {
      this.colliderRecords.delete(crec.id);
      this.byRapier.delete(crec.rapierHandle);
      const removed = this.removedOf.get(crec.owner);
      if (removed) {
        removed.delete(crec);
        if (removed.size === 0) this.removedOf.delete(crec.owner);
      }
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('PhysicsWorld: disposed');
  }

  /** @internal Forget everything; the Rapier world is freed by its owner. */
  dispose(): void {
    this.disposed = true;
    for (const rec of this.records.values()) {
      rec.alive = false;
      for (const crec of rec.colliders) crec.alive = false;
    }
    this.records.clear();
    this.colliderRecords.clear();
    this.byRapier.clear();
    this.owned.clear();
    this.removedOf.clear();
    this.graveyard = [];
    this.liveColliders = 0;
  }
}
