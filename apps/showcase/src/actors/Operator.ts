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
import { RIFLE_BASELINE, type HitZone } from '../combat/weapons';
import { RifleProp } from './RifleProp';
import type { MissionAudio } from '../audio/MissionAudio';
import { AIM_PITCH_RANGE, BONES, LOCOMOTION, UPPER_BODY_MASK, findBone, tintCharacter } from './rig';

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

const UP = new THREE.Vector3(0, 1, 0);
/** Seconds the upper-body layer takes to fade in or out. */
const UPPER_FADE_SECONDS = 0.12;
/** The controller's grounded flag flickers on flat ground while moving; only this long in the air counts. */
const AIRBORNE_SECONDS = 0.12;
const RELOAD_CLIP_SECONDS = 1.67;
/** Operator colours: dark grey kit, deep-teal jacket panels with a faint glow. */
const OPERATOR_MAIN = 0x2a2d33;
const OPERATOR_ACCENT = 0x1f4a55;

/**
 * Base layer: stand / crouch locomotion on horizontal speed, an airborne
 * loop, death by trigger. Layer 1 overrides the upper body with the
 * weapon-ready pose, or the aim poses blended on view pitch while aiming;
 * layer 2 adds the hit flinch. Root motion off: the controller owns the
 * transform.
 */
const OPERATOR_GRAPH: AnimationGraphDef = {
  params: { speed: 0, dead: 0, crouch: 0, air: 0, aim: 0, pitch: 0, reload: 0 },
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
              { clip: 'walk', threshold: LOCOMOTION.walk },
              { clip: 'run', threshold: LOCOMOTION.run },
              { clip: 'sprint', threshold: LOCOMOTION.sprint },
            ],
          },
          transitions: [
            { to: 'crouch', conditions: [{ param: 'crouch', op: '==', value: 1 }], duration: 0.2 },
            { to: 'air', conditions: [{ param: 'air', op: '==', value: 1 }], duration: 0.1 },
          ],
        },
        {
          name: 'crouch',
          blend: {
            param: 'speed',
            points: [
              { clip: 'crouch_idle', threshold: 0 },
              { clip: 'crouch_walk', threshold: LOCOMOTION.crouchWalk },
            ],
          },
          transitions: [{ to: 'locomotion', conditions: [{ param: 'crouch', op: '==', value: 0 }], duration: 0.2 }],
        },
        { name: 'air', clip: 'jump', transitions: [{ to: 'locomotion', conditions: [{ param: 'air', op: '==', value: 0 }], duration: 0.15 }] },
        { name: 'death', clip: 'death', transitions: [{ to: 'locomotion', conditions: [{ trigger: 'respawn' }], duration: 0.3 }] },
      ],
      anyState: [{ to: 'death', conditions: [{ trigger: 'die' }], duration: 0.1 }],
    },
    {
      name: 'upper',
      entry: 'ready',
      additive: false,
      mask: UPPER_BODY_MASK,
      states: [
        { name: 'ready', clip: 'ready', transitions: [{ to: 'aim', conditions: [{ param: 'aim', op: '==', value: 1 }], duration: 0.12 }] },
        {
          name: 'aim',
          blend: {
            param: 'pitch',
            points: [
              { clip: 'aim_up', threshold: -AIM_PITCH_RANGE },
              { clip: 'aim', threshold: 0 },
              { clip: 'aim_down', threshold: AIM_PITCH_RANGE },
            ],
          },
          transitions: [{ to: 'ready', conditions: [{ param: 'aim', op: '==', value: 0 }], duration: 0.15 }],
        },
        // The clip is 1.67 s; slowed to fill the rifle's 2.5 s reload (combat/weapons.ts).
        { name: 'reload', clip: 'reload', speed: RELOAD_CLIP_SECONDS / RIFLE_BASELINE.reloadTime, transitions: [{ to: 'ready', conditions: [{ param: 'reload', op: '==', value: 0 }], duration: 0.15 }] },
      ],
      anyState: [{ to: 'reload', conditions: [{ param: 'reload', op: '==', value: 1 }], duration: 0.1 }],
    },
    {
      // Hit reactions ride on top of everything as a delta from the clip's first
      // frame, so a flinch never pulls a crouched or aiming body out of its pose.
      name: 'flinch',
      entry: 'none',
      states: [{ name: 'none' }, { name: 'hit', clip: 'hit', transitions: [{ to: 'none', exitTime: 1, duration: 0.1 }] }],
      anyState: [{ to: 'hit', conditions: [{ trigger: 'hit' }, { param: 'dead', op: '==', value: 0 }], duration: 0.05, allowSelf: true }],
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
  /** The mission's cue set; optional so probes and tests can build a silent operator. */
  readonly sfx?: MissionAudio | undefined;
}

export const OPERATOR_MAX_HEALTH = 100;

export class Operator {
  readonly eid: Entity;
  /** Where shots leave the barrel, in world space via `getWorldPosition`. */
  readonly muzzle: THREE.Object3D;
  stance: Stance = 'stand';
  aiming = false;
  sprinting = false;
  /** Set by the scene from the weapon each frame; drives the reload clip on the upper body. */
  reloading = false;
  health = OPERATOR_MAX_HEALTH;
  dead = false;
  /**
   * Rounds pass through. A test seam for the probe suite (`tools/probes`): a
   * probe about objective volumes and checkpoints should not also have to win
   * a firefight to reach the marker. Never set by the game.
   */
  invulnerable = false;
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
  private readonly rifle: RifleProp;
  private readonly visual: THREE.Object3D;
  private readonly materials: readonly THREE.Material[];
  /** Target weight of the upper-body layer; the animation world fades to it. */
  private upperTarget = 1;
  private pitch = 0;
  private wasAirborne = false;
  /** Scripted movement for probes (`window.__spark.game.move`): replaces the WASD axes while set. */
  autoMove: { forward: number; strafe: number } | null = null;
  /** Height of the current collider; the entity transform sits at half of it. */
  private bodyHeight: number = OPERATOR.height;
  private readonly feetScratch = new THREE.Vector3();

  constructor(deps: OperatorDeps, spawn: THREE.Vector3, yaw: number) {
    this.deps = deps;
    const { entities, physics, animation, renderSync, scene, model } = deps;
    const centerY = spawn.y + OPERATOR.height / 2;
    this.facing = yaw + Math.PI;
    this.eid = entities.create([Transform, { x: spawn.x, y: centerY, z: spawn.z, qy: Math.sin(this.facing / 2), qw: Math.cos(this.facing / 2) }], Character);
    this.addBody(OPERATOR.height);
    this.controller = new CharacterController(physics, { stepHeight: 0.4, snapToGround: 0.3, characterMass: 80, gravity: OPERATOR.gravity });
    this.controller.attach(this.eid);

    // The entity transform is the capsule centre; the skinned mesh stands on its feet below it.
    this.root = new THREE.Group();
    const visual = model.instantiate({ castShadow: true, receiveShadow: true });
    this.visual = visual;
    this.materials = tintCharacter(visual, OPERATOR_MAIN, OPERATOR_ACCENT, 0.08);
    visual.position.y = -this.bodyHeight / 2;
    this.root.add(visual);
    scene.add(this.root);
    renderSync.attach(entities, this.eid, this.root);
    animation.attach(this.eid, visual, model.animations, OPERATOR_GRAPH, { rootMotion: { mode: 'none' } });

    // The rifle rides in the right hand and points where the camera looks (the
    // body already faces the camera yaw; pitch is applied per frame).
    this.rifle = new RifleProp(this.root, findBone(visual, BONES.weapon), new THREE.Vector3(0.26, 1.32 - this.bodyHeight / 2, 0.12));
    this.muzzle = this.rifle.muzzle;
  }

  /** Capsule dimensions for a stance height. Prone is short enough to need a thinner radius. */
  private static capsuleFor(height: number): { halfHeight: number; radius: number } {
    const radius = Math.min(OPERATOR.radius, height / 2 - 0.02);
    return { halfHeight: Math.max(0.01, height / 2 - radius), radius };
  }

  private addBody(height: number): void {
    const { halfHeight, radius } = Operator.capsuleFor(height);
    this.deps.physics.addBody(this.eid, {
      type: 'kinematicPosition',
      shape: { kind: 'capsule', halfHeight, radius },
      layer: 'player',
      collidesWith: ['world', 'enemy'],
    });
    this.bodyHeight = height;
  }

  /** Resize the capsule to a stance height in place, keeping the feet where they are. */
  private resizeBody(height: number): void {
    const { entities, physics } = this.deps;
    this.feet(this.feetScratch);
    const { halfHeight, radius } = Operator.capsuleFor(height);
    physics.setCapsule(this.eid, halfHeight, radius);
    const t = entities.store(Transform);
    t.y[this.eid] = this.feetScratch.y + height / 2;
    physics.setPose(this.eid, { x: t.x[this.eid] ?? 0, y: t.y[this.eid] ?? 0, z: t.z[this.eid] ?? 0 }, { x: 0, y: t.qy[this.eid] ?? 0, z: 0, w: t.qw[this.eid] ?? 1 });
    this.bodyHeight = height;
    this.visual.position.y = -height / 2;
  }

  /**
   * Change stance, rebuilding the collider to the stance height so crouching
   * and going prone really shrink the hitbox. Refused when standing up would
   * push into a ceiling.
   */
  setStance(next: Stance): boolean {
    if (next === this.stance) return true;
    const { physics } = this.deps;
    const height = OPERATOR.stanceHeight[next];
    this.feet(this.feetScratch);
    if (height > this.bodyHeight) {
      this.tmpF.set(this.feetScratch.x, this.feetScratch.y + this.bodyHeight - 0.05, this.feetScratch.z);
      const above = physics.raycast(this.tmpF, UP, height - this.bodyHeight + 0.05, { layers: 'world' });
      if (above) return false;
    }
    this.resizeBody(height);
    this.stance = next;
    this.deps.sfx?.gear(this.eid);
    return true;
  }

  /** Current stance height, for the camera pivot. */
  get height(): number {
    return OPERATOR.stanceHeight[this.stance];
  }

  /** Feet position in world space. */
  feet(out: THREE.Vector3): THREE.Vector3 {
    const t = this.deps.entities.store(Transform);
    return out.set(t.x[this.eid] ?? 0, (t.y[this.eid] ?? 0) - this.bodyHeight / 2, t.z[this.eid] ?? 0);
  }

  /** Height of the current collider (the stance height once the stance change went through). */
  get colliderHeight(): number {
    return this.bodyHeight;
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
    if (this.dead || this.invulnerable) return false;
    this.health = Math.max(0, this.health - damage);
    this.lastHitAt = now;
    if (this.health === 0) {
      this.dead = true;
      this.aiming = false;
      this.deps.animation.setParam(this.eid, 'dead', 1);
      this.deps.animation.setTrigger(this.eid, 'die');
      this.deps.sfx?.playerDeath();
      return true;
    }
    this.deps.animation.setTrigger(this.eid, 'hit');
    this.deps.sfx?.hurt();
    void zone;
    return false;
  }

  /** Back to a spawn with full health: a checkpoint reload. */
  respawn(spawn: THREE.Vector3, yaw: number): void {
    const { entities, physics, animation } = this.deps;
    if (this.bodyHeight !== OPERATOR.height) this.resizeBody(OPERATOR.height);
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
  update(input: Input, camera: ShoulderCamera, now: number, dt: number): void {
    if (this.dead) {
      this.wish.set(0, 0, 0);
      this.sprinting = false;
      this.aiming = false;
      this.fadeUpper(0);
      this.rifle.update(0);
      return;
    }
    if (input.wasPressed('KeyC')) this.setStance(this.stance === 'crouch' ? 'stand' : 'crouch');
    if (input.wasPressed('KeyX')) this.setStance(this.stance === 'prone' ? 'stand' : 'prone');
    if (input.wasPressed('Space') && this.stance === 'stand') this.jumpQueued = true;
    const wasAiming = this.aiming;
    this.aiming = input.isButtonDown(2);
    if (this.aiming !== wasAiming) this.deps.sfx?.aim(this.aiming);
    const forward = this.autoMove ? this.autoMove.forward : input.axis('KeyS', 'KeyW');
    const strafe = this.autoMove ? this.autoMove.strafe : input.axis('KeyA', 'KeyD');
    this.sprinting = input.isDown('ShiftLeft') && forward > 0 && this.stance === 'stand' && !this.aiming;

    camera.groundForward(this.tmpF);
    camera.groundRight(this.tmpR);
    this.wish.set(0, 0, 0).addScaledVector(this.tmpF, forward).addScaledVector(this.tmpR, strafe);
    if (this.wish.lengthSq() > 1) this.wish.normalize();
    // Face where the camera looks. The mannequin's forward is +Z at yaw 0, the camera's is -Z.
    this.facing = camera.getYaw() + Math.PI;
    // The rifle's +Z is the body's forward; tilt it to the view pitch (positive looks down).
    this.pitch = camera.effectivePitch();
    this.rifle.update(this.pitch);
    // The upper-body layer stands down while sprinting so the arms pump.
    this.fadeUpper(this.sprinting ? 0 : 1);
    void now;
    void dt;
  }

  private fadeUpper(target: number): void {
    if (target === this.upperTarget) return;
    this.upperTarget = target;
    this.deps.animation.setLayerWeight(this.eid, 1, target, UPPER_FADE_SECONDS);
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

    const airborne = this.controller.airborneSeconds(this.eid) > AIRBORNE_SECONDS;
    if (this.wasAirborne && !airborne && this.grounded) this.deps.sfx?.footstep(this.eid, 'land');
    this.wasAirborne = airborne;
    animation.setParam(this.eid, 'speed', this.speed);
    animation.setParam(this.eid, 'crouch', this.stance === 'stand' ? 0 : 1);
    animation.setParam(this.eid, 'air', airborne ? 1 : 0);
    animation.setParam(this.eid, 'aim', this.aiming ? 1 : 0);
    animation.setParam(this.eid, 'reload', this.reloading ? 1 : 0);
    animation.setParam(this.eid, 'pitch', THREE.MathUtils.radToDeg(this.pitch));
  }

  dispose(): void {
    const { entities, animation, scene } = this.deps;
    animation.detach(this.eid);
    this.controller.detach(this.eid);
    this.controller.dispose();
    this.rifle.dispose();
    for (const m of this.materials) m.dispose();
    scene.remove(this.root);
    entities.destroy(this.eid);
  }
}
