import * as THREE from 'three/webgpu';
import {
  CharacterController,
  Character,
  NavAgent,
  Transform,
  findCover,
  inViewCone,
  lineOfSight,
  peekPoint,
  type AnimationGraphDef,
  type AnimationWorld,
  type AudioSystem,
  type Entity,
  type ModelAsset,
  type Navigation,
  type PhysicsWorld,
  type RagdollWorld,
  type Random,
  type RenderSync,
  type WorldLabels,
} from '@spark/engine';
import { AWARENESS, sightGain, type AwarenessState } from '../ai/Awareness';
import type { Damageable, Impact } from '../combat/Damageable';
import type { Gore } from '../combat/gore';
import { MuzzleFlash, type EffectsDeps, type Impacts } from '../combat/effects';
import { Weapon } from '../combat/Weapon';
import { RIFLE_BASELINE, applySpread, damageAt, hitZoneAt, type HitZone, type WeaponDefinition } from '../combat/weapons';
import { RifleProp } from './RifleProp';
import type { MissionAudio } from '../audio/MissionAudio';
import { AIM_PITCH_RANGE, BONES, CHARACTER_RAGDOLL, LOCOMOTION, UPPER_BODY_MASK, findBone, tintCharacter } from './rig';
import { OPERATOR, type Stance } from './Operator';

/**
 * The first enemy: a rifleman on the navmesh with the awareness ladder from
 * `docs/design/mission-shape.md`. Unaware enemies patrol their route;
 * suspicion sends them to investigate; alert enemies stand and shoot; losing
 * the player sends them to search the last known position before giving up.
 * Everything runs in the fixed step off the seeded stream, so a given seed
 * and input replay the same fight.
 *
 * Perception is sight (distance, cone, line of sight, target stance and
 * motion) and sound (gunshots, via `hear`). "How lit is the target" waits on
 * the lighting query ADR-005 asks for.
 */

/** What the enemy needs to know about the player. */
export interface OperatorView {
  readonly eid: Entity;
  readonly dead: boolean;
  readonly stance: Stance;
  readonly speed: number;
  /** 0..1 how lit the operator is. */
  readonly lit: number;
  /** Height of the operator's current collider: stance shrinks it, and enemies aim and look accordingly. */
  readonly colliderHeight: number;
  feet(out: THREE.Vector3): THREE.Vector3;
  /** Apply damage. Returns true when it killed the operator. */
  takeDamage(damage: number, zone: HitZone, now: number): boolean;
}

export interface EnemySpec {
  readonly name: string;
  /** Patrol loop, feet positions. The first point is the spawn. */
  readonly route: readonly THREE.Vector3[];
}

export interface EnemyDeps extends EffectsDeps {
  readonly physics: PhysicsWorld;
  readonly animation: AnimationWorld;
  readonly renderSync: RenderSync;
  readonly model: ModelAsset;
  readonly labels: WorldLabels;
  readonly navigation: Navigation;
  readonly random: Random;
  readonly audio: AudioSystem;
  readonly impacts: Impacts;
  readonly sfx: MissionAudio;
  readonly ragdolls: RagdollWorld;
  readonly gore: Gore;
}

/** Same gun as the player, throttled: slower cadence, lighter hits, so a fair fight lasts more than a second. */
export const ENEMY_RIFLE: WeaponDefinition = { ...RIFLE_BASELINE, id: 'rifle_enemy', rpm: 420, damage: 14, reserveAmmo: 9999 };

const MAX_HEALTH = 100;
const PATROL_SPEED = 1.8;
const INVESTIGATE_SPEED = 3.2;
const CHASE_SPEED = 4.2;
const ENGAGE_RANGE = 32;
const EYE_HEIGHT = 1.6;
const CHEST_HEIGHT = 1.2;
const TURN_RATE = 8;
const REPATH_SECONDS = 0.8;
const PATROL_WAIT = 2;
/** Cone half-angle the bot fires into; opens up while moving or newly alert. */
const BOT_SPREAD_DEG = 1.6;
const BOT_SPREAD_UNSETTLED_DEG = 4.5;
/** Seconds after going alert before the first burst: the tell the player gets. */
const REACTION_SECONDS = 0.45;
/** Cover search: candidates sampled on the navmesh within this radius of the enemy. */
const COVER_SEARCH_RADIUS = 7;
const COVER_SAMPLES = 14;
/** A cover point must keep this much distance from the player, and not be absurdly far. */
const COVER_MIN_PLAYER_DIST = 5;
const COVER_MAX_PLAYER_DIST = 30;
/** Re-pick cover after this long, or when the player has moved this far since it was chosen. */
const COVER_REFRESH_SECONDS = 6;
const COVER_STALE_PLAYER_MOVE = 8;
/** Cover is abandoned when the player gets this close to it. */
const COVER_ABANDON_DIST = 4;
const COVER_ARRIVE = 0.6;
/** Peeking: step this far sideways out of cover, for a beat, then back. */
const PEEK_OFFSET = 1.1;
const PEEK_WAIT: readonly [number, number] = [0.8, 1.8];
const PEEK_SECONDS: readonly [number, number] = [1.0, 1.8];

/** Impulse (kg·m/s) a killing round puts into the nearest ragdoll part: a real shove on a 20 kg chest, capped by the engine on light limbs. */
const KILL_IMPULSE = 90;
const BASE_TINT = 0x3a1f2a;
const BLOOD_TINT = 0x2a0408;
const ACCENT_TINT = 0x6e1624;
/** An enemy round passing within this of the operator's head is heard as a whiz. */
const WHIZ_DISTANCE = 2.0;

/**
 * Base layer: locomotion on speed, a crouch while holding cover, death by
 * trigger. Layer 1 overrides the upper body with the weapon-ready pose, or
 * the aim poses on pitch toward the player while engaging; layer 2 adds the
 * hit flinch.
 */
const ENEMY_GRAPH: AnimationGraphDef = {
  params: { speed: 0, dead: 0, crouch: 0, aim: 0, pitch: 0 },
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
            ],
          },
          transitions: [{ to: 'crouch', conditions: [{ param: 'crouch', op: '==', value: 1 }], duration: 0.2 }],
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
        { name: 'ready', clip: 'ready', transitions: [{ to: 'aim', conditions: [{ param: 'aim', op: '==', value: 1 }], duration: 0.15 }] },
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
          transitions: [{ to: 'ready', conditions: [{ param: 'aim', op: '==', value: 0 }], duration: 0.2 }],
        },
      ],
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

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export class Enemy implements Damageable {
  readonly eid: Entity;
  readonly name: string;
  state: AwarenessState = 'unaware';
  awareness = 0;
  health = MAX_HEALTH;
  dead = false;

  private readonly deps: EnemyDeps;
  private readonly spec: EnemySpec;
  private readonly controller: CharacterController;
  private readonly root: THREE.Group;
  private readonly visual: THREE.Object3D;
  private readonly tinted: THREE.MeshStandardMaterial[];
  private readonly rifle: RifleProp;
  private animated = true;
  private upperTarget = 1;
  private bodyFallHeard = false;
  private aimPitch = 0;
  private aiming = false;
  private readonly nav: NavAgent;
  private readonly weapon = new Weapon(ENEMY_RIFLE);
  private readonly flash: MuzzleFlash;

  private facing: number;
  private routeIndex = 0;
  private waitUntil = 0;
  private lastSeenAt = -100;
  private alertSince = -100;
  private lookUntil = -1;
  private burstUntil = -1;
  private nextBurstAt = 0;
  private readonly cover = new THREE.Vector3();
  private hasCover = false;
  private inCover = false;
  private peeking = false;
  private coverChosenAt = -100;
  private readonly coverPlayerPos = new THREE.Vector3();
  private readonly peekPoint = new THREE.Vector3();
  private peekAt = 0;
  private peekUntil = 0;
  private readonly playerEye = new THREE.Vector3();
  private readonly lastKnown = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly step = { x: 0, y: 0, z: 0 };
  private readonly steer = { x: 0, y: 0, z: 0 };
  private readonly feetPos = new THREE.Vector3();
  private readonly playerFeet = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly toPlayer = new THREE.Vector3();
  private readonly shotDir = new THREE.Vector3();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(deps: EnemyDeps, spec: EnemySpec) {
    this.deps = deps;
    this.spec = spec;
    this.name = spec.name;
    this.nav = new NavAgent(deps.navigation, { repathSeconds: REPATH_SECONDS, reachDistance: 0.4, arriveDistance: COVER_ARRIVE });
    const { entities, physics, animation, renderSync, scene, model, labels } = deps;
    const spawn = spec.route[0] ?? new THREE.Vector3();
    const next = spec.route[1] ?? spawn;
    this.facing = Math.atan2(next.x - spawn.x, next.z - spawn.z);
    this.eid = entities.create([Transform, { x: spawn.x, y: spawn.y + OPERATOR.height / 2, z: spawn.z, qy: Math.sin(this.facing / 2), qw: Math.cos(this.facing / 2) }], Character);
    this.addBody();
    this.controller = new CharacterController(physics, { stepHeight: 0.4, snapToGround: 0.3, characterMass: 80, gravity: OPERATOR.gravity });
    this.controller.attach(this.eid);

    this.root = new THREE.Group();
    const visual = model.instantiate({ castShadow: true, receiveShadow: true });
    this.visual = visual;
    visual.position.y = -OPERATOR.height / 2;
    // A darker tint so enemies read apart from the operator and the range dummies; it bloodies as health drops.
    this.tinted = tintCharacter(visual, BASE_TINT, ACCENT_TINT, 0.2);
    this.root.add(visual);
    scene.add(this.root);
    renderSync.attach(entities, this.eid, this.root);
    animation.attach(this.eid, visual, model.animations, ENEMY_GRAPH, { rootMotion: { mode: 'none' } });
    labels.attach(this.eid, { kind: 'healthbar', text: spec.name, offsetY: 2.05 });
    this.flash = new MuzzleFlash(deps, ENEMY_RIFLE.muzzle.flashColor, ENEMY_RIFLE.muzzle.flashIntensity);
    this.rifle = new RifleProp(this.root, findBone(visual, BONES.weapon), new THREE.Vector3(0.26, 1.32 - OPERATOR.height / 2, 0.12), 0x33363c);
  }

  private fadeUpper(target: number): void {
    if (target === this.upperTarget) return;
    this.upperTarget = target;
    this.deps.animation.setLayerWeight(this.eid, 1, target, 0.12);
  }

  /** A ragdoll part touched something: the first hips contact after a kill is the body landing. */
  onRagdollContact(now: number): void {
    if (this.bodyFallHeard) return;
    this.bodyFallHeard = true;
    this.feet(this.feetPos);
    const ragdoll = this.deps.ragdolls.get(this.eid);
    const at = ragdoll ? ragdoll.rootPosition({ x: 0, y: 0, z: 0 }) : { x: this.feetPos.x, y: this.feetPos.y + 0.2, z: this.feetPos.z };
    this.deps.sfx.playAt('body-fall', at, { spatial: { refDistance: 2.5, rolloff: 1.1, maxDistance: 45 } });
    void now;
  }

  /** Whether `eid` is one of this enemy's ragdoll bodies. */
  ownsRagdollPart(eid: Entity): boolean {
    return this.deps.ragdolls.get(this.eid)?.hasPart(eid) ?? false;
  }

  private applyTint(): void {
    const t = 1 - this.health / MAX_HEALTH;
    const base = new THREE.Color(BASE_TINT);
    const blood = new THREE.Color(BLOOD_TINT);
    for (const m of this.tinted) {
      if (/black/i.test(m.name)) continue;
      const accent = /joint|accent/i.test(m.name);
      m.color.lerpColors(accent ? m.emissive : base, blood, accent ? t * 0.5 : t * 0.85);
      if (accent) m.emissiveIntensity = 0.2 * (1 - t);
    }
  }

  /** The ragdoll owns the bones from here; the animator lets go so nothing fights it. */
  private startRagdoll(now: number, impact: Impact | undefined): void {
    const { ragdolls, animation, gore } = this.deps;
    const velocity = impact ? { x: impact.direction.x * 2.2, y: 0.6, z: impact.direction.z * 2.2 } : { x: 0, y: 0, z: 0 };
    const activation = impact
      ? { velocity, impulse: { point: { x: impact.point.x, y: impact.point.y, z: impact.point.z }, direction: { x: impact.direction.x, y: impact.direction.y, z: impact.direction.z }, strength: KILL_IMPULSE } }
      : { velocity };
    const ragdoll = ragdolls.create(this.eid, this.visual, { ...CHARACTER_RAGDOLL, contactEvents: true }, { blendSeconds: 0.12, activation });
    this.bodyFallHeard = false;
    if (this.animated) {
      animation.detach(this.eid);
      this.animated = false;
    }
    const hips = new THREE.Vector3();
    gore.corpse(() => {
      const p = ragdoll.rootPosition({ x: 0, y: 0, z: 0 });
      return hips.set(p.x, p.y, p.z);
    });
    void now;
  }

  /** Drop the ragdoll bodies; bones keep their last pose until the next reset re-animates them. */
  retireRagdoll(): void {
    this.deps.ragdolls.remove(this.eid);
  }

  private reanimate(): void {
    const { animation, model } = this.deps;
    if (this.animated) return;
    animation.attach(this.eid, this.visual, model.animations, ENEMY_GRAPH, { rootMotion: { mode: 'none' } });
    this.animated = true;
  }

  private addBody(): void {
    const halfHeight = OPERATOR.height / 2 - OPERATOR.radius;
    this.deps.physics.addBody(this.eid, {
      type: 'kinematicPosition',
      shape: { kind: 'capsule', halfHeight, radius: OPERATOR.radius },
      layer: 'enemy',
      collidesWith: ['world', 'player', 'enemy'],
    });
  }

  feet(out: THREE.Vector3): THREE.Vector3 {
    const t = this.deps.entities.store(Transform);
    return out.set(t.x[this.eid] ?? 0, (t.y[this.eid] ?? 0) - OPERATOR.height / 2, t.z[this.eid] ?? 0);
  }

  heightFraction(y: number): number {
    this.feet(this.feetPos);
    return (y - this.feetPos.y) / OPERATOR.height;
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Where the enemy stands in its cover cycle, for probes and the debug HUD. */
  coverState(): { hasCover: boolean; inCover: boolean; peeking: boolean; cover: [number, number, number] | null } {
    return { hasCover: this.hasCover, inCover: this.inCover, peeking: this.peeking, cover: this.hasCover ? [this.cover.x, this.cover.y, this.cover.z] : null };
  }

  hit(zone: HitZone, damage: number, now: number, impact?: Impact): boolean {
    if (this.dead) return false;
    const { animation, labels } = this.deps;
    this.health = Math.max(0, this.health - damage);
    labels.setValue(this.eid, this.health / MAX_HEALTH);
    this.applyTint();
    // Being shot is the loudest possible tell.
    this.becomeAlert(now);
    if (this.health === 0) {
      this.dead = true;
      this.controller.detach(this.eid);
      this.deps.physics.removeBody(this.eid);
      this.velocity.set(0, 0, 0);
      this.startRagdoll(now, impact);
      this.deps.sfx.bark(this.eid, 'death');
      return true;
    }
    animation.setTrigger(this.eid, 'hit');
    this.deps.sfx.bark(this.eid, 'hit');
    void zone;
    return false;
  }

  /** A sound reached this enemy: `position` is where, `loudness` how far it carries. */
  hear(position: THREE.Vector3, loudness: number, now: number): void {
    if (this.dead) return;
    this.feet(this.feetPos);
    const d = this.feetPos.distanceTo(position);
    if (d > loudness) return;
    if (d < loudness * AWARENESS.loudAlertFraction) {
      this.lastKnown.copy(position);
      this.becomeAlert(now);
      return;
    }
    if (this.state === 'unaware' || this.state === 'searching') {
      this.awareness = Math.max(this.awareness, AWARENESS.suspiciousAt + 0.15);
      this.investigate(position, now);
    } else if (this.state === 'suspicious') {
      this.lastKnown.copy(position);
      this.nav.clear();
      this.lookUntil = -1;
    }
  }

  /** Another enemy went alert nearby: go and look where they say the player is. */
  warn(position: THREE.Vector3, now: number): void {
    if (this.dead || this.state === 'alert') return;
    this.awareness = Math.max(this.awareness, AWARENESS.suspiciousAt + 0.3);
    this.investigate(position, now);
  }

  /** Back to the start of the route, full health, unaware: a checkpoint reload. */
  reset(): void {
    const { entities, physics, animation, labels } = this.deps;
    const spawn = this.spec.route[0] ?? new THREE.Vector3();
    const t = entities.store(Transform);
    if (this.dead) {
      this.dead = false;
      this.retireRagdoll();
      this.reanimate();
      this.addBody();
      this.controller.attach(this.eid);
      animation.setParam(this.eid, 'dead', 0);
      animation.setTrigger(this.eid, 'respawn');
    }
    this.applyTint();
    t.x[this.eid] = spawn.x;
    t.y[this.eid] = spawn.y + OPERATOR.height / 2;
    t.z[this.eid] = spawn.z;
    physics.setPose(this.eid, { x: spawn.x, y: spawn.y + OPERATOR.height / 2, z: spawn.z });
    const ch = entities.store(Character);
    ch.vy[this.eid] = 0;
    this.health = MAX_HEALTH;
    labels.setValue(this.eid, 1);
    this.applyTint();
    this.state = 'unaware';
    this.awareness = 0;
    this.routeIndex = 0;
    this.waitUntil = 0;
    this.nav.clear();
    this.lookUntil = -1;
    this.burstUntil = -1;
    this.lastSeenAt = -100;
    this.alertSince = -100;
    this.hasCover = false;
    this.inCover = false;
    this.peeking = false;
    this.velocity.set(0, 0, 0);
    this.nav.clear();
    this.weapon.ammo = ENEMY_RIFLE.magazineSize;
    this.aiming = false;
    this.aimPitch = 0;
  }

  fixedUpdate(dt: number, now: number, player: OperatorView, onAlert: (enemy: Enemy) => void): void {
    if (this.dead) {
      this.flash.fixedUpdate(now);
      // The rifle stays with the hand as the ragdoll settles.
      this.rifle.update(0);
      return;
    }
    const { animation, entities } = this.deps;
    this.feet(this.feetPos);
    player.feet(this.playerFeet);

    // ---- perception ----------------------------------------------------------
    const sample = this.sense(player);
    const gain = sightGain(sample);
    const wasAlert = this.state === 'alert';
    if (gain > 0) {
      this.awareness = Math.min(1, this.awareness + gain * dt);
      this.lastKnown.copy(this.playerFeet);
      this.lastSeenAt = now;
    } else if (this.state !== 'alert') {
      this.awareness = Math.max(0, this.awareness - AWARENESS.decayPerSecond * dt);
    }

    if (this.awareness >= 1 && !player.dead) this.becomeAlert(now);
    else if (this.state === 'unaware' && this.awareness >= AWARENESS.suspiciousAt) this.investigate(this.lastKnown, now);
    if (this.state === 'alert' && !wasAlert) onAlert(this);

    // ---- behaviour ------------------------------------------------------------
    let moveSpeed = 0;
    let faceTarget: THREE.Vector3 | null = null;
    let wantsMove = false;
    switch (this.state) {
      case 'unaware':
        moveSpeed = PATROL_SPEED;
        wantsMove = this.patrol(now);
        break;
      case 'suspicious':
        moveSpeed = INVESTIGATE_SPEED;
        wantsMove = this.goLook(now, AWARENESS.investigateLook);
        if (!wantsMove && this.lookUntil >= 0 && now >= this.lookUntil && this.awareness < AWARENESS.suspiciousAt) {
          this.state = 'unaware';
          this.lookUntil = -1;
          this.nav.clear();
        }
        break;
      case 'alert':
        if (player.dead) {
          this.state = 'searching';
          this.lookUntil = -1;
          break;
        }
        if (now - this.lastSeenAt > AWARENESS.loseAfter) {
          this.state = 'searching';
          this.lookUntil = -1;
          this.nav.clear();
          this.deps.sfx.bark(this.eid, 'search');
          break;
        }
        faceTarget = this.playerFeet;
        ({ moveSpeed, wantsMove } = this.engage(sample, player, now));
        break;
      case 'searching':
        moveSpeed = INVESTIGATE_SPEED;
        wantsMove = this.goLook(now, AWARENESS.searchLook);
        if (!wantsMove && this.lookUntil >= 0 && now >= this.lookUntil) {
          this.state = 'unaware';
          this.awareness = Math.min(this.awareness, AWARENESS.suspiciousAt - 0.05);
          this.lookUntil = -1;
          this.nav.clear();
        }
        break;
    }

    // ---- movement -------------------------------------------------------------
    const targetX = wantsMove ? this.steer.x * moveSpeed : 0;
    const targetZ = wantsMove ? this.steer.z * moveSpeed : 0;
    const k = Math.min(1, 14 * dt);
    this.velocity.x += (targetX - this.velocity.x) * k;
    this.velocity.z += (targetZ - this.velocity.z) * k;
    this.step.x = this.velocity.x * dt;
    this.step.y = 0;
    this.step.z = this.velocity.z * dt;
    this.controller.move(this.eid, this.step, dt);

    // ---- facing: the target if engaging, else the way we move, else a slow look-around ----
    let desired = this.facing;
    if (faceTarget) desired = Math.atan2(faceTarget.x - this.feetPos.x, faceTarget.z - this.feetPos.z);
    else if (this.speed > 0.3) desired = Math.atan2(this.velocity.x, this.velocity.z);
    else if (this.lookUntil >= 0) desired = this.facing + Math.sin(now * 1.7) * 0.02 + 0.9 * dt;
    this.facing = wrapAngle(this.facing + wrapAngle(desired - this.facing) * Math.min(1, TURN_RATE * dt));
    const t = entities.store(Transform);
    t.qx[this.eid] = 0;
    t.qz[this.eid] = 0;
    t.qy[this.eid] = Math.sin(this.facing / 2);
    t.qw[this.eid] = Math.cos(this.facing / 2);
    animation.setParam(this.eid, 'speed', this.speed);
    animation.setParam(this.eid, 'crouch', this.inCover && !this.peeking && this.speed < 0.3 ? 1 : 0);
    // Aim at the player while alert with a target; the pitch follows the line to their chest.
    this.aiming = this.state === 'alert' && now - this.lastSeenAt < 1.5;
    if (this.aiming) {
      this.tmpA.copy(this.playerFeet);
      this.tmpA.y += Math.min(CHEST_HEIGHT, player.colliderHeight * 0.65);
      const dx = this.tmpA.x - this.feetPos.x;
      const dz = this.tmpA.z - this.feetPos.z;
      this.aimPitch = Math.atan2(-(this.tmpA.y - (this.feetPos.y + EYE_HEIGHT)), Math.hypot(dx, dz));
    } else {
      this.aimPitch += (0 - this.aimPitch) * Math.min(1, 4 * dt);
    }
    animation.setParam(this.eid, 'aim', this.aiming ? 1 : 0);
    animation.setParam(this.eid, 'pitch', THREE.MathUtils.radToDeg(this.aimPitch));
    this.fadeUpper(1);
    this.rifle.update(this.aimPitch);
    this.flash.fixedUpdate(now);
  }

  // ---- perception helpers ------------------------------------------------------

  private sense(player: OperatorView): { visible: boolean; distance: number; inCone: boolean; stance: Stance; speed: number; lit: number } {
    this.toPlayer.copy(this.playerFeet).sub(this.feetPos);
    const distance = Math.hypot(this.toPlayer.x, this.toPlayer.z);
    if (player.dead || distance > AWARENESS.sightRange) return { visible: false, distance, inCone: false, stance: player.stance, speed: player.speed, lit: player.lit };
    this.tmpB.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    const inCone = inViewCone(this.tmpB, this.feetPos, this.playerFeet, THREE.MathUtils.degToRad(AWARENESS.fovDeg));
    // Line of sight from the eye to the centre of whatever the player currently is: chest standing, lower when crouched or prone.
    this.eye.copy(this.feetPos);
    this.eye.y += EYE_HEIGHT;
    this.tmpA.copy(this.playerFeet);
    this.tmpA.y += Math.min(CHEST_HEIGHT, player.colliderHeight * 0.65);
    const visible = lineOfSight(this.deps.physics, this.eye, this.tmpA, 'world', this.eid);
    return { visible, distance, inCone, stance: player.stance, speed: player.speed, lit: player.lit };
  }

  /**
   * Alert behaviour with the player seen recently: get to cover that blocks
   * the player's line of sight, fire while moving if the player is in view,
   * then hold cover and peek out sideways for bursts. Without usable cover,
   * or when the player closes in, stand and fight or chase the last known
   * position. Returns the movement intent for this tick.
   */
  private engage(sample: { visible: boolean; distance: number }, player: OperatorView, now: number): { moveSpeed: number; wantsMove: boolean } {
    const { random } = this.deps;
    const visible = sample.visible && sample.distance <= ENGAGE_RANGE;
    if (!this.hasCover || now - this.coverChosenAt > COVER_REFRESH_SECONDS || this.coverPlayerPos.distanceTo(this.playerFeet) > COVER_STALE_PLAYER_MOVE) {
      this.chooseCover(now, player);
    }
    const usable = this.hasCover && this.cover.distanceTo(this.playerFeet) >= COVER_ABANDON_DIST && sample.distance <= COVER_MAX_PLAYER_DIST + 5;
    if (!usable) {
      this.inCover = false;
      this.peeking = false;
      if (visible) {
        this.nav.clear();
        this.shoot(sample, player, now);
        return { moveSpeed: 0, wantsMove: false };
      }
      return { moveSpeed: CHASE_SPEED, wantsMove: this.pathTo(this.lastKnown, now) };
    }

    if (this.peeking) {
      if (now < this.peekUntil) {
        // Out at the peek point: fire if the player is in view, else keep stepping out.
        if (visible) {
          this.nav.clear();
          this.shoot(sample, player, now);
          return { moveSpeed: 0, wantsMove: false };
        }
        return { moveSpeed: INVESTIGATE_SPEED, wantsMove: this.pathTo(this.peekPoint, now) };
      }
      // Back into cover.
      const moving = this.pathTo(this.cover, now);
      if (!moving || this.feetPos.distanceTo(this.cover) < COVER_ARRIVE) {
        this.peeking = false;
        this.inCover = true;
        this.nav.clear();
        this.peekAt = now + random.range(PEEK_WAIT[0], PEEK_WAIT[1]);
        return { moveSpeed: 0, wantsMove: false };
      }
      return { moveSpeed: INVESTIGATE_SPEED, wantsMove: moving };
    }

    if (!this.inCover) {
      // On the way to cover: shoot on the move when the player is in view (moving spread applies).
      if (visible) this.shoot(sample, player, now);
      const moving = this.pathTo(this.cover, now);
      if (!moving || this.feetPos.distanceTo(this.cover) < COVER_ARRIVE) {
        this.inCover = true;
        this.nav.clear();
        this.peekAt = now + random.range(PEEK_WAIT[0], PEEK_WAIT[1]);
        return { moveSpeed: 0, wantsMove: false };
      }
      return { moveSpeed: CHASE_SPEED, wantsMove: moving };
    }

    // Holding cover. If the player is in view from here the cover is not doing its job: fire anyway.
    if (visible) {
      this.shoot(sample, player, now);
      return { moveSpeed: 0, wantsMove: false };
    }
    if (now >= this.peekAt) this.startPeek(now);
    return { moveSpeed: 0, wantsMove: false };
  }

  /** Sample navmesh points near the enemy and keep the closest one the player cannot see into. */
  private chooseCover(now: number, player: OperatorView): void {
    const { navigation, physics, random } = this.deps;
    this.coverChosenAt = now;
    this.coverPlayerPos.copy(this.playerFeet);
    this.hasCover = false;
    this.inCover = false;
    this.peeking = false;
    this.playerEye.copy(this.playerFeet);
    this.playerEye.y += Math.min(EYE_HEIGHT, player.colliderHeight * 0.9);
    this.hasCover = findCover(
      navigation,
      physics,
      random,
      {
        from: this.feetPos,
        threatEye: this.playerEye,
        searchRadius: COVER_SEARCH_RADIUS,
        samples: COVER_SAMPLES,
        minThreatDistance: COVER_MIN_PLAYER_DIST,
        maxThreatDistance: COVER_MAX_PLAYER_DIST,
        hideHeight: CHEST_HEIGHT * 0.8,
        preferredThreatDistance: 14,
      },
      this.cover,
    );
  }

  /** Step sideways out of cover, perpendicular to the player, onto the navmesh. */
  private startPeek(now: number): void {
    const { navigation, random } = this.deps;
    if (peekPoint(navigation, this.cover, this.playerFeet, PEEK_OFFSET, random, this.peekPoint)) {
      this.peeking = true;
      this.inCover = false;
      this.peekUntil = now + random.range(PEEK_SECONDS[0], PEEK_SECONDS[1]);
      this.nav.clear();
      return;
    }
    // Nowhere to peek from: wait and try again.
    this.peekAt = now + 1;
  }

  private becomeAlert(now: number): void {
    if (this.dead) return;
    if (this.state !== 'alert') {
      this.alertSince = now;
      this.nextBurstAt = now + REACTION_SECONDS;
      this.hasCover = false;
      this.inCover = false;
      this.peeking = false;
      this.deps.sfx.bark(this.eid, 'alert');
    }
    this.state = 'alert';
    this.awareness = 1;
    this.lastSeenAt = Math.max(this.lastSeenAt, now - AWARENESS.loseAfter + 1.5);
    this.lookUntil = -1;
    this.nav.clear();
  }

  private investigate(position: THREE.Vector3, now: number): void {
    this.lastKnown.copy(position);
    if (this.state === 'unaware') this.deps.sfx.bark(this.eid, 'suspicious');
    this.state = this.state === 'searching' ? 'searching' : 'suspicious';
    this.lookUntil = -1;
    this.nav.clear();
    void now;
  }

  // ---- movement helpers ----------------------------------------------------------

  /** Walk the route; wait at each point. Returns whether we are moving. */
  private patrol(now: number): boolean {
    const route = this.spec.route;
    if (route.length < 2) return false;
    if (now < this.waitUntil) return false;
    const target = route[this.routeIndex % route.length] as THREE.Vector3;
    this.nav.setDestination(target);
    const moving = this.nav.steer(this.feetPos, now, this.steer);
    if (!moving) {
      this.routeIndex = (this.routeIndex + 1) % route.length;
      this.waitUntil = now + PATROL_WAIT;
      this.nav.clear();
    }
    return moving;
  }

  /** Path to the last known position, then stand and look for `lookSeconds`. Returns whether we are moving. */
  private goLook(now: number, lookSeconds: number): boolean {
    if (this.lookUntil >= 0) return false;
    const moving = this.pathTo(this.lastKnown, now);
    if (!moving) this.lookUntil = now + lookSeconds;
    return moving;
  }

  /** Head toward `target` on the navmesh (the agent repaths on its cadence). Returns whether we are moving. */
  private pathTo(target: THREE.Vector3, now: number): boolean {
    this.nav.setDestination(target);
    return this.nav.steer(this.feetPos, now, this.steer);
  }

  // ---- fire -------------------------------------------------------------------------

  private shoot(sample: { distance: number }, player: OperatorView, now: number): void {
    const { physics, random, impacts, sfx } = this.deps;
    // Burst rhythm: fire for a beat, pause for a beat, from the seeded stream.
    if (now >= this.nextBurstAt && now >= this.burstUntil) {
      this.burstUntil = now + random.range(0.25, 0.45);
      this.nextBurstAt = this.burstUntil + random.range(0.5, 1.1);
    }
    this.weapon.trigger = now < this.burstUntil;
    if (this.weapon.ammo === 0) this.weapon.reloadRequested = true;
    const wasReloading = this.weapon.reloading;
    const shots = this.weapon.fixedUpdate(1 / 60, { stance: 'stand', speed: this.speed, grounded: true, aiming: true }, random);
    if (!wasReloading && this.weapon.reloading) {
      sfx.reload(this.eid, false);
      sfx.bark(this.eid, 'reload');
    }
    if (shots.length === 0) return;

    const settled = Math.min(1, (now - this.alertSince) / 2.5);
    const spreadDeg = BOT_SPREAD_UNSETTLED_DEG + (BOT_SPREAD_DEG - BOT_SPREAD_UNSETTLED_DEG) * settled + (this.speed > 0.5 ? 1.5 : 0);
    for (let i = 0; i < shots.length; i++) {
      this.eye.copy(this.feetPos);
      this.eye.y += EYE_HEIGHT;
      this.shotDir.copy(this.playerFeet);
      this.shotDir.y += Math.min(CHEST_HEIGHT, player.colliderHeight * 0.65);
      this.shotDir.sub(this.eye).normalize();
      applySpread(this.shotDir, spreadDeg, random, this.tmpA, this.tmpB);
      this.rifle.muzzle.getWorldPosition(this.tmpA);
      this.flash.fire(this.tmpA, this.shotDir, now);
      sfx.enemyShot(this.eid, this.feetPos.distanceTo(this.playerFeet));
      const hit = physics.raycast(this.eye, this.shotDir, ENEMY_RIFLE.range, { layers: ['world', 'player'], excludeEid: this.eid });
      // A near miss whips past the operator's head.
      this.tmpB.copy(this.playerFeet);
      this.tmpB.y += Math.min(CHEST_HEIGHT, player.colliderHeight * 0.8);
      const along = this.tmpB.sub(this.eye).dot(this.shotDir);
      if (along > 0 && (!hit || hit.distance > along)) {
        this.tmpA.copy(this.eye).addScaledVector(this.shotDir, along);
        this.tmpB.copy(this.playerFeet);
        this.tmpB.y += Math.min(CHEST_HEIGHT, player.colliderHeight * 0.8);
        if (this.tmpA.distanceTo(this.tmpB) < WHIZ_DISTANCE) sfx.whiz(this.tmpA);
      }
      if (!hit) continue;
      if (hit.eid === player.eid) {
        this.tmpA.set(hit.point.x, hit.point.y, hit.point.z);
        player.feet(this.tmpB);
        const zone = hitZoneAt((this.tmpA.y - this.tmpB.y) / player.colliderHeight);
        player.takeDamage(Math.round(damageAt(ENEMY_RIFLE, hit.distance)), zone, now);
      } else {
        this.tmpA.set(hit.point.x, hit.point.y, hit.point.z);
        this.tmpB.set(hit.normal.x, hit.normal.y, hit.normal.z);
        impacts.world(this.tmpA, this.tmpB, hit.eid);
      }
    }
    void sample;
  }

  dispose(): void {
    const { entities, animation, scene, labels, physics } = this.deps;
    labels.detach(this.eid);
    this.retireRagdoll();
    if (this.animated) animation.detach(this.eid);
    for (const m of this.tinted) m.dispose();
    this.rifle.dispose();
    if (!this.dead) {
      this.controller.detach(this.eid);
      physics.removeBody(this.eid);
    }
    this.controller.dispose();
    this.flash.dispose();
    scene.remove(this.root);
    entities.destroy(this.eid);
  }
}
