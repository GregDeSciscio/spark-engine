import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import {
  DisposeBag,
  MAX_VOLUME_FOG_SPOTS,
  PARTICLE_PRESETS,
  Transform,
  VolumeFogSettings,
  type Entity,
  type EntityWorld,
  type ParticleEmitterDescriptorInput,
  type ParticleSystem,
  type QualitySettings,
  type RenderPipeline,
} from '@spark/engine';
import type { MissionLevel } from './MissionLevel';

/**
 * The weather and air of the street, wired from the same engine pieces the
 * benchmark alley proved: a GPU rain volume that follows the operator, splash
 * rings on the wet ground around them, steam from the level's authored vents,
 * a volumetric fog volume whose four cone slots follow the nearest neon
 * lights, and godrays from the moon. Costs are in docs/rendering/effect-costs.md.
 */
export interface AtmosphereDeps {
  readonly entities: EntityWorld;
  readonly vfx: ParticleSystem;
  readonly scene: THREE.Scene;
  readonly quality: QualitySettings;
  readonly pipeline: RenderPipeline;
  /** WebGPU backend: volumetrics and godrays exist only there. */
  readonly gpu: boolean;
}

export interface Atmosphere {
  /** Per frame: `focus` is where the rain and splashes centre (the operator's feet). */
  update(focus: THREE.Vector3): void;
  dispose(): void;
}

const RAIN_CAPACITY = 20_000;
const RAIN_VOLUME: readonly [number, number, number] = [20, 22, 48];
const RAIN_NEAR_FADE = 7;
const SPLASH_AREA: readonly [number, number, number] = [16, 0.02, 40];
/** Neon cones: how far below the sign the cone starts and how far it reaches. */
const CONE_RANGE = 9;
const CONE_ANGLE = 1.0;

function splashRingDescriptor(geometry: THREE.BufferGeometry, material: THREE.NodeMaterial, capacity: number, rate: number): ParticleEmitterDescriptorInput {
  return {
    capacity,
    rate,
    lifetime: [0.3, 0.5],
    shape: { kind: 'box', size: SPLASH_AREA },
    space: 'world',
    direction: [0, 1, 0],
    speed: [0, 0],
    spread: 0,
    gravity: 0,
    drag: 0,
    size: [0.07, 0.14],
    sizeOverLife: [
      [0, 0.15],
      [1, 1],
    ],
    colorOverLife: [
      [0, 1, 1, 1, 0.4],
      [0.5, 1, 1, 1, 0.22],
      [1, 1, 1, 1, 0],
    ],
    render: { kind: 'mesh', geometry, material, align: 'none' },
    seed: 77,
  };
}

export function createAtmosphere(deps: AtmosphereDeps, level: MissionLevel, moon: THREE.DirectionalLight): Atmosphere {
  const { entities, vfx, scene, quality, pipeline, gpu } = deps;
  const bag = new DisposeBag();
  const density = quality.particleDensity;

  const emitter = (x: number, y: number, z: number, preset: Parameters<ParticleSystem['spawnEmitter']>[1], overrides?: Parameters<ParticleSystem['spawnEmitter']>[2]): Entity | null => {
    const eid = entities.create([Transform, { x, y, z }]);
    bag.add(() => entities.destroy(eid));
    const handle = vfx.spawnEmitter(eid, preset, overrides);
    if (!handle) return null;
    scene.add(handle.object);
    bag.add(() => scene.remove(handle.object));
    return eid;
  };

  // ---- rain and splashes follow the operator ------------------------------------
  let rainEid: Entity | null = null;
  let splashEid: Entity | null = null;
  if (vfx.available) {
    rainEid = emitter(0, 10, 0, 'rain', {
      capacity: Math.max(2000, Math.round(RAIN_CAPACITY * density)),
      wrap: { size: RAIN_VOLUME },
      shape: { kind: 'box', size: RAIN_VOLUME },
      direction: [0.06, -1, 0.02],
      speed: [13, 19],
      size: [0.015, 0.024],
      render: { ...PARTICLE_PRESETS.rain.render, nearFade: RAIN_NEAR_FADE },
      colorOverLife: [
        [0, 0.7, 0.78, 1.0, 0.24],
        [1, 0.7, 0.78, 1.0, 0.24],
      ],
    });
    const splashMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    splashMaterial.colorNode = color(new THREE.Color(0.55, 0.62, 0.8));
    const splashGeometry = new THREE.RingGeometry(0.72, 1, 14).rotateX(-Math.PI / 2);
    bag.add(() => {
      splashMaterial.dispose();
      splashGeometry.dispose();
    });
    splashEid = emitter(0, 0.02, 0, splashRingDescriptor(splashGeometry, splashMaterial, Math.max(100, Math.round(700 * density)), Math.round(900 * density)));

    // ---- steam from the level's vents ---------------------------------------------
    const steamCapacity = Math.max(48, Math.round(200 * density));
    for (const spot of level.vfx) {
      const d = spot.direction;
      emitter(spot.position.x, spot.position.y, spot.position.z, spot.preset, {
        capacity: steamCapacity,
        direction: [d.x, d.y, d.z],
        wind: [d.x * 0.8, 1.0, d.z * 0.8],
      });
    }
  }

  // ---- volumetrics: a fog volume over the street, cones under the nearest neon; godrays from the moon ----
  let volume: VolumeFogSettings | null = null;
  const cones = Math.min(MAX_VOLUME_FOG_SPOTS, level.lights.length);
  if (gpu) {
    volume = new VolumeFogSettings({
      bounds: level.bounds,
      density: 0.022,
      color: 0x2c3a58,
      ambient: 0.015,
      heightFalloff: 14,
      noiseScale: 0.18,
      noiseDrift: new THREE.Vector3(0.25, 0.08, 0.12),
      noiseStrength: 0.45,
      anisotropy: 0.45,
      spots: level.lights.slice(0, cones).map((light) => ({
        position: light.position.clone(),
        direction: new THREE.Vector3(0, -1, 0),
        angle: CONE_ANGLE,
        penumbra: 0.6,
        color: light.color.getHex(),
        intensity: 5,
        range: CONE_RANGE,
      })),
    });
    pipeline.setVolumeFog(volume);
    pipeline.setGodraysLight(moon, { color: 0x7d95d8, intensity: 0.55, density: 0.9, maxDensity: 0.35, distanceAttenuation: 1.6 });
    // The volume measured well under the 1.5 ms opt-in bar in the alley, so high opts in like the alley does.
    if (quality.preset === 'high' && quality.shadows) pipeline.setEffectEnabled('volumetrics', true);
    bag.add(() => {
      pipeline.setVolumeFog(null);
      pipeline.setGodraysLight(null);
    });
  }

  const t = entities.store(Transform);
  const ranked: { light: THREE.PointLight; d: number }[] = level.lights.map((light) => ({ light, d: 0 }));
  const conePos = new THREE.Vector3();
  const coneDir = new THREE.Vector3();

  return {
    update(focus) {
      if (rainEid !== null) {
        t.x[rainEid] = focus.x;
        t.y[rainEid] = focus.y + 10;
        t.z[rainEid] = focus.z;
      }
      if (splashEid !== null) {
        t.x[splashEid] = focus.x;
        t.y[splashEid] = focus.y + 0.02;
        t.z[splashEid] = focus.z;
      }
      if (volume && cones > 0) {
        // The nearest signs get the cone slots; the cones lean from the sign toward the street.
        for (const r of ranked) r.d = r.light.position.distanceToSquared(focus);
        ranked.sort((a, b) => a.d - b.d);
        for (let i = 0; i < cones; i++) {
          const entry = ranked[i];
          if (!entry) break;
          const light = entry.light;
          conePos.copy(light.position);
          conePos.y += 0.3;
          coneDir.set(-Math.sign(light.position.x) * 0.45, -1, 0).normalize();
          volume.setSpot({ position: conePos, direction: coneDir, color: light.color.getHex(), intensity: Math.min(6, light.intensity * 0.25) }, i);
        }
      }
    },
    dispose() {
      bag.dispose();
    },
  };
}
