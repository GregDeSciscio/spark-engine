import * as THREE from 'three/webgpu';
import { DisposeBag, type AudioSystem, type Entity, type PhysicsWorld, type Random, type ShoulderCamera, type WorldLabels } from '@spark/engine';
import type { Operator } from '../actors/Operator';
import type { Damageable } from './Damageable';
import { MuzzleFlash, type EffectsDeps, type Impacts } from './effects';
import { Weapon } from './Weapon';
import { ZONE_MULTIPLIER, applySpread, damageAt, hitZoneAt, type WeaponDefinition } from './weapons';

/**
 * The operator's gun in the world: the hitscan ray from the shoulder pivot,
 * hit zones and damage on anything `Damageable`, impact effects, gunshot
 * audio, the recoil handed to the camera, and a shot event for anyone who
 * can hear. Weapon rules live in `weapons.ts` and `Weapon.ts`.
 *
 * A barrel-obstruction check (Task Unit's aim-blocked indicator) is still to
 * come; until then the ray is exactly what the crosshair promises.
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
  /** Defined gunshot sound, or null to stay silent. */
  readonly shotSound: string | null;
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

export class Gunplay {
  readonly weapon: Weapon;
  readonly stats: GunplayStats = { shots: 0, hits: 0, kills: 0 };

  private readonly deps: GunplayDeps;
  private readonly bag = new DisposeBag();
  private readonly targetByEntity = new Map<Entity, Damageable>();
  private readonly flash: MuzzleFlash;
  private readonly muzzle: THREE.Object3D;
  private now = 0;

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
  }

  fixedUpdate(dt: number): void {
    const { operator, camera, random } = this.deps;
    this.now += dt;
    const state = { stance: operator.stance, speed: operator.speed, grounded: operator.grounded, aiming: operator.aiming };
    const shots = operator.dead ? [] : this.weapon.fixedUpdate(dt, state, random);
    for (const shot of shots) this.fire(shot.spreadDeg);
    camera.recoilPitch = -THREE.MathUtils.degToRad(this.weapon.recoilPitch);
    camera.recoilYaw = THREE.MathUtils.degToRad(this.weapon.recoilYaw);
    this.flash.fixedUpdate(this.now);
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
    const { physics, audio, labels, camera, operator, random, impacts, shotSound, onShot } = this.deps;
    const def = this.weapon.def;
    this.stats.shots += 1;

    this.origin.copy(camera.pivot);
    camera.viewForward(this.direction);
    applySpread(this.direction, spreadDeg, random, this.right, this.up);

    this.muzzle.getWorldPosition(this.muzzlePos);
    this.flash.fire(this.muzzlePos, this.direction, this.now);
    if (shotSound) audio.playAt(shotSound, operator.eid, { spatial: { refDistance: 4, rolloff: 1, maxDistance: 80 } });
    onShot?.(this.muzzlePos, RIFLE_LOUDNESS);

    const hit = physics.raycast(this.origin, this.direction, def.range, { layers: ['world', 'target', 'enemy'], excludeEid: operator.eid });
    if (!hit) return;
    this.hitPoint.set(hit.point.x, hit.point.y, hit.point.z);
    this.hitNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);

    const target = this.targetByEntity.get(hit.eid);
    if (target) {
      if (target.dead) return;
      const zone = hitZoneAt(target.heightFraction(this.hitPoint.y));
      const damage = Math.max(1, Math.round(damageAt(def, hit.distance) * ZONE_MULTIPLIER[zone]));
      const killed = target.hit(zone, damage, this.now);
      this.stats.hits += 1;
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
