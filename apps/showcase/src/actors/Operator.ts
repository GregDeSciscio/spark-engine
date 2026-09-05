import * as THREE from 'three/webgpu';
import {
  CharacterController,
  Character,
  Transform,
  type AnimationGraphDef,
  type AnimationWorld,
  type Entity,
  type EntityWorld,
  type Input,
  type ModelAsset,
  type PhysicsWorld,
  type RenderSync,
  type ShoulderCamera,
} from '@spark/engine';
import type { HitZone } from '../combat/weapons';

/**
 * The player character: a kinematic capsule on the engine's character
 * controller, a skinned visual, three stances, sprint and jump. Movement is
 * camera-relative and the body always faces where the camera looks, the way an
 * over-the-shoulder shooter does. Tuning numbers are Task Unit's
 * (`docs/design/task-unit-reference.md`): 5 u/s, sprint 1.6x, 0.4 by 1.8
 * capsule, gravity -20, jump 8.
 *
 * Frame input is read in `update()`; motion is applied in `fixedUpdate()` so
 * the simulation stays deterministic under the fixed step.
 */

export type Stance = 'stand' | 'crouch' | 'prone';

export const OPERATOR = {
  radius: 0.4,
  height: 1.8,
  moveSpeed: 5,
  sprintMultiplier: 1.6,
  crouchMultiplier: 0.5,
  proneMultiplier: 0.22,
  aimMultiplier: 0.6,
  jumpSpeed: 8,
  gravity: -20,
  accel: 30,
  stanceHeight: { stand: 1.8, crouch: 1.25, prone: 0.6 } as const satisfies Record<Stance, number>,
} as const;

const WALK_ANIM = 1.2;
const RUN_ANIM = 4.0;

/** idle/walk/run on horizontal speed; hit/death by trigger. Root motion off: the controller owns the transform. */
const OPERATOR_GRAPH: AnimationGraphDef = {
  params: { speed: 0, dead: 0 },
  layers: [
    {
      name: 'base',
      entry: 'locomotion',
      states: [
        {
          name: 'locomotion',
          blend: {
            param: 'speed',
            points: [
              { clip: 'idle', threshold: 0 },
              { clip: 'walk', threshold: WALK_ANIM },
              { clip: 'run', threshold: RUN_ANIM },
            ],
          },
        },
        { name: 'hit', clip: 'hit', transitions: [{ to: 'locomotion', exitTime: 1, duration: 0.15 }] },
        { name: 'death', clip: 'death', transitions: [{ to: 'locomotion', conditions: [{ trigger: 'respawn' }], duration: 0.3 }] },
      ],
      anyState: [
        { to: 'death', conditions: [{ trigger: 'die' }], duration: 0.1 },
        { to: 'hit', conditions: [{ trigger: 'hit' }, { param: 'dead', op: '==', value: 0 }], duration: 0.08, allowSelf: true },
      ],
    },
  ],
};

export interface OperatorDeps {
  readonly entities: EntityWorld;
  readonly physics: PhysicsWorld;
  readonly animation: AnimationWorld;
  readonly renderSync: RenderSync;
  readonly scene: THREE.Scene;
  readonly model: ModelAsset;
}

export const OPERATOR_MAX_HEALTH = 100;

export class Operator {
  readonly eid: Entity;
  /** Where shots leave the barrel, in world space via `getWorldPosition`. */
  readonly muzzle: THREE.Object3D;
  stance: Stance = 'stand';
  aiming = false;
  sprinting = false;
  health = OPERATOR_MAX_HEALTH;
  dead = false;
  /** 0..1 how lit the operator is this tick, from the lighting query. Written by the scene. */
  lit = 1;
  /** Set when damage lands this tick, cleared by whoever reads it (the HUD flash). */
  lastHitAt = -100;

  private readonly deps: OperatorDeps;
  private readonly controller: CharacterController;
  private readonly root: THREE.Group;
  private readonly wish = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly step = { x: 0, y: 0, z: 0 };
  private readonly tmpF = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();
  private facing = 0;
  private jumpQueued = false;
  private readonly rifleParts: readonly { dispose(): void }[];

  constructor(deps: OperatorDeps, spawn: THREE.Vector3, yaw: number) {
    this.deps = deps;
    const { entities, physics, animation, renderSync, scene, model } = deps;
    const halfHeight = OPERATOR.height / 2 - OPERATOR.radius;
    const centerY = spawn.y + OPERATOR.height / 2;
    this.facing = yaw + Math.PI;
    this.eid = entities.create([Transform, { x: spawn.x, y: centerY, z: spawn.z, qy: Math.sin(this.facing / 2), qw: Math.cos(this.facing / 2) }], Character);
    physics.addBody(this.eid, {
      type: 'kinematicPosition',
      shape: { kind: 'capsule', halfHeight, radius: OPERATOR.radius },
      layer: 'player',
      collidesWith: ['world', 'enemy'],
    });
    this.controller = new CharacterController(physics, { stepHeight: 0.4, snapToGround: 0.3, characterMass: 80, gravity: OPERATOR.gravity });
    this.controller.attach(this.eid);

    // The entity transform is the capsule centre; the skinned mesh stands on its feet below it.
    this.root = new THREE.Group();
    const visual = model.instantiate({ castShadow: true, receiveShadow: true });
    visual.position.y = -OPERATOR.height / 2;
    this.root.add(visual);
    scene.add(this.root);
    renderSync.attach(entities, this.eid, this.root);
    animation.attach(this.eid, visual, model.animations, OPERATOR_GRAPH, { rootMotion: { mode: 'none' } });

    // A placeholder rifle on the right forearm, until a real weapon model and aim pose exist.
    const rifle = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.06), new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.5, metalness: 0.6 }));
    body.position.y = 0.42;
    body.castShadow = true;
    rifle.add(body);
    this.rifleParts = [body.geometry, body.material as THREE.Material];
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.y = 0.76;
    rifle.add(this.muzzle);
    const hand = visual.getObjectByName('lowerArm_R');
    if (hand) hand.add(rifle);
    else {
      rifle.position.set(0.3, 1.3, 0.4);
      this.root.add(rifle);
    }
  }

  /** Current stance height, for the camera pivot. */
  get height(): number {
    return OPERATOR.stanceHeight[this.stance];
  }

  /** Feet position in world space. */
  feet(out: THREE.Vector3): THREE.Vector3 {
    const t = this.deps.entities.store(Transform);
    return out.set(t.x[this.eid] ?? 0, (t.y[this.eid] ?? 0) - OPERATOR.height / 2, t.z[this.eid] ?? 0);
  }

  get grounded(): boolean {
    return this.controller.isGrounded(this.eid);
  }

  /** Horizontal speed this tick. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Damage from an enemy. Returns true when this killed the operator. */
  takeDamage(damage: number, zone: HitZone, now: number): boolean {
    if (this.dead) return false;
    this.health = Math.max(0, this.health - damage);
    this.lastHitAt = now;
    if (this.health === 0) {
      this.dead = true;
      this.stance = 'stand';
      this.aiming = false;
      this.deps.animation.setParam(this.eid, 'dead', 1);
      this.deps.animation.setTrigger(this.eid, 'die');
      return true;
    }
    this.deps.animation.setTrigger(this.eid, 'hit');
    void zone;
    return false;
  }

  /** Back to a spawn with full health: a checkpoint reload. */
  respawn(spawn: THREE.Vector3, yaw: number): void {
    const { entities, physics, animation } = this.deps;
    const centerY = spawn.y + OPERATOR.height / 2;
    const t = entities.store(Transform);
    t.x[this.eid] = spawn.x;
    t.y[this.eid] = centerY;
    t.z[this.eid] = spawn.z;
    physics.setPose(this.eid, { x: spawn.x, y: centerY, z: spawn.z });
    entities.store(Character).vy[this.eid] = 0;
    this.velocity.set(0, 0, 0);
    this.wish.set(0, 0, 0);
    this.facing = yaw + Math.PI;
    this.health = OPERATOR_MAX_HEALTH;
    this.stance = 'stand';
    if (this.dead) {
      this.dead = false;
      animation.setParam(this.eid, 'dead', 0);
      animation.setTrigger(this.eid, 'respawn');
    }
  }

  /** Read this frame's input. Pressed-edge queries are per frame, so this must not run inside the fixed step. */
  update(input: Input, camera: ShoulderCamera): void {
    if (this.dead) {
      this.wish.set(0, 0, 0);
      this.sprinting = false;
      this.aiming = false;
      return;
    }
    if (input.wasPressed('KeyC')) this.stance = this.stance === 'crouch' ? 'stand' : 'crouch';
    if (input.wasPressed('KeyX')) this.stance = this.stance === 'prone' ? 'stand' : 'prone';
    if (input.wasPressed('Space') && this.stance === 'stand') this.jumpQueued = true;
    this.aiming = input.isButtonDown(2);
    const forward = input.axis('KeyS', 'KeyW');
    const strafe = input.axis('KeyA', 'KeyD');
    this.sprinting = input.isDown('ShiftLeft') && forward > 0 && this.stance === 'stand' && !this.aiming;

    camera.groundForward(this.tmpF);
    camera.groundRight(this.tmpR);
    this.wish.set(0, 0, 0).addScaledVector(this.tmpF, forward).addScaledVector(this.tmpR, strafe);
    if (this.wish.lengthSq() > 1) this.wish.normalize();
    // Face where the camera looks. The mannequin's forward is +Z at yaw 0, the camera's is -Z.
    this.facing = camera.getYaw() + Math.PI;
  }

  fixedUpdate(dt: number): void {
    const { entities, animation } = this.deps;
    let speed = OPERATOR.moveSpeed;
    if (this.stance === 'crouch') speed *= OPERATOR.crouchMultiplier;
    else if (this.stance === 'prone') speed *= OPERATOR.proneMultiplier;
    else if (this.sprinting) speed *= OPERATOR.sprintMultiplier;
    if (this.aiming) speed *= OPERATOR.aimMultiplier;

    // Accelerate toward the wish velocity so starts and stops read as weight, not a switch.
    const targetX = this.wish.x * speed;
    const targetZ = this.wish.z * speed;
    const k = Math.min(1, OPERATOR.accel * dt);
    this.velocity.x += (targetX - this.velocity.x) * k;
    this.velocity.z += (targetZ - this.velocity.z) * k;

    if (this.jumpQueued) {
      this.controller.jump(this.eid, OPERATOR.jumpSpeed);
      this.jumpQueued = false;
    }
    this.step.x = this.velocity.x * dt;
    this.step.y = 0;
    this.step.z = this.velocity.z * dt;
    this.controller.move(this.eid, this.step, dt);

    const t = entities.store(Transform);
    t.qx[this.eid] = 0;
    t.qz[this.eid] = 0;
    t.qy[this.eid] = Math.sin(this.facing / 2);
    t.qw[this.eid] = Math.cos(this.facing / 2);

    animation.setParam(this.eid, 'speed', this.speed);
  }

  dispose(): void {
    const { entities, animation, scene } = this.deps;
    animation.detach(this.eid);
    this.controller.detach(this.eid);
    this.controller.dispose();
    for (const part of this.rifleParts) part.dispose();
    scene.remove(this.root);
    entities.destroy(this.eid);
  }
}
