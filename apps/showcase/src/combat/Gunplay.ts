import * as THREE from 'three/webgpu';
import { float, length, smoothstep, uv, vec2 } from 'three/tsl';
import {
  Decals,
  DisposeBag,
  Transform,
  prepareDecalMaterial,
  type AudioSystem,
  type Entity,
  type EntityWorld,
  type ParticleSystem,
  type PhysicsWorld,
  type Random,
  type ShoulderCamera,
  type WorldLabels,
} from '@spark/engine';
import type { Operator } from '../actors/Operator';
import type { TargetDummy } from '../actors/TargetDummy';
import { Weapon } from './Weapon';
import { ZONE_MULTIPLIER, applySpread, damageAt, hitZoneAt, type WeaponDefinition } from './weapons';

/**
 * Glue between the operator's weapon and the world: the hitscan ray, hit
 * zones and damage on dummies, impact decals on the level, muzzle flash and
 * flash light, gunshot audio, and the recoil handed to the camera. Owns no
 * weapon rules; those are in `weapons.ts` and `Weapon.ts`.
 *
 * The ray starts at the camera's shoulder pivot along the view direction,
 * which is what the crosshair promises. A barrel-obstruction check (Task
 * Unit's aim-blocked indicator) is still to come.
 */
export interface GunplayDeps {
  readonly entities: EntityWorld;
  readonly physics: PhysicsWorld;
  readonly vfx: ParticleSystem;
  readonly audio: AudioSystem;
  readonly labels: WorldLabels;
  readonly scene: THREE.Scene;
  readonly random: Random;
  readonly camera: ShoulderCamera;
  readonly operator: Operator;
  readonly dummies: readonly TargetDummy[];
  /** Level meshes by physics entity, for clipping decals. */
  readonly worldMeshes: ReadonlyMap<Entity, THREE.Mesh>;
  /** Names of defined sounds; null to stay silent. */
  readonly sounds: { readonly shot: string; readonly hit: string } | null;
}

export interface GunplayStats {
  shots: number;
  hits: number;
  kills: number;
}

const FLASH_SECONDS = 0.05;

function impactMaterial(): THREE.MeshStandardNodeMaterial {
  const m = prepareDecalMaterial(new THREE.MeshStandardNodeMaterial());
  m.color.setHex(0x0b0b0e);
  m.roughness = 0.9;
  m.metalness = 0;
  m.opacityNode = smoothstep(float(0.5), float(0.22), length(uv().sub(vec2(0.5, 0.5))));
  return m;
}

export class Gunplay {
  readonly weapon: Weapon;
  readonly stats: GunplayStats = { shots: 0, hits: 0, kills: 0 };

  private readonly deps: GunplayDeps;
  private readonly bag = new DisposeBag();
  private readonly dummyByEntity = new Map<Entity, TargetDummy>();
  private readonly decals: Decals;
  private readonly impactMat: THREE.MeshStandardNodeMaterial;
  private readonly flashLight: THREE.PointLight;
  private readonly flashEid: Entity | null;
  private readonly sparksEid: Entity | null;
  private readonly muzzle: THREE.Object3D;
  private flashUntil = -1;
  private now = 0;

  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly hitPoint = new THREE.Vector3();
  private readonly hitNormal = new THREE.Vector3();
  private readonly muzzlePos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly yAxis = new THREE.Vector3(0, 1, 0);

  constructor(deps: GunplayDeps, def: WeaponDefinition, muzzle: THREE.Object3D) {
    this.deps = deps;
    this.weapon = new Weapon(def);
    this.muzzle = muzzle;
    for (const d of deps.dummies) this.dummyByEntity.set(d.eid, d);

    this.decals = new Decals(deps.scene, { dynamicCapacity: 48 });
    this.bag.add(this.decals);
    this.impactMat = impactMaterial();
    this.bag.add(() => this.impactMat.dispose());

    this.flashLight = new THREE.PointLight(def.muzzle.flashColor, 0, 7, 2);
    deps.scene.add(this.flashLight);
    this.bag.add(() => {
      deps.scene.remove(this.flashLight);
      this.flashLight.dispose();
    });

    // Emitters live on their own entities; their transforms are set per shot.
    this.flashEid = this.spawnEmitter('muzzleFlash');
    this.sparksEid = this.spawnEmitter('sparks', { capacity: 512 });
  }

  private spawnEmitter(preset: 'muzzleFlash' | 'sparks', overrides?: { capacity?: number }): Entity | null {
    const { entities, vfx, scene } = this.deps;
    const eid = entities.create(Transform);
    this.bag.add(() => entities.destroy(eid));
    const handle = vfx.spawnEmitter(eid, preset, overrides);
    if (!handle) return null;
    scene.add(handle.object);
    this.bag.add(() => scene.remove(handle.object));
    return eid;
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
    for (const d of this.deps.dummies) d.fixedUpdate(this.now);

    const state = { stance: operator.stance, speed: operator.speed, grounded: operator.grounded, aiming: operator.aiming };
    const shots = this.weapon.fixedUpdate(dt, state, random);
    for (const shot of shots) this.fire(shot.spreadDeg);

    camera.recoilPitch = -THREE.MathUtils.degToRad(this.weapon.recoilPitch);
    camera.recoilYaw = THREE.MathUtils.degToRad(this.weapon.recoilYaw);
    this.flashLight.intensity = this.now < this.flashUntil ? this.weapon.def.muzzle.flashIntensity : 0;
  }

  /** Crosshair spread for the HUD, degrees. */
  spreadNow(): number {
    const { operator } = this.deps;
    return this.weapon.spreadNow({ stance: operator.stance, speed: operator.speed, grounded: operator.grounded, aiming: operator.aiming });
  }

  private fire(spreadDeg: number): void {
    const { physics, vfx, audio, labels, camera, operator, random, worldMeshes, sounds } = this.deps;
    const def = this.weapon.def;
    this.stats.shots += 1;

    this.origin.copy(camera.pivot);
    camera.viewForward(this.direction);
    applySpread(this.direction, spreadDeg, random, this.right, this.up);

    // Muzzle: flash, light, sound at the barrel; the ray itself starts at the camera pivot.
    this.muzzle.getWorldPosition(this.muzzlePos);
    this.flashLight.position.copy(this.muzzlePos);
    this.flashUntil = this.now + FLASH_SECONDS;
    if (this.flashEid !== null) {
      this.placeEmitter(this.flashEid, this.muzzlePos, this.direction);
      vfx.burst(this.flashEid, 18);
    }
    if (sounds) audio.playAt(sounds.shot, operator.eid, { spatial: { refDistance: 4, rolloff: 1, maxDistance: 80 } });

    const hit = physics.raycast(this.origin, this.direction, def.range, { layers: ['world', 'target'], excludeEid: operator.eid });
    if (!hit) return;
    this.hitPoint.set(hit.point.x, hit.point.y, hit.point.z);
    this.hitNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);

    const dummy = this.dummyByEntity.get(hit.eid);
    if (dummy) {
      if (dummy.dead) return;
      const zone = hitZoneAt(dummy.heightFraction(this.hitPoint.y));
      const damage = Math.max(1, Math.round(damageAt(def, hit.distance) * ZONE_MULTIPLIER[zone]));
      const killed = dummy.hit(zone, damage, this.now);
      this.stats.hits += 1;
      if (killed) this.stats.kills += 1;
      labels.popup(dummy.eid, zone === 'head' ? `-${damage} HEAD` : `-${damage}`, {
        life: 0.8,
        color: zone === 'head' ? '#ffd166' : '#ff6a4a',
        size: zone === 'head' ? 18 : 15,
      });
      if (killed) labels.popup(dummy.eid, 'DOWN', { life: 1.2, color: '#ffd166', size: 14, rise: 1.4 });
      if (sounds) audio.playAt(sounds.hit, dummy.eid, { volume: 0.6 });
      return;
    }

    const mesh = worldMeshes.get(hit.eid);
    if (mesh) {
      this.decals.spawn({
        position: this.hitPoint,
        normal: this.hitNormal,
        size: random.range(0.09, 0.14),
        rotation: random.range(0, Math.PI * 2),
        target: mesh,
        material: this.impactMat,
      });
    }
    if (this.sparksEid !== null) {
      this.placeEmitter(this.sparksEid, this.hitPoint, this.hitNormal);
      vfx.burst(this.sparksEid, 10);
    }
    if (sounds) audio.playAt(sounds.hit, { x: this.hitPoint.x, y: this.hitPoint.y, z: this.hitPoint.z }, { volume: 0.35 });
  }

  /** Emitter presets fire along local +Y; aim that at `direction`. */
  private placeEmitter(eid: Entity, position: THREE.Vector3, direction: THREE.Vector3): void {
    const t = this.deps.entities.store(Transform);
    this.quat.setFromUnitVectors(this.yAxis, direction);
    t.x[eid] = position.x;
    t.y[eid] = position.y;
    t.z[eid] = position.z;
    t.qx[eid] = this.quat.x;
    t.qy[eid] = this.quat.y;
    t.qz[eid] = this.quat.z;
    t.qw[eid] = this.quat.w;
  }

  dispose(): void {
    this.bag.dispose();
  }
}
