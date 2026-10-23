import * as THREE from 'three/webgpu';
import { float, length, mx_noise_float, smoothstep, uv, vec2, vec3 } from 'three/tsl';
import {
  Decals,
  DisposeBag,
  PARTICLE_PRESETS,
  Transform,
  prepareDecalMaterial,
  type Entity,
  type ParticleEmitterDescriptorInput,
  type PhysicsWorld,
} from '@spark/engine';
import type { MissionAudio } from '../audio/MissionAudio';
import type { EffectsDeps } from './effects';

/**
 * The plant's second half, on screen and in the world: a satchel charge on
 * the ground whose fuse light blinks faster as it runs down, and the
 * detonation. The flash is one point light made at load and pulsed, so it is
 * a uniform change and never a shader recompile (docs/performance/cold-start.md);
 * the fireball, sparks, debris, embers and the smoke column are emitters made
 * at load and fired by position. After the blast the wreck keeps burning, so
 * the extraction leg has a fire behind it.
 *
 * When to arm and when it goes off is the objective runner's business
 * (`mission/Objectives.ts`); who the blast hurts is the scene's, through
 * `blastDamage`.
 */

/** Blast falloff: lethal close, nothing past `radius`. */
export const BLAST = {
  radius: 9,
  /** Damage at the centre; a rifleman has 100, the operator 100. */
  peak: 260,
  /** Line of sight blocked by the level: the wall takes most of it. */
  occludedScale: 0.25,
  /** The operator is braced for it (they set it): a lighter hand than the hostiles get. */
  operatorScale: 0.75,
} as const;

/** Damage at `distance` metres from the charge. Quadratic falloff, so it is lethal inside a few metres and a scratch at the edge. */
export function blastDamage(distance: number, occluded: boolean): number {
  if (distance >= BLAST.radius) return 0;
  const k = 1 - Math.max(0, distance) / BLAST.radius;
  return BLAST.peak * k * k * (occluded ? BLAST.occludedScale : 1);
}

/** Seconds between fuse blinks at the start and at the end of the fuse. */
const BLINK_SLOW = 1.0;
const BLINK_FAST = 0.12;
const FLASH_PEAK = 5200;
const FLASH_RANGE = 36;
const FIRE_GLOW = 22;
/** How long the wreck burns, seconds. Longer than the walk home. */
const BURN_SECONDS = 150;
/** Where the charge waits before it is armed: under the street, out of every camera's view. */
const PARKED_Y = -40;

const FIREBALL: ParticleEmitterDescriptorInput = {
  capacity: 160,
  rate: 0,
  lifetime: [0.32, 0.75],
  shape: { kind: 'sphere', radius: 0.5 },
  space: 'world',
  direction: 'shape',
  speed: [2, 7.5],
  spread: 0.45,
  gravity: 2.5,
  drag: 2.8,
  size: [1.3, 2.4],
  sizeOverLife: [[0, 0.35], [0.2, 1.0], [1, 1.7]],
  colorOverLife: [
    [0, 16, 8, 2.6, 1],
    [0.2, 9, 3.4, 0.7, 0.95],
    [0.55, 2.2, 0.55, 0.12, 0.55],
    [1, 0.12, 0.08, 0.07, 0],
  ],
  rotation: [0.5, 1.6],
  render: { kind: 'sprite', blend: 'additive', shape: 'disc', softness: 0.6, fog: true },
  seed: 71,
};

const DEBRIS: ParticleEmitterDescriptorInput = {
  capacity: 256,
  rate: 0,
  lifetime: [0.9, 1.8],
  shape: { kind: 'cone', radius: 0.4, angle: 1.05 },
  space: 'world',
  direction: 'shape',
  speed: [6, 15],
  spread: 0.35,
  gravity: -15,
  drag: 0.25,
  size: [0.05, 0.13],
  sizeOverLife: [[0, 1], [1, 0.8]],
  colorOverLife: [
    [0, 0.09, 0.08, 0.08, 1],
    [0.85, 0.07, 0.065, 0.06, 1],
    [1, 0.06, 0.055, 0.05, 0],
  ],
  rotation: [2, 6],
  render: { kind: 'sprite', blend: 'alpha', shape: 'disc', fog: true },
  seed: 73,
};

/** The column off the wreck: the smoke preset, darker, bigger and slower to leave. */
const COLUMN: ParticleEmitterDescriptorInput = {
  ...PARTICLE_PRESETS.smoke,
  capacity: 420,
  rate: 14,
  lifetime: [6, 9],
  shape: { kind: 'sphere', radius: 0.8 },
  speed: [0.9, 1.6],
  size: [1.4, 2.2],
  sizeOverLife: [[0, 0.4], [0.35, 1.0], [1, 3.2]],
  colorOverLife: [
    [0, 0.06, 0.05, 0.05, 0],
    [0.1, 0.08, 0.07, 0.07, 0.55],
    [0.6, 0.09, 0.09, 0.1, 0.32],
    [1, 0.1, 0.1, 0.11, 0],
  ],
  seed: 79,
};

/** The blast's own puff: the same smoke, all at once. */
const PLUME: ParticleEmitterDescriptorInput = { ...COLUMN, rate: 0, capacity: 160, lifetime: [3.5, 6], speed: [2, 5], spread: 0.6, seed: 83 };

/** The wreck's embers: the preset, slower. */
const WRECK_EMBERS: ParticleEmitterDescriptorInput = { ...PARTICLE_PRESETS.embers, rate: 22, capacity: 384, shape: { kind: 'sphere', radius: 0.9 }, seed: 89 };

export interface DemolitionDeps extends EffectsDeps {
  readonly physics: PhysicsWorld;
  /** Level meshes by physics entity, for clipping the scorch mark. */
  readonly worldMeshes: ReadonlyMap<Entity, THREE.Mesh>;
  readonly sfx: MissionAudio;
}

function scorchMaterial(): THREE.MeshStandardNodeMaterial {
  const m = prepareDecalMaterial(new THREE.MeshStandardNodeMaterial());
  m.color.setHex(0x050404);
  m.roughness = 0.95;
  m.metalness = 0;
  const p = uv().sub(vec2(0.5, 0.5));
  const n = mx_noise_float(vec3(uv().mul(4.0), float(5)));
  m.opacityNode = smoothstep(float(0.5), float(0.12), length(p).add(n.mul(0.2))).mul(0.92);
  return m;
}

export class Demolition {
  private readonly deps: DemolitionDeps;
  private readonly bag = new DisposeBag();
  private readonly charge = new THREE.Group();
  private readonly led: THREE.Mesh;
  private readonly ledMaterial: THREE.MeshBasicMaterial;
  private readonly fuseLight: THREE.PointLight;
  private readonly flash: THREE.PointLight;
  private readonly glow: THREE.PointLight;
  private readonly decals: Decals;
  private readonly scorch: THREE.MeshStandardNodeMaterial;
  private readonly emitters: { fireball: Entity | null; sparks: Entity | null; debris: Entity | null; plume: Entity | null; column: Entity | null; embers: Entity | null };
  private readonly site = new THREE.Vector3();
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly tmp = new THREE.Vector3();
  private armed = false;
  private nextBlink = 0;
  private blinkOff = 0;
  private blastAt = -Infinity;
  private warmed = false;

  constructor(deps: DemolitionDeps) {
    this.deps = deps;
    const { scene } = deps;

    // ---- the charge: a satchel, a strap of tape, a detonator with a red light ----
    const bodyGeo = new THREE.BoxGeometry(0.36, 0.17, 0.24);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2c2e25, roughness: 0.85, metalness: 0.05 });
    const tapeGeo = new THREE.BoxGeometry(0.38, 0.05, 0.05);
    const tapeMat = new THREE.MeshStandardMaterial({ color: 0x8a7a3a, roughness: 0.6, metalness: 0 });
    const boxGeo = new THREE.BoxGeometry(0.1, 0.06, 0.08);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.4, metalness: 0.4 });
    const ledGeo = new THREE.SphereGeometry(0.018, 8, 6);
    this.ledMaterial = new THREE.MeshBasicMaterial({ color: 0xff1a2a });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.085;
    const tape = new THREE.Mesh(tapeGeo, tapeMat);
    tape.position.y = 0.11;
    const det = new THREE.Mesh(boxGeo, boxMat);
    det.position.set(0.06, 0.2, 0.02);
    this.led = new THREE.Mesh(ledGeo, this.ledMaterial);
    this.led.position.set(0.06, 0.24, 0.02);
    // Parked under the street until armed. The engine's warm-up renders the
    // frame with culling on, so the satchel starts unculled to be compiled with
    // everything else, and the first fixed step lets it cull: four draws a
    // frame, for a prop forty metres under the road, were not worth keeping.
    for (const m of [body, tape, det, this.led]) {
      m.castShadow = m === body;
      m.frustumCulled = false;
      this.charge.add(m);
    }
    this.charge.position.set(0, PARKED_Y, 0);
    scene.add(this.charge);
    this.bag.add(() => {
      scene.remove(this.charge);
      for (const g of [bodyGeo, tapeGeo, boxGeo, ledGeo]) g.dispose();
      for (const m of [bodyMat, tapeMat, boxMat, this.ledMaterial]) m.dispose();
    });

    // ---- lights: made now at zero, pulsed later ------------------------------------
    this.fuseLight = new THREE.PointLight(0xff1a2a, 0, 3.5, 2);
    this.flash = new THREE.PointLight(0xffa24a, 0, FLASH_RANGE, 2);
    this.glow = new THREE.PointLight(0xff6a24, 0, 10, 2);
    for (const l of [this.fuseLight, this.flash, this.glow]) {
      l.position.set(0, PARKED_Y, 0);
      scene.add(l);
    }
    this.bag.add(() => {
      for (const l of [this.fuseLight, this.flash, this.glow]) {
        scene.remove(l);
        l.dispose();
      }
    });

    this.decals = new Decals(scene, { dynamicCapacity: 2 });
    this.bag.add(this.decals);
    this.scorch = scorchMaterial();
    this.bag.add(() => this.scorch.dispose());

    this.emitters = {
      fireball: this.emitter(FIREBALL),
      sparks: this.emitter({ ...PARTICLE_PRESETS.sparks, capacity: 900, shape: { kind: 'cone', radius: 0.3, angle: 1.1 }, speed: [6, 18], lifetime: [0.5, 1.4] }),
      debris: this.emitter(DEBRIS),
      plume: this.emitter(PLUME),
      column: this.emitter(COLUMN),
      embers: this.emitter(WRECK_EMBERS),
    };
    for (const eid of [this.emitters.column, this.emitters.embers]) if (eid !== null) deps.vfx.setEnabled(eid, false);
  }

  private emitter(descriptor: ParticleEmitterDescriptorInput): Entity | null {
    const { entities, vfx, scene } = this.deps;
    const eid = entities.create([Transform, { x: 0, y: PARKED_Y, z: 0 }]);
    this.bag.add(() => entities.destroy(eid));
    const handle = vfx.spawnEmitter(eid, descriptor);
    if (!handle) return null;
    scene.add(handle.object);
    this.bag.add(() => scene.remove(handle.object));
    return eid;
  }

  /** The charge is set at `position` (feet on the ground). */
  arm(position: THREE.Vector3, now: number): void {
    this.armed = true;
    this.site.copy(position);
    this.charge.position.copy(position);
    this.charge.rotation.y = 0.4;
    this.fuseLight.position.set(position.x, position.y + 0.35, position.z);
    this.nextBlink = now;
  }

  /** Pulled off the wall, or the run was reloaded: the charge goes back in the bag. */
  disarm(): void {
    this.armed = false;
    this.charge.position.set(0, PARKED_Y, 0);
    this.fuseLight.intensity = 0;
    this.ledMaterial.color.setHex(0x3a0408);
  }

  /** Blink the fuse: faster as `fuseLeft` runs out of `fuseTotal`. Beeps through the mission audio. */
  fixedUpdate(dt: number, now: number, fuseLeft: number, fuseTotal: number): void {
    // One under-the-street burst from every emitter on the first step: their
    // pipelines compile before a detonation needs them, not in the middle of one.
    if (!this.warmed) {
      this.warmed = true;
      for (const m of this.charge.children) m.frustumCulled = true;
      for (const eid of Object.values(this.emitters)) if (eid !== null) this.deps.vfx.burstAt(eid, { x: 0, y: PARKED_Y, z: 0 }, { x: 0, y: 1, z: 0 }, 2);
    }
    if (this.armed) {
      if (now >= this.nextBlink) {
        const k = fuseTotal > 0 ? 1 - Math.max(0, fuseLeft) / fuseTotal : 1;
        this.nextBlink = now + THREE.MathUtils.lerp(BLINK_SLOW, BLINK_FAST, k * k);
        this.blinkOff = now + 0.07;
        this.deps.sfx.chargeBeep(this.site, k);
      }
      const on = now < this.blinkOff;
      this.fuseLight.intensity = on ? 7 : 0;
      this.ledMaterial.color.setHex(on ? 0xff2a3a : 0x3a0408);
    }
    // The flash: a hard rise, a fast fall, a flicker in the tail.
    const t = now - this.blastAt;
    if (t >= 0 && t < 1.5) {
      const env = t < 0.04 ? t / 0.04 : Math.exp(-(t - 0.04) * 6);
      this.flash.intensity = FLASH_PEAK * env * (0.85 + 0.15 * Math.sin(t * 90));
    } else this.flash.intensity = 0;
    // The wreck burns down over its burn time.
    if (t >= 0 && t < BURN_SECONDS) {
      const fade = Math.min(1, t / 0.6) * (1 - t / BURN_SECONDS);
      this.glow.intensity = FIRE_GLOW * fade * (0.75 + 0.25 * Math.sin(now * 13.3) * Math.sin(now * 7.1 + 1.3));
    } else if (t >= BURN_SECONDS) {
      this.glow.intensity = 0;
      for (const eid of [this.emitters.column, this.emitters.embers]) if (eid !== null) this.deps.vfx.setEnabled(eid, false);
    }
    void dt;
  }

  /** It goes off. Everything but the damage, which the scene works out from `blastDamage`. */
  detonate(now: number): void {
    const { vfx, physics, worldMeshes, sfx } = this.deps;
    this.disarm();
    this.blastAt = now;
    const at = this.site;
    this.flash.position.set(at.x, at.y + 1.6, at.z);
    this.glow.position.set(at.x, at.y + 0.8, at.z);
    const up = { x: 0, y: 1, z: 0 };
    const centre = { x: at.x, y: at.y + 0.6, z: at.z };
    const e = this.emitters;
    if (e.fireball !== null) vfx.burstAt(e.fireball, centre, up, 90);
    if (e.sparks !== null) vfx.burstAt(e.sparks, centre, up, 520);
    if (e.debris !== null) vfx.burstAt(e.debris, centre, up, 200);
    if (e.plume !== null) vfx.burstAt(e.plume, { x: at.x, y: at.y + 1.2, z: at.z }, up, 70);
    for (const eid of [e.column, e.embers]) {
      if (eid === null) continue;
      const t = this.deps.entities.store(Transform);
      t.x[eid] = at.x;
      t.y[eid] = at.y + 0.5;
      t.z[eid] = at.z;
      vfx.setEnabled(eid, true);
    }
    // Scorch whatever the charge sat on.
    this.tmp.set(at.x, at.y + 1, at.z);
    const floor = physics.raycast(this.tmp, this.down, 3, { layers: 'world' });
    const mesh = floor ? worldMeshes.get(floor.eid) : undefined;
    if (floor && mesh) {
      this.tmp.set(floor.point.x, floor.point.y, floor.point.z);
      this.decals.spawn({ position: this.tmp, normal: new THREE.Vector3(floor.normal.x, floor.normal.y, floor.normal.z), size: 5.2, rotation: 0.7, target: mesh, material: this.scorch });
    }
    sfx.explosion(at);
  }

  /** A fresh run: no charge, no fire. The scorch mark stays; the street remembers. */
  reset(): void {
    this.disarm();
    this.blastAt = -Infinity;
    this.flash.intensity = 0;
    this.glow.intensity = 0;
    for (const eid of [this.emitters.column, this.emitters.embers]) if (eid !== null) this.deps.vfx.setEnabled(eid, false);
  }

  /** Seconds since the blast, or Infinity before it. */
  sinceBlast(now: number): number {
    return now - this.blastAt;
  }

  dispose(): void {
    this.bag.dispose();
  }
}
