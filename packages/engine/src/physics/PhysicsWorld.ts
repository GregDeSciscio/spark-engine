import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Disposable } from '../core/Disposable';
import { EventEmitter } from '../core/Events';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import { SideTable } from '../ecs/SideTable';
import { BODY_TYPE, RigidBody, type BodyType } from './components';
import { Layers, type LayerSpec } from './Layers';
import { PhysicsDebugRenderer } from './PhysicsDebugRenderer';

// ---- public types ----------------------------------------------------------

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type ShapeDesc =
  | { kind: 'box'; hx: number; hy: number; hz: number }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; halfHeight: number; radius: number }
  | { kind: 'trimesh'; vertices: Float32Array; indices: Uint32Array }
  | {
      kind: 'heightfield';
      /** Row-major `rows × cols` heights (Rapier layout: rows along Z, columns along X). */
      rows: number;
      cols: number;
      heights: Float32Array;
      /** World size of the field along x/z and the height multiplier along y. */
      scale: Vec3Like;
    };

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
  /** A sensor and another collider started overlapping. `a` is the sensor. */
  triggerEnter: PhysicsPair;
  triggerExit: PhysicsPair;
  /** Two non-sensor colliders came into contact. `a < b`. */
  collisionStart: PhysicsPair;
  collisionEnd: PhysicsPair;
}

export interface RaycastOptions {
  /** Only hit colliders belonging to these layers. Default all. */
  layers?: LayerSpec;
  /** Ignore this entity's body (e.g. the caster). */
  excludeEid?: Entity;
  /** Treat shapes as solid: a ray starting inside one hits at distance 0. Default true. */
  solid?: boolean;
  /** Include sensor colliders. Default false. */
  includeSensors?: boolean;
}

export interface RaycastHit {
  eid: Entity;
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
const _identity: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

/** Pair key for active-contact bookkeeping. Entity ids are far below 2^20. */
function pairKey(a: Entity, b: Entity): number {
  return a < b ? a * 0x100000 + b : b * 0x100000 + a;
}

function colliderDescFor(shape: ShapeDesc): RAPIER.ColliderDesc {
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
  }
}

function bodyDescFor(type: BodyType): RAPIER.RigidBodyDesc {
  switch (type) {
    case 'dynamic':
      return RAPIER.RigidBodyDesc.dynamic();
    case 'fixed':
      return RAPIER.RigidBodyDesc.fixed();
    case 'kinematicPosition':
      return RAPIER.RigidBodyDesc.kinematicPositionBased();
  }
}

interface ActivePair {
  a: Entity;
  b: Entity;
  sensor: boolean;
}

/**
 * The engine's physics world: Rapier 3D on the main thread at the fixed step
 * (ADR-002). Bodies are attached to entities; the Rapier objects live in side
 * tables here and are released when the entity is destroyed. Only this module
 * imports Rapier.
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
  /** The underlying Rapier world. Engine-internal; scenes should not need it. */
  readonly raw: RAPIER.World;

  private readonly bodies: SideTable<RAPIER.RigidBody>;
  private readonly colliders: SideTable<RAPIER.Collider>;
  private readonly colliderToEid = new Map<number, Entity>();
  private readonly activePairs = new Map<number, ActivePair>();
  private readonly eventQueue: RAPIER.EventQueue;
  private readonly pendingStart: Array<[number, number]> = [];
  private readonly pendingStop: Array<[number, number]> = [];
  private stepCount = 0;
  private disposed = false;
  private debugRendererInstance: PhysicsDebugRenderer | null = null;

  private constructor(options: PhysicsWorldOptions) {
    this.entities = options.entities;
    this.fixedStep = 1 / options.fixedStepHz;
    this.raw = new RAPIER.World(options.gravity ?? { x: 0, y: -9.81, z: 0 });
    this.raw.timestep = this.fixedStep;
    this.eventQueue = new RAPIER.EventQueue(true);
    // Removing the body also removes its colliders. Register the body table
    // first so it runs first on entity destroy.
    this.bodies = new SideTable<RAPIER.RigidBody>(this.entities, (body, eid) => this.releaseBody(body, eid));
    this.colliders = new SideTable<RAPIER.Collider>(this.entities);
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

  /** Fixed steps taken so far. */
  get steps(): number {
    return this.stepCount;
  }

  get bodyCount(): number {
    return this.bodies.size;
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
    this.raw.step(this.eventQueue);
    this.stepCount += 1;
    this.drainEvents();
  }

  // ---- bodies ------------------------------------------------------------------

  hasBody(eid: Entity): boolean {
    return this.bodies.has(eid);
  }

  /**
   * Attach a rigid body + collider to an entity, reading the initial pose from
   * its Transform. Adds the `RigidBody` component.
   */
  addBody(eid: Entity, desc: BodyDesc): void {
    this.assertLive();
    if (!this.entities.exists(eid)) throw new Error(`PhysicsWorld.addBody: entity ${eid} does not exist`);
    if (this.bodies.has(eid)) throw new Error(`PhysicsWorld.addBody: entity ${eid} already has a body`);
    if (!this.entities.has(eid, Transform)) this.entities.add(eid, Transform);
    const t = this.entities.store(Transform);

    const bodyDesc = bodyDescFor(desc.type)
      .setTranslation(t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0)
      .setRotation({ x: t.qx[eid] ?? 0, y: t.qy[eid] ?? 0, z: t.qz[eid] ?? 0, w: t.qw[eid] ?? 1 });
    if (desc.ccd) bodyDesc.setCcdEnabled(true);
    if (desc.lockRotations) bodyDesc.lockRotations();
    if (desc.linearDamping !== undefined) bodyDesc.setLinearDamping(desc.linearDamping);
    if (desc.angularDamping !== undefined) bodyDesc.setAngularDamping(desc.angularDamping);
    const body = this.raw.createRigidBody(bodyDesc);

    const colliderDesc = colliderDescFor(desc.shape)
      .setFriction(desc.friction ?? 0.5)
      .setRestitution(desc.restitution ?? 0)
      .setCollisionGroups(this.layers.groups(desc.layer ?? 'default', desc.collidesWith ?? 'all'))
      .setSensor(desc.isSensor ?? false);
    if (desc.mass !== undefined) colliderDesc.setMass(desc.mass);
    if (desc.events ?? true) colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    // Sensors should notice kinematic and fixed bodies too, not only dynamic ones.
    if (desc.isSensor) colliderDesc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
    const collider = this.raw.createCollider(colliderDesc, body);

    this.entities.add(eid, RigidBody, { type: BODY_TYPE[desc.type], sleeping: 0 });
    this.bodies.set(eid, body);
    this.colliders.set(eid, collider);
    this.colliderToEid.set(collider.handle, eid);
  }

  /** Remove the body and collider from the entity. The entity itself survives. */
  removeBody(eid: Entity): void {
    if (this.disposed) return;
    if (!this.bodies.delete(eid)) return;
    this.colliders.delete(eid);
    if (this.entities.exists(eid)) this.entities.remove(eid, RigidBody);
  }

  private releaseBody(body: RAPIER.RigidBody, eid: Entity): void {
    // Anything still touching this body gets its end/exit event now, since
    // Rapier's own "stopped" event would arrive with a handle we no longer know.
    for (const [key, pair] of this.activePairs) {
      if (pair.a !== eid && pair.b !== eid) continue;
      this.activePairs.delete(key);
      this.events.emit(pair.sensor ? 'triggerExit' : 'collisionEnd', { a: pair.a, b: pair.b });
    }
    const collider = this.colliders.get(eid);
    if (collider) this.colliderToEid.delete(collider.handle);
    if (!this.disposed) this.raw.removeRigidBody(body);
  }

  bodyType(eid: Entity): BodyType | undefined {
    const code = this.entities.store(RigidBody).type[eid];
    if (!this.entities.has(eid, RigidBody) || code === undefined) return undefined;
    return (Object.keys(BODY_TYPE) as BodyType[]).find((k) => BODY_TYPE[k] === code);
  }

  isSleeping(eid: Entity): boolean {
    return this.bodies.get(eid)?.isSleeping() ?? false;
  }

  wake(eid: Entity): void {
    this.bodies.get(eid)?.wakeUp();
  }

  setLinearVelocity(eid: Entity, v: Vec3Like): void {
    this.bodies.require(eid).setLinvel(v, true);
  }

  setAngularVelocity(eid: Entity, v: Vec3Like): void {
    this.bodies.require(eid).setAngvel(v, true);
  }

  applyImpulse(eid: Entity, v: Vec3Like): void {
    this.bodies.require(eid).applyImpulse(v, true);
  }

  /** Persistent force for this step; Rapier resets user forces after each step. */
  applyForce(eid: Entity, v: Vec3Like): void {
    this.bodies.require(eid).addForce(v, true);
  }

  getVelocity(eid: Entity, out: Vec3Like = { x: 0, y: 0, z: 0 }): Vec3Like {
    const v = this.bodies.require(eid).linvel(_v);
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
    const body = this.bodies.require(eid);
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
    const body = this.bodies.require(eid);
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
    return this.bodies.get(eid);
  }

  /** @internal */
  rawCollider(eid: Entity): RAPIER.Collider | undefined {
    return this.colliders.get(eid);
  }

  /** @internal */
  entityOfCollider(handle: number): Entity | undefined {
    return this.colliderToEid.get(handle);
  }

  // ---- per-tick sync (called by the systems) -----------------------------------

  /** Push Transform into every kinematic body as its next pose. */
  pushKinematics(): void {
    const t = this.entities.store(Transform);
    const rb = this.entities.store(RigidBody);
    for (const eid of this.entities.query(RigidBody, Transform)) {
      if (rb.type[eid] !== BODY_TYPE.kinematicPosition) continue;
      const body = this.bodies.get(eid);
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
      const body = this.bodies.get(eid);
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

  /** Closest hit along a ray. `direction` need not be normalised; `distance` is in world units. */
  raycast(origin: Vec3Like, direction: Vec3Like, maxDistance: number, options: RaycastOptions = {}): RaycastHit | null {
    this.assertLive();
    const len = Math.hypot(direction.x, direction.y, direction.z);
    if (len === 0) return null;
    _rayDir.x = direction.x / len;
    _rayDir.y = direction.y / len;
    _rayDir.z = direction.z / len;
    const ray = new RAPIER.Ray(origin, _rayDir);
    const flags = options.includeSensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const exclude = options.excludeEid !== undefined ? this.bodies.get(options.excludeEid) : undefined;
    const hit = this.raw.castRayAndGetNormal(
      ray,
      maxDistance,
      options.solid ?? true,
      flags,
      this.layers.queryGroups(options.layers ?? 'all'),
      undefined,
      exclude,
    );
    if (!hit) return null;
    const eid = this.colliderToEid.get(hit.collider.handle);
    if (eid === undefined) return null;
    const d = hit.timeOfImpact;
    return {
      eid,
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
        const eid = this.colliderToEid.get(collider.handle);
        if (eid !== undefined) found.add(eid);
        return true;
      },
      includeSensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      this.layers.queryGroups(layers),
    );
    return [...found].sort((a, b) => a - b);
  }

  // ---- events ---------------------------------------------------------------------

  private drainEvents(): void {
    this.pendingStart.length = 0;
    this.pendingStop.length = 0;
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      (started ? this.pendingStart : this.pendingStop).push([h1, h2]);
    });
    // Stops first so a pair that ended and restarted in one step nets out in order.
    for (const [h1, h2] of this.pendingStop) this.emitPair(h1, h2, false);
    for (const [h1, h2] of this.pendingStart) this.emitPair(h1, h2, true);
  }

  private emitPair(h1: number, h2: number, started: boolean): void {
    const e1 = this.colliderToEid.get(h1);
    const e2 = this.colliderToEid.get(h2);
    if (e1 === undefined || e2 === undefined) return; // already handled by releaseBody
    const c1 = this.raw.colliders.get(h1);
    const c2 = this.raw.colliders.get(h2);
    const s1 = c1?.isSensor() ?? false;
    const s2 = c2?.isSensor() ?? false;
    const sensor = s1 || s2;
    // Sensor first for triggers; ascending id for contacts.
    let a: Entity;
    let b: Entity;
    if (sensor) {
      a = s1 ? e1 : e2;
      b = s1 ? e2 : e1;
    } else {
      a = Math.min(e1, e2);
      b = Math.max(e1, e2);
    }
    const key = pairKey(a, b);
    if (started) {
      if (this.activePairs.has(key)) return;
      this.activePairs.set(key, { a, b, sensor });
      this.events.emit(sensor ? 'triggerEnter' : 'collisionStart', { a, b });
    } else {
      if (!this.activePairs.delete(key)) return;
      this.events.emit(sensor ? 'triggerExit' : 'collisionEnd', { a, b });
    }
  }

  /** Is `a` currently overlapping/touching `b`? */
  isTouching(a: Entity, b: Entity): boolean {
    return this.activePairs.has(pairKey(a, b));
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
    this.activePairs.clear();
    this.events.clear();
    this.debugRendererInstance?.dispose();
    this.debugRendererInstance = null;
    this.bodies.dispose();
    this.colliders.dispose();
    this.colliderToEid.clear();
    this.eventQueue.free();
    this.raw.free();
  }
}
