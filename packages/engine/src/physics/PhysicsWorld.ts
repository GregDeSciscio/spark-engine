import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Disposable } from '../core/Disposable';
import { EventEmitter } from '../core/Events';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import { SideTable } from '../ecs/SideTable';
import { Bodies, queryShapeFor, type BodyRecord } from './Bodies';
import { BODY_TYPE, RigidBody, type BodyType } from './components';
import { Joints } from './Joints';
import { Layers, type LayerSpec } from './Layers';
import { PhysicsDebugRenderer } from './PhysicsDebugRenderer';
import type {
  BodyHandle,
  ColliderHandle,
  ContactForceVisitor,
  JointDesc,
  JointHandle,
  OverlapOptions,
  OverlapVisitor,
  Pose,
  QuatLike,
  ShapeDesc,
  Vec3Like,
} from './types';

// The value types moved to `types.ts`; re-exported here for code that imports them from this module.
export type { JointDesc, QuatLike, ShapeDesc, Vec3Like } from './types';

// ---- public types ----------------------------------------------------------

export interface BodyDesc {
  type: BodyType;
  shape: ShapeDesc;
  /** Explicit mass; otherwise derived from the shape volume at density 1. */
  mass?: number;
  friction?: number;
  restitution?: number;
  /** Layer this body belongs to. Default `'default'`. */
  layer?: LayerSpec;
  /** Layers this body collides with. Default `'all'`. */
  collidesWith?: LayerSpec;
  /** Sensors detect overlaps (trigger events) without a physical response. */
  isSensor?: boolean;
  /** Continuous collision detection for fast dynamic bodies. */
  ccd?: boolean;
  lockRotations?: boolean;
  linearDamping?: number;
  angularDamping?: number;
  /**
   * Emit collisionStart/End (or triggerEnter/Exit for sensors) for this body.
   * Default true. Rapier reports a pair if either collider has events on, so
   * bulk debris can turn this off and still be detected by sensors.
   */
  events?: boolean;
}

export interface PhysicsPair {
  a: Entity;
  b: Entity;
}

export interface PhysicsEvents extends Record<string, unknown> {
  /** A sensor and another collider started overlapping. `a` is the sensor's owner. */
  triggerEnter: PhysicsPair;
  triggerExit: PhysicsPair;
  /** Two non-sensor colliders of different owners came into contact. `a < b`. */
  collisionStart: PhysicsPair;
  collisionEnd: PhysicsPair;
}

export interface RaycastOptions {
  /** Only hit colliders belonging to these layers. Default all. */
  layers?: LayerSpec;
  /**
   * Ignore this entity (e.g. the caster): its body, and every collider it
   * owns on other bodies.
   */
  excludeEid?: Entity;
  /** Ignore every collider on this body. */
  excludeBody?: BodyHandle | undefined;
  /** Ignore this collider. */
  excludeCollider?: ColliderHandle | undefined;
  /** Treat shapes as solid: a ray starting inside one hits at distance 0. Default true. */
  solid?: boolean;
  /** Include sensor colliders. Default false. */
  includeSensors?: boolean;
}

export interface RaycastHit {
  /** The entity that owns the collider hit. */
  eid: Entity;
  /** Which part of it (`NO_PART` when the collider was given none). */
  part: number;
  collider: ColliderHandle;
  body: BodyHandle;
  point: Vec3Like;
  normal: Vec3Like;
  distance: number;
}

export interface PhysicsWorldOptions {
  /** The entity world bodies attach to. Side tables register here. */
  entities: EntityWorld;
  /** Simulation ticks per second. The Rapier world timestep is `1 / fixedStepHz`, never wall time. */
  fixedStepHz: number;
  gravity?: Vec3Like;
  /** Constraint solver iterations per step. Default Rapier's (4); jointed nets and ropes want more. */
  solverIterations?: number | undefined;
}

// ---- Rapier init ------------------------------------------------------------

let rapierReady: Promise<void> | null = null;

/** Load the Rapier WASM module once per process. Safe to call repeatedly. */
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

// ---- helpers -----------------------------------------------------------------

const _v = { x: 0, y: 0, z: 0 };
const _q = { x: 0, y: 0, z: 0, w: 1 };
const _rayDir = { x: 0, y: 0, z: 0 };
const _force = { x: 0, y: 0, z: 0 };
const _identity: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

/** Pair key for active-contact bookkeeping. Entity ids are far below 2^20. */
function pairKey(a: Entity, b: Entity): number {
  return a < b ? a * 0x100000 + b : b * 0x100000 + a;
}

/** Contacts and trigger overlaps between the same two owners are counted apart. */
function ownerPairKey(a: Entity, b: Entity, sensor: boolean): number {
  return pairKey(a, b) * 2 + (sensor ? 1 : 0);
}

/**
 * Two owners touching: `count` collider pairs between them are in contact (or
 * overlapping, for a sensor pair). Start and end fire as it leaves and returns
 * to zero, so a building of a thousand hulls lands on the ground once.
 */
interface OwnerPair {
  readonly a: Entity;
  readonly b: Entity;
  readonly sensor: boolean;
  readonly key: number;
  count: number;
}

/** What a query skips. Rapier takes one body and one collider natively; anything more is a predicate. */
interface QueryFilter {
  body: RAPIER.RigidBody | undefined;
  collider: RAPIER.Collider | undefined;
  predicate: ((collider: RAPIER.Collider) => boolean) | undefined;
}

/**
 * The engine's physics world: Rapier 3D on the main thread at the fixed step
 * (ADR-002). Only this module imports Rapier.
 *
 * Two ways in:
 * - the entity API (`addBody`, `setPose`, `addJoint`, ...): one body and one
 *   collider per entity, its pose mirrored into the entity's Transform;
 * - the handle layer under it (`bodies`, `joints`, ADR-010): bodies with any
 *   number of colliders, each owned by an entity and tagged with a part.
 *
 * Every collider has an owner, so raycasts, overlaps and contact events
 * always name an entity (and a part), whichever API made the collider.
 *
 * Lifecycle per fixed tick (see `createPhysicsSystems`):
 *   PhysicsKinematicPush (90) → gameplay forces (< 90 ran earlier) →
 *   PhysicsStep (100) → PhysicsSync (110)
 */
export class PhysicsWorld implements Disposable {
  readonly entities: EntityWorld;
  readonly layers = new Layers();
  readonly events = new EventEmitter<PhysicsEvents>();
  readonly fixedStep: number;
  /** The underlying Rapier world. Engine-internal; scenes and engine code outside `physics/` should not need it. */
  readonly raw: RAPIER.World;
  /** Bodies with any number of owned colliders (the handle layer, ADR-010). */
  readonly bodies: Bodies;
  /** Joints between any two bodies, with the engine's own per-body index. */
  readonly joints: Joints;
  /**
   * Stop the clock for a pause menu: while paused, `step` advances nothing
   * and delivers no events, so every body keeps its pose and velocity exactly
   * and resumes as if no time had passed. Queries (raycasts, overlaps) still
   * answer against the frozen world. Games used to fake this by pinning each
   * body's pose every tick and guessing its spin back afterwards.
   */
  paused = false;

  /** Each entity's own body (`addBody`). */
  private readonly entityBodies: SideTable<BodyRecord>;
  private readonly pairs = new Map<number, OwnerPair>();
  private readonly pairsOf = new Map<Entity, Set<OwnerPair>>();
  private readonly eventQueue: RAPIER.EventQueue;
  /** The last step's contact forces are still queued (`contactForces` has not read them). */
  private forceEventsUnread = false;
  /** Collider handle pairs from the last drain, flat. */
  private readonly pendingStart: number[] = [];
  private readonly pendingStop: number[] = [];
  private readonly filter: QueryFilter = { body: undefined, collider: undefined, predicate: undefined };
  private exBodyA: BodyRecord | undefined;
  private exBodyB: BodyRecord | undefined;
  private exOwner: Entity = -1;
  private readonly offDestroy: () => void;
  private stepCount = 0;
  private disposed = false;
  private debugRendererInstance: PhysicsDebugRenderer | null = null;

  private constructor(options: PhysicsWorldOptions) {
    this.entities = options.entities;
    this.fixedStep = 1 / options.fixedStepHz;
    this.raw = new RAPIER.World(options.gravity ?? { x: 0, y: -9.81, z: 0 });
    this.raw.timestep = this.fixedStep;
    if (options.solverIterations !== undefined) this.solverIterations = options.solverIterations;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.bodies = new Bodies(this.raw, this.layers, this.entities);
    this.joints = new Joints(this.raw, this.bodies);
    // Destroy listeners run before side tables: the owner's contacts end and its
    // colliders on other bodies go first, then its own body (this table).
    this.offDestroy = this.entities.onDestroy((eid) => this.ownerDestroyed(eid));
    this.entityBodies = new SideTable<BodyRecord>(this.entities, (rec, eid) => this.releaseEntityBody(rec, eid));
  }

  static async create(options: PhysicsWorldOptions): Promise<PhysicsWorld> {
    if (!Number.isInteger(options.fixedStepHz) || options.fixedStepHz <= 0) {
      throw new Error(`PhysicsWorld: fixedStepHz must be a positive integer, got ${options.fixedStepHz}`);
    }
    await initRapier();
    return new PhysicsWorld(options);
  }

  // ---- world -----------------------------------------------------------------

  get gravity(): Vec3Like {
    const g = this.raw.gravity;
    return { x: g.x, y: g.y, z: g.z };
  }

  set gravity(value: Vec3Like) {
    this.raw.gravity.x = value.x;
    this.raw.gravity.y = value.y;
    this.raw.gravity.z = value.z;
  }

  /** Constraint solver iterations per step (Rapier's default is 4). */
  get solverIterations(): number {
    return this.raw.numSolverIterations;
  }

  set solverIterations(value: number) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`PhysicsWorld: solverIterations must be a positive integer, got ${value}`);
    this.raw.numSolverIterations = value;
  }

  /** Fixed steps taken so far. */
  get steps(): number {
    return this.stepCount;
  }

  /** Bodies alive: entity bodies and handle-layer bodies. */
  get bodyCount(): number {
    return this.bodies.count;
  }

  /**
   * Collider wireframe renderer, created on first access (nothing is
   * allocated until a tool asks for it). The caller adds `object` to its scene
   * and registers it as a system or calls `update()`; the inspector does both.
   */
  get debugRenderer(): PhysicsDebugRenderer {
    this.assertLive();
    if (!this.debugRendererInstance) this.debugRendererInstance = new PhysicsDebugRenderer(this);
    return this.debugRendererInstance;
  }

  /**
   * Advance the simulation by one fixed step, then deliver collision/trigger
   * events. `dt` must equal the world's fixed step; it is accepted so the
   * system signature matches the loop, and checked in development.
   */
  step(dt: number = this.fixedStep): void {
    this.assertLive();
    if (Math.abs(dt - this.fixedStep) > 1e-9) {
      throw new Error(`PhysicsWorld.step: dt ${dt} does not match the fixed step ${this.fixedStep}`);
    }
    if (this.paused) return;
    // Colliders removed before this step are named in its stop events; forget them once those are counted.
    const removed = this.bodies.takeGraveyard();
    // Rapier's auto-drain leaves contact force events queued: drop the last step's, unread, so a read sees one step.
    // Its `clear()` leaves them too (ten steps' worth were still there after it), so they are drained, unread.
    if (this.forceEventsUnread) this.eventQueue.drainContactForceEvents(() => {});
    this.forceEventsUnread = true;
    this.raw.step(this.eventQueue);
    this.stepCount += 1;
    try {
      this.drainEvents();
    } finally {
      this.bodies.purge(removed);
    }
  }

  // ---- entity bodies -------------------------------------------------------------

  hasBody(eid: Entity): boolean {
    return this.entityBodies.has(eid);
  }

  /** The handle of an entity's own body, for the handle-layer calls (`bodies`, `joints`). */
  bodyOf(eid: Entity): BodyHandle | undefined {
    return this.entityBodies.get(eid)?.id;
  }

  /**
   * Attach a rigid body + collider to an entity, reading the initial pose from
   * its Transform. Adds the `RigidBody` component.
   */
  addBody(eid: Entity, desc: BodyDesc): void {
    this.assertLive();
    if (!this.entities.exists(eid)) throw new Error(`PhysicsWorld.addBody: entity ${eid} does not exist`);
    if (this.entityBodies.has(eid)) throw new Error(`PhysicsWorld.addBody: entity ${eid} already has a body`);
    if (!this.entities.has(eid, Transform)) this.entities.add(eid, Transform);
    const t = this.entities.store(Transform);

    const rec = this.bodies.createRecord(
      {
        type: desc.type,
        position: { x: t.x[eid] ?? 0, y: t.y[eid] ?? 0, z: t.z[eid] ?? 0 },
        rotation: { x: t.qx[eid] ?? 0, y: t.qy[eid] ?? 0, z: t.qz[eid] ?? 0, w: t.qw[eid] ?? 1 },
        ccd: desc.ccd,
        lockRotations: desc.lockRotations,
        linearDamping: desc.linearDamping,
        angularDamping: desc.angularDamping,
      },
      eid,
    );
    try {
      this.bodies.addColliderTo(rec, {
        shape: desc.shape,
        owner: eid,
        friction: desc.friction,
        restitution: desc.restitution,
        layer: desc.layer,
        collidesWith: desc.collidesWith,
        isSensor: desc.isSensor,
        mass: desc.mass,
        events: desc.events ?? true,
      });
    } catch (error) {
      this.bodies.destroyRecord(rec);
      throw error;
    }

    this.entities.add(eid, RigidBody, { type: BODY_TYPE[desc.type], sleeping: 0 });
    this.entityBodies.set(eid, rec);
  }

  /**
   * Resize a capsule collider in place (stances, growth) without rebuilding
   * the body or re-attaching a character controller. The body pose is the
   * capsule centre, so callers move the transform when the feet must stay put.
   */
  setCapsule(eid: Entity, halfHeight: number, radius: number): void {
    this.assertLive();
    const collider = this.rawCollider(eid);
    if (!collider) throw new Error(`PhysicsWorld.setCapsule: entity ${eid} has no collider`);
    if (collider.shape.type !== RAPIER.ShapeType.Capsule) throw new Error(`PhysicsWorld.setCapsule: entity ${eid} is not a capsule`);
    collider.setHalfHeight(Math.max(0, halfHeight));
    collider.setRadius(Math.max(0.001, radius));
  }

  /**
   * Connect two entities' bodies with an impulse joint. Returns a handle for
   * `removeJoint`; joints also go away with either body.
   */
  addJoint(a: Entity, b: Entity, desc: JointDesc): number {
    this.assertLive();
    const bodyA = this.entityBodies.get(a);
    const bodyB = this.entityBodies.get(b);
    if (!bodyA || !bodyB) throw new Error(`PhysicsWorld.addJoint: entities ${a} and ${b} both need bodies`);
    return this.joints.create(bodyA.id, bodyB.id, desc);
  }

  removeJoint(handle: number): boolean {
    return this.joints.remove(handle as JointHandle);
  }

  /** Joints alive, whichever API made them. */
  get jointCount(): number {
    return this.joints.count;
  }

  /** Remove the body and collider from the entity. The entity itself survives. */
  removeBody(eid: Entity): void {
    if (this.disposed) return;
    if (!this.entityBodies.delete(eid)) return;
    if (this.entities.exists(eid)) this.entities.remove(eid, RigidBody);
  }

  /** An entity body is going (removeBody, entity destroyed, world disposed). */
  private releaseEntityBody(rec: BodyRecord, eid: Entity): void {
    if (this.disposed) return; // the records and the Rapier world go together in dispose()
    // Anything still touching the entity gets its end/exit event now, as it
    // always has, unless the entity also owns colliders on other bodies:
    // those are still touching things, so Rapier's stop events count down instead.
    const owned = this.bodies.ownedBy(eid);
    let elsewhere = false;
    if (owned) {
      for (const c of owned) {
        if (c.bodyRec !== rec) {
          elsewhere = true;
          break;
        }
      }
    }
    if (!elsewhere) this.endContactsOf(eid);
    this.bodies.destroyRecord(rec);
  }

  /** An entity was destroyed: whatever it owned goes with it. */
  private ownerDestroyed(eid: Entity): void {
    if (this.disposed) return;
    if (this.bodies.ownedBy(eid) || this.bodies.removedBy(eid) || this.pairsOf.has(eid)) this.endContactsOf(eid);
    this.entityBodies.delete(eid);
    const rest = this.bodies.ownedBy(eid);
    if (rest) for (const c of [...rest]) this.bodies.dropCollider(c, false);
  }

  bodyType(eid: Entity): BodyType | undefined {
    const code = this.entities.store(RigidBody).type[eid];
    if (!this.entities.has(eid, RigidBody) || code === undefined) return undefined;
    return (Object.keys(BODY_TYPE) as BodyType[]).find((k) => BODY_TYPE[k] === code);
  }

  isSleeping(eid: Entity): boolean {
    return this.entityBodies.get(eid)?.rb.isSleeping() ?? false;
  }

  wake(eid: Entity): void {
    this.entityBodies.get(eid)?.rb.wakeUp();
  }

  setLinearVelocity(eid: Entity, v: Vec3Like): void {
    this.entityBodies.require(eid).rb.setLinvel(v, true);
  }

  setAngularVelocity(eid: Entity, v: Vec3Like): void {
    this.entityBodies.require(eid).rb.setAngvel(v, true);
  }

  applyImpulse(eid: Entity, v: Vec3Like): void {
    this.entityBodies.require(eid).rb.applyImpulse(v, true);
  }

  /** Persistent force for this step; Rapier resets user forces after each step. */
  applyForce(eid: Entity, v: Vec3Like): void {
    this.entityBodies.require(eid).rb.addForce(v, true);
  }

  getVelocity(eid: Entity, out: Vec3Like = { x: 0, y: 0, z: 0 }): Vec3Like {
    const v = this.entityBodies.require(eid).rb.linvel(_v);
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
    return out;
  }

  /**
   * Move a kinematic body for the next step. Writes the entity's Transform so
   * the kinematic push system and the body agree; also sets the body's next
   * pose directly so it takes effect even if called after the push.
   */
  setKinematicTarget(eid: Entity, position: Vec3Like, quaternion: QuatLike = _identity): void {
    const body = this.entityBodies.require(eid).rb;
    const t = this.entities.store(Transform);
    t.x[eid] = position.x;
    t.y[eid] = position.y;
    t.z[eid] = position.z;
    t.qx[eid] = quaternion.x;
    t.qy[eid] = quaternion.y;
    t.qz[eid] = quaternion.z;
    t.qw[eid] = quaternion.w;
    body.setNextKinematicTranslation(position);
    body.setNextKinematicRotation(quaternion);
  }

  /** Teleport any body (dynamic bodies keep their velocity). Also writes Transform. */
  setPose(eid: Entity, position: Vec3Like, quaternion: QuatLike = _identity): void {
    const body = this.entityBodies.require(eid).rb;
    const t = this.entities.store(Transform);
    t.x[eid] = position.x;
    t.y[eid] = position.y;
    t.z[eid] = position.z;
    t.qx[eid] = quaternion.x;
    t.qy[eid] = quaternion.y;
    t.qz[eid] = quaternion.z;
    t.qw[eid] = quaternion.w;
    body.setTranslation(position, true);
    body.setRotation(quaternion, true);
  }

  // ---- internal access for sibling modules ------------------------------------

  /** @internal */
  rawBody(eid: Entity): RAPIER.RigidBody | undefined {
    return this.entityBodies.get(eid)?.rb;
  }

  /** @internal The collider `addBody` made. */
  rawCollider(eid: Entity): RAPIER.Collider | undefined {
    const rec = this.entityBodies.get(eid);
    return rec ? this.bodies.primaryOf(rec)?.rc : undefined;
  }

  /** @internal The owner of a live collider, by Rapier handle. */
  entityOfCollider(handle: number): Entity | undefined {
    const rec = this.bodies.ofRapier(handle);
    return rec?.alive ? rec.owner : undefined;
  }

  // ---- per-tick sync (called by the systems) -----------------------------------

  /** Push Transform into every kinematic body as its next pose. */
  pushKinematics(): void {
    const t = this.entities.store(Transform);
    const rb = this.entities.store(RigidBody);
    for (const eid of this.entities.query(RigidBody, Transform)) {
      if (rb.type[eid] !== BODY_TYPE.kinematicPosition) continue;
      const body = this.entityBodies.get(eid)?.rb;
      if (!body) continue;
      _v.x = t.x[eid] ?? 0;
      _v.y = t.y[eid] ?? 0;
      _v.z = t.z[eid] ?? 0;
      _q.x = t.qx[eid] ?? 0;
      _q.y = t.qy[eid] ?? 0;
      _q.z = t.qz[eid] ?? 0;
      _q.w = t.qw[eid] ?? 1;
      body.setNextKinematicTranslation(_v);
      body.setNextKinematicRotation(_q);
    }
  }

  /** Copy simulated poses into Transform and refresh the sleeping flag. */
  syncTransforms(): void {
    const t = this.entities.store(Transform);
    const rb = this.entities.store(RigidBody);
    for (const eid of this.entities.query(RigidBody, Transform)) {
      const type = rb.type[eid];
      if (type === BODY_TYPE.fixed) continue;
      const body = this.entityBodies.get(eid)?.rb;
      if (!body) continue;
      const sleeping = body.isSleeping();
      rb.sleeping[eid] = sleeping ? 1 : 0;
      if (sleeping && type === BODY_TYPE.dynamic) continue;
      const p = body.translation(_v);
      const q = body.rotation(_q);
      t.x[eid] = p.x;
      t.y[eid] = p.y;
      t.z[eid] = p.z;
      t.qx[eid] = q.x;
      t.qy[eid] = q.y;
      t.qz[eid] = q.z;
      t.qw[eid] = q.w;
    }
  }

  // ---- queries ------------------------------------------------------------------

  /**
   * Closest hit along a ray, naming the owner, part, collider and body.
   * `direction` need not be normalised; `distance` is in world units.
   */
  raycast(origin: Vec3Like, direction: Vec3Like, maxDistance: number, options: RaycastOptions = {}): RaycastHit | null {
    this.assertLive();
    const len = Math.hypot(direction.x, direction.y, direction.z);
    if (len === 0) return null;
    _rayDir.x = direction.x / len;
    _rayDir.y = direction.y / len;
    _rayDir.z = direction.z / len;
    const ray = new RAPIER.Ray(origin, _rayDir);
    const flags = options.includeSensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const filter = this.prepareFilter(options.excludeEid, options.excludeBody, options.excludeCollider);
    const hit = this.raw.castRayAndGetNormal(
      ray,
      maxDistance,
      options.solid ?? true,
      flags,
      this.layers.queryGroups(options.layers ?? 'all'),
      filter.collider,
      filter.body,
      filter.predicate,
    );
    if (!hit) return null;
    const rec = this.bodies.ofRapier(hit.collider.handle);
    if (!rec) return null; // a collider made around the engine (through `raw`) has no owner
    const d = hit.timeOfImpact;
    return {
      eid: rec.owner,
      part: rec.part,
      collider: rec.id,
      body: rec.body,
      distance: d,
      point: { x: origin.x + _rayDir.x * d, y: origin.y + _rayDir.y * d, z: origin.z + _rayDir.z * d },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
    };
  }

  /** Entities whose colliders overlap a sphere, sorted by id (stable order). */
  sphereOverlap(center: Vec3Like, radius: number, layers: LayerSpec = 'all', includeSensors = false): Entity[] {
    this.assertLive();
    const shape = new RAPIER.Ball(radius);
    const found = new Set<Entity>();
    this.raw.intersectionsWithShape(
      center,
      _identity,
      shape,
      (collider) => {
        const rec = this.bodies.ofRapier(collider.handle);
        if (rec?.alive) found.add(rec.owner);
        return true;
      },
      includeSensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      this.layers.queryGroups(layers),
    );
    return [...found].sort((a, b) => a - b);
  }

  /**
   * Every collider overlapping `shape` placed at `pose`, one `visit` per
   * collider (return false from it to stop). `shape` can be a live collider's
   * handle to test its own shape somewhere else (e.g. a little lower, to ask
   * whether something holds it up); pass it as `excludeCollider` too so it
   * does not find itself. Returns how many colliders were visited.
   */
  overlapShape(shape: ShapeDesc | ColliderHandle, pose: Pose, visit: OverlapVisitor, options: OverlapOptions = {}): number {
    this.assertLive();
    let query: RAPIER.Shape;
    if (typeof shape === 'number') {
      const rec = this.bodies.colliderRecord(shape);
      if (!rec?.alive) throw new Error(`PhysicsWorld.overlapShape: collider ${shape} does not exist`);
      query = rec.rc.shape;
    } else {
      query = queryShapeFor(shape);
    }
    const filter = this.prepareFilter(options.excludeEid, options.excludeBody, options.excludeCollider);
    let visited = 0;
    this.raw.intersectionsWithShape(
      pose.position,
      pose.rotation ?? _identity,
      query,
      (collider) => {
        const rec = this.bodies.ofRapier(collider.handle);
        if (!rec?.alive) return true;
        visited += 1;
        return visit(rec.id, rec.owner, rec.part) !== false;
      },
      options.includeSensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      this.layers.queryGroups(options.layers ?? 'all'),
      filter.collider,
      filter.body,
      filter.predicate,
    );
    return visited;
  }

  /**
   * The contact forces of the last step, for every touching pair where a
   * collider made with `forceEvents` pushed harder than its threshold: one
   * `visit` per pair. Read them between steps; the next step drops what was
   * not read. A sleeping body's contacts are not solved, so they report
   * nothing.
   */
  contactForces(visit: ContactForceVisitor): void {
    this.assertLive();
    this.forceEventsUnread = false;
    // Rapier sums its stabilization pass in with the n solver iterations: a block at rest read
    // (n + 1) / n times its weight (2x at one iteration, 1.25x at four). Scaled back to the weight.
    const n = this.solverIterations;
    const scale = n / (n + 1);
    this.eventQueue.drainContactForceEvents((e) => {
      const r1 = this.bodies.ofRapier(e.collider1());
      const r2 = this.bodies.ofRapier(e.collider2());
      if (!r1?.alive || !r2?.alive) return;
      e.totalForce(_force);
      _force.x *= scale;
      _force.y *= scale;
      _force.z *= scale;
      visit(r1.id, r2.id, _force);
    });
  }

  /**
   * Build the exclusions for one query. The common cases (one entity body, one
   * body, one collider) use Rapier's own filters; an entity that owns colliders
   * on other bodies, two bodies, or a sharded fixed body fall back to a predicate.
   */
  private prepareFilter(excludeEid: Entity | undefined, excludeBody: BodyHandle | undefined, excludeCollider: ColliderHandle | undefined): QueryFilter {
    const f = this.filter;
    f.body = undefined;
    f.predicate = undefined;
    const c = excludeCollider !== undefined ? this.bodies.colliderRecord(excludeCollider) : undefined;
    f.collider = c?.alive ? c.rc : undefined;

    let bodyA: BodyRecord | undefined;
    let bodyB: BodyRecord | undefined;
    let owner: Entity = -1;
    if (excludeEid !== undefined) {
      bodyA = this.entityBodies.get(excludeEid);
      const owned = this.bodies.ownedBy(excludeEid);
      // More than the one collider its own body was made with: skip by owner.
      if (owned && !(bodyA && owned.size === 1)) owner = excludeEid;
    }
    if (excludeBody !== undefined) {
      const rec = this.bodies.record(excludeBody);
      if (rec && rec !== bodyA) {
        if (bodyA) bodyB = rec;
        else bodyA = rec;
      }
    }
    if (owner < 0 && !bodyB && (!bodyA || bodyA.shards.length === 1)) {
      f.body = bodyA?.rb;
      return f;
    }
    this.exBodyA = bodyA;
    this.exBodyB = bodyB;
    this.exOwner = owner;
    f.predicate = this.excludePredicate;
    return f;
  }

  private readonly excludePredicate = (collider: RAPIER.Collider): boolean => {
    const rec = this.bodies.ofRapier(collider.handle);
    if (!rec) return true;
    return rec.bodyRec !== this.exBodyA && rec.bodyRec !== this.exBodyB && rec.owner !== this.exOwner;
  };

  // ---- events ---------------------------------------------------------------------

  private drainEvents(): void {
    const starts = this.pendingStart;
    const stops = this.pendingStop;
    starts.length = 0;
    stops.length = 0;
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      const list = started ? starts : stops;
      list.push(h1, h2);
    });
    // Starts before stops: when one collider pair of two owners parts as another
    // meets, the owners never stopped touching, and no end/start blip goes out.
    for (let i = 0; i < starts.length; i += 2) this.countPair(starts[i] as number, starts[i + 1] as number, true);
    for (let i = 0; i < stops.length; i += 2) this.countPair(stops[i] as number, stops[i + 1] as number, false);
  }

  private countPair(h1: number, h2: number, started: boolean): void {
    const r1 = this.bodies.ofRapier(h1);
    const r2 = this.bodies.ofRapier(h2);
    if (!r1 || !r2 || r1.ended || r2.ended) return;
    if (r1.owner === r2.owner) return; // a building's chunks pressing on each other are not news
    const sensor = r1.sensor || r2.sensor;
    // Sensor's owner first for triggers; ascending id for contacts.
    let a: Entity;
    let b: Entity;
    if (sensor) {
      a = r1.sensor ? r1.owner : r2.owner;
      b = r1.sensor ? r2.owner : r1.owner;
    } else {
      a = Math.min(r1.owner, r2.owner);
      b = Math.max(r1.owner, r2.owner);
    }
    const key = ownerPairKey(a, b, sensor);
    let pair = this.pairs.get(key);
    if (started) {
      if (!pair) {
        pair = { a, b, sensor, key, count: 0 };
        this.indexPair(pair);
      }
      pair.count += 1;
      if (pair.count === 1) this.events.emit(sensor ? 'triggerEnter' : 'collisionStart', { a: pair.a, b: pair.b });
    } else {
      if (!pair) return;
      pair.count -= 1;
      if (pair.count > 0) return;
      this.unindexPair(pair);
      this.events.emit(sensor ? 'triggerExit' : 'collisionEnd', { a: pair.a, b: pair.b });
    }
  }

  private indexPair(pair: OwnerPair): void {
    this.pairs.set(pair.key, pair);
    for (const owner of [pair.a, pair.b]) {
      let set = this.pairsOf.get(owner);
      if (!set) {
        set = new Set();
        this.pairsOf.set(owner, set);
      }
      set.add(pair);
    }
  }

  private unindexPair(pair: OwnerPair): void {
    this.pairs.delete(pair.key);
    for (const owner of [pair.a, pair.b]) {
      const set = this.pairsOf.get(owner);
      if (!set) continue;
      set.delete(pair);
      if (set.size === 0) this.pairsOf.delete(owner);
    }
  }

  /**
   * End everything an owner is touching, now, and mark its colliders (live,
   * and removed since the last step) so the stop events Rapier sends for them
   * are not counted again, against this owner or an entity that reuses its id.
   */
  private endContactsOf(eid: Entity): void {
    const owned = this.bodies.ownedBy(eid);
    if (owned) for (const c of owned) c.ended = true;
    const removed = this.bodies.removedBy(eid);
    if (removed) for (const c of removed) c.ended = true;
    const set = this.pairsOf.get(eid);
    if (!set) return;
    for (const pair of [...set]) {
      this.unindexPair(pair);
      this.events.emit(pair.sensor ? 'triggerExit' : 'collisionEnd', { a: pair.a, b: pair.b });
    }
  }

  /** Is `a` currently overlapping/touching `b`? */
  isTouching(a: Entity, b: Entity): boolean {
    return this.pairs.has(ownerPairKey(a, b, false)) || this.pairs.has(ownerPairKey(a, b, true));
  }

  // ---- lifecycle ------------------------------------------------------------------

  private assertLive(): void {
    if (this.disposed) throw new Error('PhysicsWorld: disposed');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // No exit events on teardown; side tables detach from the entity world and
    // the bodies are freed with the world.
    this.offDestroy();
    this.pairs.clear();
    this.pairsOf.clear();
    this.events.clear();
    this.debugRendererInstance?.dispose();
    this.debugRendererInstance = null;
    this.entityBodies.dispose();
    this.joints.dispose();
    this.bodies.dispose();
    this.eventQueue.free();
    this.raw.free();
  }
}
