import * as THREE from 'three/webgpu';
import { DisposeBag, type AudioSystem, type Entity, type PhysicsWorld, type Random, type ShoulderCamera, type WorldLabels } from '@spark/engine';
import type { Operator } from '../actors/Operator';
import type { MissionAudio } from '../audio/MissionAudio';
import type { Damageable } from './Damageable';
import { MuzzleFlash, type EffectsDeps, type Impacts } from './effects';
import type { Gore } from './gore';
import { Weapon } from './Weapon';
import { ZONE_MULTIPLIER, applySpread, damageAt, hitZoneAt, type WeaponDefinition } from './weapons';

/**
 * The operator's gun in the world: the hitscan ray from the shoulder pivot,
 * hit zones and damage on anything `Damageable`, impact effects, gunshot
 * audio, the recoil handed to the camera, and a shot event for anyone who
 * can hear. Weapon rules live in `weapons.ts` and `Weapon.ts`.
 *
 * Aiming is Task Unit's two-ray scheme: a ray from the camera through the
 * reticle finds what the player is looking at, then the bullet travels from
 * the shoulder toward that point, so cover the camera sees over still stops
 * the shot and the HUD can say the barrel is blocked. Recoil is split: the
 * reticle carries most of the kick on screen and bullets follow the reticle,
 * while the camera follows only a fraction (Task Unit's cameraFollowRatio).
 */
export interface GunplayDeps extends EffectsDeps {
  readonly physics: PhysicsWorld;
  readonly audio: AudioSystem;
  readonly labels: WorldLabels;
  readonly random: Random;
  readonly camera: ShoulderCamera;
  readonly operator: Operator;
  readonly targets: readonly Damageable[];
  readonly impacts: Impacts;
  readonly gore: Gore;
  readonly sfx: MissionAudio;
  /** Fired after every shot with the muzzle position and how far the report carries, world units. */
  readonly onShot?: ((position: THREE.Vector3, loudness: number) => void) | undefined;
}

export interface GunplayStats {
  shots: number;
  hits: number;
  kills: number;
}

/** How far an unsuppressed rifle report carries. */
const RIFLE_LOUDNESS = 55;
/** Task Unit's cameraFollowRatio: the camera takes this much of the recoil kick; the reticle carries the rest. */
const CAMERA_FOLLOW = 0.25;
/** The barrel counts as blocked when the weapon ray stops this far short of the aim point. */
const BLOCK_SLACK = 0.3;

export class Gunplay {
  readonly weapon: Weapon;
  readonly stats: GunplayStats = { shots: 0, hits: 0, kills: 0 };

  private readonly deps: GunplayDeps;
  private readonly bag = new DisposeBag();
  private readonly targetByEntity = new Map<Entity, Damageable>();
  private readonly flash: MuzzleFlash;
  private readonly muzzle: THREE.Object3D;
  private readonly feet = new THREE.Vector3();
  private now = 0;
  /** The reticle's share of recoil, radians (negative pitch is up). */
  private reticlePitch = 0;
  private reticleYaw = 0;
  /** True while something sits between the shoulder and what the reticle is over. */
  aimBlocked = false;
  private readonly aimDir = new THREE.Vector3();
  private readonly aimPoint = new THREE.Vector3();
  private readonly camOrigin = new THREE.Vector3();

  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly hitNormal = new THREE.Vector3();
  private readonly muzzlePos = new THREE.Vector3();

  constructor(deps: GunplayDeps, def: WeaponDefinition, muzzle: THREE.Object3D) {
    this.deps = deps;
    this.weapon = new Weapon(def);
    this.muzzle = muzzle;
    for (const t of deps.targets) this.targetByEntity.set(t.eid, t);
    this.flash = new MuzzleFlash(deps, def.muzzle.flashColor, def.muzzle.flashIntensity);
    this.bag.add(this.flash);
  }

  /** Per-frame input intent. */
  update(trigger: boolean, triggerEdge: boolean, reload: boolean): void {
    this.weapon.trigger = trigger;
    if (triggerEdge) this.weapon.triggerEdge = true;
    if (reload) this.weapon.reloadRequested = true;
    // Nothing left to load: the trigger just clicks.
    if (triggerEdge && this.weapon.ammo === 0 && this.weapon.reserve === 0 && !this.weapon.reloading) this.deps.sfx.empty();
  }

  fixedUpdate(dt: number): void {
    const { operator, camera, random, sfx } = this.deps;
    this.now += dt;
    const state = { stance: operator.stance, speed: operator.speed, grounded: operator.grounded, aiming: operator.aiming };
    const wasReloading = this.weapon.reloading;
    const shots = operator.dead ? [] : this.weapon.fixedUpdate(dt, state, random);
    if (!wasReloading && this.weapon.reloading) sfx.reload(operator.eid, true);
    for (const shot of shots) this.fire(shot.spreadDeg);
    // Recoil: up is negative pitch; a positive yaw kick goes right, which is negative camera yaw.
    const pitch = -THREE.MathUtils.degToRad(this.weapon.recoilPitch);
    const yaw = -THREE.MathUtils.degToRad(this.weapon.recoilYaw);
    camera.recoilPitch = pitch * CAMERA_FOLLOW;
    camera.recoilYaw = yaw * CAMERA_FOLLOW;
    this.reticlePitch = pitch * (1 - CAMERA_FOLLOW);
    this.reticleYaw = yaw * (1 - CAMERA_FOLLOW);
    this.aimBlocked = !operator.dead && this.resolveAim() && this.barrelBlocked();
    this.flash.fixedUpdate(this.now);
  }

  /** Where the reticle sits on screen this tick, CSS pixels from the centre. */
  reticleOffset(viewportHeight: number, out: { x: number; y: number }): { x: number; y: number } {
    return this.deps.camera.projectAngleOffset(this.reticleYaw, this.reticlePitch, viewportHeight, out);
  }

  /**
   * Camera ray: from the camera through the reticle to the first thing it
   * meets (or the range limit). Fills `aimPoint`/`aimDir`; returns true when
   * something was hit.
   */
  private resolveAim(): boolean {
    const { physics, camera, operator } = this.deps;
    const range = this.weapon.def.range;
    camera.directionFor(this.reticleYaw, this.reticlePitch, this.aimDir);
    this.camOrigin.copy(camera.camera.position);
    const seen = physics.raycast(this.camOrigin, this.aimDir, range + 6, { layers: ['world', 'target', 'enemy'], excludeEid: operator.eid, solid: false });
    if (seen) {
      this.aimPoint.set(seen.point.x, seen.point.y, seen.point.z);
      return true;
    }
    this.aimPoint.copy(this.camOrigin).addScaledVector(this.aimDir, range + 6);
    return false;
  }

  /** Weapon ray from the shoulder toward the aim point stops well short of it. */
  private barrelBlocked(): boolean {
    const { physics, camera, operator } = this.deps;
    this.origin.copy(camera.pivot);
    this.direction.copy(this.aimPoint).sub(this.origin);
    const toAim = this.direction.length();
    if (toAim < 1e-3) return false;
    this.direction.divideScalar(toAim);
    const hit = physics.raycast(this.origin, this.direction, toAim, { layers: ['world', 'target', 'enemy'], excludeEid: operator.eid, solid: false });
    return hit !== null && hit.distance < toAim - BLOCK_SLACK;
  }

  /** Crosshair spread for the HUD, degrees. */
  spreadNow(): number {
    const { operator } = this.deps;
    return this.weapon.spreadNow({ stance: operator.stance, speed: operator.speed, grounded: operator.grounded, aiming: operator.aiming });
  }

  /** Full magazine and reserve, for a checkpoint reload. */
  resetAmmo(): void {
    this.weapon.ammo = this.weapon.def.magazineSize;
    this.weapon.reserve = this.weapon.def.reserveAmmo;
  }

  private fire(spreadDeg: number): void {
    const { physics, labels, camera, operator, random, impacts, gore, sfx, onShot } = this.deps;
    const def = this.weapon.def;
    this.stats.shots += 1;

    // Two rays: what the reticle is over, then the bullet from the shoulder toward it.
    this.resolveAim();
    this.origin.copy(camera.pivot);
    this.direction.copy(this.aimPoint).sub(this.origin).normalize();
    applySpread(this.direction, spreadDeg, random, this.right, this.up);

    this.muzzle.getWorldPosition(this.muzzlePos);
    this.flash.fire(this.muzzlePos, this.direction, this.now);
    operator.feet(this.feet);
    sfx.shot(operator.eid, this.feet);
    onShot?.(this.muzzlePos, RIFLE_LOUDNESS);

    const hit = physics.raycast(this.origin, this.direction, def.range, { layers: ['world', 'target', 'enemy'], excludeEid: operator.eid, solid: false });
    if (!hit) return;
    this.hitPoint.set(hit.point.x, hit.point.y, hit.point.z);
    this.hitNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);

    const target = this.targetByEntity.get(hit.eid);
    if (target) {
      if (target.dead) return;
      const zone = hitZoneAt(target.heightFraction(this.hitPoint.y));
      const damage = Math.max(1, Math.round(damageAt(def, hit.distance) * ZONE_MULTIPLIER[zone]));
      gore.characterHit(this.hitPoint, this.direction, zone === 'head');
      sfx.flesh(this.hitPoint, zone === 'head');
      const killed = target.hit(zone, damage, this.now, { point: this.hitPoint, direction: this.direction });
      this.stats.hits += 1;
      sfx.hitmarker(zone === 'head');
      if (killed) this.stats.kills += 1;
      labels.popup(target.eid, zone === 'head' ? `-${damage} HEAD` : `-${damage}`, {
        life: 0.8,
        color: zone === 'head' ? '#ffd166' : '#ff6a4a',
        size: zone === 'head' ? 18 : 15,
      });
      if (killed) labels.popup(target.eid, 'DOWN', { life: 1.2, color: '#ffd166', size: 14, rise: 1.4 });
      return;
    }
    impacts.world(this.hitPoint, this.hitNormal, hit.eid);
  }

  dispose(): void {
    this.bag.dispose();
  }
}
