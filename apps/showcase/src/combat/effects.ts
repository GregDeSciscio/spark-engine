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
  type Random,
} from '@spark/engine';

/**
 * Shot presentation shared by every shooter: a muzzle flash (GPU burst plus a
 * one-tick point light) per gun, and the impact set (decal clipped to the
 * level mesh, sparks, a hit sound) for the whole scene. No damage rules here.
 */

export interface EffectsDeps {
  readonly entities: EntityWorld;
  readonly vfx: ParticleSystem;
  readonly scene: THREE.Scene;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _quat = new THREE.Quaternion();

/** Emitter presets fire along local +Y; aim that at `direction` from `position`. */
export function placeEmitter(entities: EntityWorld, eid: Entity, position: THREE.Vector3, direction: THREE.Vector3): void {
  const t = entities.store(Transform);
  _quat.setFromUnitVectors(Y_AXIS, direction);
  t.x[eid] = position.x;
  t.y[eid] = position.y;
  t.z[eid] = position.z;
  t.qx[eid] = _quat.x;
  t.qy[eid] = _quat.y;
  t.qz[eid] = _quat.z;
  t.qw[eid] = _quat.w;
}

function spawnEmitter(deps: EffectsDeps, bag: DisposeBag, preset: 'muzzleFlash' | 'sparks', overrides?: { capacity?: number }): Entity | null {
  const { entities, vfx, scene } = deps;
  const eid = entities.create(Transform);
  bag.add(() => entities.destroy(eid));
  const handle = vfx.spawnEmitter(eid, preset, overrides);
  if (!handle) return null;
  scene.add(handle.object);
  bag.add(() => scene.remove(handle.object));
  return eid;
}

const FLASH_SECONDS = 0.05;

export class MuzzleFlash {
  private readonly deps: EffectsDeps;
  private readonly bag = new DisposeBag();
  private readonly light: THREE.PointLight;
  private readonly eid: Entity | null;
  private readonly intensity: number;
  private flashUntil = -1;

  constructor(deps: EffectsDeps, color: number, intensity: number) {
    this.deps = deps;
    this.intensity = intensity;
    this.light = new THREE.PointLight(color, 0, 7, 2);
    deps.scene.add(this.light);
    this.bag.add(() => {
      deps.scene.remove(this.light);
      this.light.dispose();
    });
    this.eid = spawnEmitter(deps, this.bag, 'muzzleFlash');
  }

  fire(position: THREE.Vector3, direction: THREE.Vector3, now: number): void {
    this.light.position.copy(position);
    this.flashUntil = now + FLASH_SECONDS;
    if (this.eid !== null) {
      placeEmitter(this.deps.entities, this.eid, position, direction);
      this.deps.vfx.burst(this.eid, 18);
    }
  }

  fixedUpdate(now: number): void {
    this.light.intensity = now < this.flashUntil ? this.intensity : 0;
  }

  dispose(): void {
    this.bag.dispose();
  }
}

export interface ImpactsDeps extends EffectsDeps {
  readonly audio: AudioSystem;
  readonly random: Random;
  /** Level meshes by physics entity, for clipping decals. */
  readonly worldMeshes: ReadonlyMap<Entity, THREE.Mesh>;
  /** Defined sound name for a world hit, or null to stay silent. */
  readonly hitSound: string | null;
}

function impactMaterial(): THREE.MeshStandardNodeMaterial {
  const m = prepareDecalMaterial(new THREE.MeshStandardNodeMaterial());
  m.color.setHex(0x0b0b0e);
  m.roughness = 0.9;
  m.metalness = 0;
  m.opacityNode = smoothstep(float(0.5), float(0.22), length(uv().sub(vec2(0.5, 0.5))));
  return m;
}

export class Impacts {
  private readonly deps: ImpactsDeps;
  private readonly bag = new DisposeBag();
  private readonly decals: Decals;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly sparksEid: Entity | null;

  constructor(deps: ImpactsDeps) {
    this.deps = deps;
    this.decals = new Decals(deps.scene, { dynamicCapacity: 64 });
    this.bag.add(this.decals);
    this.material = impactMaterial();
    this.bag.add(() => this.material.dispose());
    this.sparksEid = spawnEmitter(deps, this.bag, 'sparks', { capacity: 768 });
  }

  /** A bullet struck level geometry at `point` with surface `normal` on entity `eid`. */
  world(point: THREE.Vector3, normal: THREE.Vector3, eid: Entity): void {
    const { random, worldMeshes, vfx, audio, hitSound } = this.deps;
    const mesh = worldMeshes.get(eid);
    if (mesh) {
      this.decals.spawn({
        position: point,
        normal,
        size: random.range(0.09, 0.14),
        rotation: random.range(0, Math.PI * 2),
        target: mesh,
        material: this.material,
      });
    }
    if (this.sparksEid !== null) {
      placeEmitter(this.deps.entities, this.sparksEid, point, normal);
      vfx.burst(this.sparksEid, 10);
    }
    if (hitSound) audio.playAt(hitSound, { x: point.x, y: point.y, z: point.z }, { volume: 0.35 });
  }

  dispose(): void {
    this.bag.dispose();
  }
}
