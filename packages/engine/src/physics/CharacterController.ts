import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Disposable } from '../core/Disposable';
import { Transform } from '../ecs/components/Transform';
import type { Entity } from '../ecs/EntityWorld';
import { BODY_TYPE, Character, RigidBody } from './components';
import type { PhysicsWorld, Vec3Like } from './PhysicsWorld';

export interface CharacterControllerOptions {
  /** Gap kept between the character and its surroundings. Default 0.02. */
  offset?: number;
  /** Steepest slope the character can walk up, radians. Default 50°. */
  maxSlopeClimbAngle?: number;
  /** Slope at which the character starts sliding down, radians. Default 55°. */
  minSlopeSlideAngle?: number;
  /** Highest step climbed automatically. 0 disables autostep. Default 0.35. */
  stepHeight?: number;
  /** Free space required past a step for autostep. Default 0.2. */
  stepMinWidth?: number;
  /** Snap-to-ground distance when moving down slopes/steps. 0 disables. Default 0.3. */
  snapToGround?: number;
  /** Vertical acceleration applied every move. Default -9.81 * 2 (games like snappier falls). */
  gravity?: number;
  /** Terminal fall speed, positive number. Default 40. */
  maxFallSpeed?: number;
  /** Push dynamic bodies the character walks into. Default true. */
  pushDynamicBodies?: boolean;
  /** Mass used when pushing. Default 70. */
  characterMass?: number;
}

const _desired = { x: 0, y: 0, z: 0 };
const _moved = { x: 0, y: 0, z: 0 };
const _next = { x: 0, y: 0, z: 0 };

/**
 * Kinematic character movement on top of Rapier's `KinematicCharacterController`.
 *
 * The entity must already have a `kinematicPosition` body (a capsule is the
 * usual shape). `move()` takes the displacement the player *wants* this tick
 * (usually horizontal input × speed × dt), adds the accumulated vertical
 * velocity (gravity, jumps), resolves it against the world with slopes,
 * autostep and snap-to-ground, and writes the result into Transform. The
 * kinematic push system then hands the pose to Rapier before the step.
 *
 * Deterministic: state lives in the `Character` component and nothing here
 * reads the clock.
 */
export class CharacterController implements Disposable {
  readonly physics: PhysicsWorld;
  readonly gravity: number;
  readonly maxFallSpeed: number;

  private readonly controller: RAPIER.KinematicCharacterController;
  private readonly attached = new Set<Entity>();
  private disposed = false;

  constructor(physics: PhysicsWorld, options: CharacterControllerOptions = {}) {
    this.physics = physics;
    this.gravity = options.gravity ?? -9.81 * 2;
    this.maxFallSpeed = options.maxFallSpeed ?? 40;
    const c = physics.raw.createCharacterController(options.offset ?? 0.02);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setSlideEnabled(true);
    c.setMaxSlopeClimbAngle(options.maxSlopeClimbAngle ?? (50 * Math.PI) / 180);
    c.setMinSlopeSlideAngle(options.minSlopeSlideAngle ?? (55 * Math.PI) / 180);
    const step = options.stepHeight ?? 0.35;
    if (step > 0) c.enableAutostep(step, options.stepMinWidth ?? 0.2, true);
    else c.disableAutostep();
    const snap = options.snapToGround ?? 0.3;
    if (snap > 0) c.enableSnapToGround(snap);
    else c.disableSnapToGround();
    c.setApplyImpulsesToDynamicBodies(options.pushDynamicBodies ?? true);
    c.setCharacterMass(options.characterMass ?? 70);
    this.controller = c;
  }

  /** Register an entity. It must have a kinematic-position body. Adds the `Character` component. */
  attach(eid: Entity): void {
    this.assertLive();
    const type = this.physics.entities.store(RigidBody).type[eid];
    if (!this.physics.hasBody(eid) || type !== BODY_TYPE.kinematicPosition) {
      throw new Error(`CharacterController.attach: entity ${eid} needs a kinematicPosition body first`);
    }
    this.physics.entities.add(eid, Character, { vy: 0, grounded: 0 });
    this.attached.add(eid);
  }

  detach(eid: Entity): void {
    if (!this.attached.delete(eid)) return;
    if (this.physics.entities.exists(eid)) this.physics.entities.remove(eid, Character);
  }

  isAttached(eid: Entity): boolean {
    return this.attached.has(eid);
  }

  isGrounded(eid: Entity): boolean {
    return (this.physics.entities.store(Character).grounded[eid] ?? 0) !== 0;
  }

  verticalVelocity(eid: Entity): number {
    return this.physics.entities.store(Character).vy[eid] ?? 0;
  }

  /** Launch upward at `speed` if grounded. Returns whether the jump happened. */
  jump(eid: Entity, speed: number): boolean {
    const ch = this.physics.entities.store(Character);
    if ((ch.grounded[eid] ?? 0) === 0) return false;
    ch.vy[eid] = speed;
    ch.grounded[eid] = 0;
    return true;
  }

  /**
   * Resolve `desired` (this tick's wanted displacement, world units) plus
   * gravity against the world and apply the result to the entity's Transform.
   * Call from a fixed-stage system with order < 90 or from `scene.fixedUpdate`.
   */
  move(eid: Entity, desired: Vec3Like, dt: number): void {
    this.assertLive();
    if (!this.attached.has(eid)) throw new Error(`CharacterController.move: entity ${eid} is not attached`);
    const collider = this.physics.rawCollider(eid);
    if (!collider) return;
    const entities = this.physics.entities;
    const t = entities.store(Transform);
    const ch = entities.store(Character);

    // Vertical: integrate gravity; a grounded character carries no downward velocity.
    let vy = ch.vy[eid] ?? 0;
    if ((ch.grounded[eid] ?? 0) !== 0 && vy < 0) vy = 0;
    vy += this.gravity * dt;
    if (vy < -this.maxFallSpeed) vy = -this.maxFallSpeed;

    _desired.x = desired.x;
    _desired.y = desired.y + vy * dt;
    _desired.z = desired.z;

    this.controller.computeColliderMovement(
      collider,
      _desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      collider.collisionGroups(),
    );
    const moved = this.controller.computedMovement(_moved);
    const grounded = this.controller.computedGrounded();

    _next.x = (t.x[eid] ?? 0) + moved.x;
    _next.y = (t.y[eid] ?? 0) + moved.y;
    _next.z = (t.z[eid] ?? 0) + moved.z;
    t.x[eid] = _next.x;
    t.y[eid] = _next.y;
    t.z[eid] = _next.z;

    // Hitting a ceiling kills upward velocity; landing kills downward velocity.
    if (vy > 0 && moved.y < _desired.y - 1e-4) vy = 0;
    if (grounded && vy < 0) vy = 0;
    ch.vy[eid] = vy;
    ch.grounded[eid] = grounded ? 1 : 0;
  }

  /** Number of obstacle collisions in the last `move()`. Debug/gameplay hook. */
  lastCollisionCount(): number {
    return this.controller.numComputedCollisions();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('CharacterController: disposed');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const eid of [...this.attached]) this.detach(eid);
    this.physics.raw.removeCharacterController(this.controller);
  }
}
