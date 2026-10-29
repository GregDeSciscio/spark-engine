import * as THREE from 'three/webgpu';
import type { AudioSystem } from '../audio/AudioSystem';
import { DisposeBag } from '../core/Disposable';
import type { Random } from '../core/Random';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import type { ParticleEmitterDescriptorInput } from '../vfx/descriptor';
import type { ParticleSystem } from '../vfx/ParticleSystem';
import { PARTICLE_PRESETS } from '../vfx/presets';
import { DESTRUCTION_VOICES, type DestructionSoundName, type DestructionSounds } from './sounds';

/**
 * What destruction looks and sounds like: the blast (fireball, flash, grit,
 * a concrete-dust billow, a boom and a shake), glue cracking, chunks
 * crumbling as they come apart, rubble thudding down, and THE FINALS'
 * weakening tells: dust trickling and a groan from chunks near their limit.
 */

const PARKED_Y = -60;

/** A sound as played: which, when (fx clock, seconds), where, and how loud. */
export interface Heard {
  name: DestructionSoundName;
  t: number;
  x: number;
  y: number;
  z: number;
  volume: number;
}

const FIREBALL: ParticleEmitterDescriptorInput = {
  capacity: 200,
  rate: 0,
  lifetime: [0.3, 0.7],
  shape: { kind: 'sphere', radius: 0.5 },
  space: 'world',
  direction: 'shape',
  speed: [2, 7.5],
  spread: 0.45,
  gravity: 2.5,
  drag: 2.8,
  size: [1.2, 2.2],
  sizeOverLife: [
    [0, 0.35],
    [0.2, 1.0],
    [1, 1.7],
  ],
  colorOverLife: [
    [0, 7, 3.6, 1.2, 1],
    [0.2, 4, 1.6, 0.35, 0.9],
    [0.55, 1.1, 0.3, 0.07, 0.5],
    [1, 0.08, 0.05, 0.04, 0],
  ],
  render: { kind: 'sprite', blend: 'additive', shape: 'disc', softness: 0.6, fog: true },
  seed: 61,
};

/** Concrete dust: many small, soft, faint puffs that spread and grow (a few big discs read as bubbles). */
const DUST: ParticleEmitterDescriptorInput = {
  ...PARTICLE_PRESETS.smoke,
  capacity: 420,
  rate: 0,
  lifetime: [2.2, 4.8],
  shape: { kind: 'sphere', radius: 0.7 },
  direction: 'shape',
  speed: [0.5, 2.8],
  spread: 0.85,
  gravity: -0.2,
  drag: 1.6,
  wind: [0.25, 0.15, 0.1],
  noise: { strength: 0.9, frequency: 0.7, speed: 0.3 },
  size: [0.45, 1.1],
  sizeOverLife: [
    [0, 0.35],
    [0.3, 1.2],
    [1, 3.4],
  ],
  colorOverLife: [
    [0, 0.6, 0.56, 0.49, 0],
    [0.1, 0.58, 0.54, 0.47, 0.3],
    [0.6, 0.55, 0.51, 0.45, 0.14],
    [1, 0.5, 0.47, 0.42, 0],
  ],
  render: { kind: 'sprite', blend: 'alpha', shape: 'disc', softness: 1, fog: true },
  seed: 67,
};

const GRIT: ParticleEmitterDescriptorInput = {
  capacity: 500,
  rate: 0,
  lifetime: [0.8, 1.6],
  shape: { kind: 'cone', radius: 0.4, angle: 1.1 },
  space: 'world',
  direction: 'shape',
  speed: [4, 13],
  spread: 0.4,
  gravity: -15,
  drag: 0.25,
  size: [0.05, 0.12],
  sizeOverLife: [
    [0, 1],
    [1, 0.8],
  ],
  colorOverLife: [
    [0, 0.32, 0.29, 0.25, 1],
    [0.85, 0.28, 0.26, 0.22, 1],
    [1, 0.25, 0.23, 0.2, 0],
  ],
  rotation: [2, 6],
  render: { kind: 'sprite', blend: 'alpha', shape: 'disc', softness: 0, fog: true },
  seed: 71,
};

/** What a collapse kicks up: big, slow, long-lived billows that hang over the wreck. */
const COLLAPSE: ParticleEmitterDescriptorInput = {
  ...PARTICLE_PRESETS.smoke,
  capacity: 260,
  rate: 0,
  lifetime: [6, 10],
  shape: { kind: 'sphere', radius: 1.6 },
  direction: 'shape',
  speed: [0.6, 2.2],
  spread: 1,
  gravity: -0.05,
  drag: 0.9,
  wind: [0.2, 0.12, 0.08],
  noise: { strength: 0.6, frequency: 0.35, speed: 0.15 },
  size: [1.6, 3],
  sizeOverLife: [
    [0, 0.4],
    [0.25, 1.1],
    [1, 3.2],
  ],
  colorOverLife: [
    [0, 0.6, 0.56, 0.5, 0],
    [0.08, 0.58, 0.54, 0.48, 0.26],
    [0.6, 0.55, 0.52, 0.46, 0.14],
    [1, 0.52, 0.5, 0.45, 0],
  ],
  render: { kind: 'sprite', blend: 'alpha', shape: 'disc', softness: 1, fog: true },
  seed: 79,
};

/** A thin fall of dust from a chunk near its limit. */
const TRICKLE: ParticleEmitterDescriptorInput = {
  capacity: 400,
  rate: 0,
  lifetime: [1.1, 2.0],
  shape: { kind: 'box', size: [0.5, 0.05, 0.3] },
  space: 'world',
  direction: [0, -1, 0],
  speed: [0.2, 0.8],
  spread: 0.25,
  gravity: -4,
  drag: 0.6,
  size: [0.12, 0.3],
  sizeOverLife: [
    [0, 0.5],
    [1, 1.6],
  ],
  colorOverLife: [
    [0, 0.64, 0.6, 0.53, 0],
    [0.15, 0.62, 0.58, 0.51, 0.5],
    [1, 0.6, 0.56, 0.5, 0],
  ],
  render: { kind: 'sprite', blend: 'alpha', shape: 'disc', softness: 0.5, fog: true },
  seed: 73,
};

const UP = { x: 0, y: 1, z: 0 };

export interface FxDeps {
  readonly entities: EntityWorld;
  /** Without it (or on a tier with no GPU particles) there are no particles. */
  readonly vfx?: ParticleSystem | undefined;
  /** Without it there is no sound. */
  readonly audio?: AudioSystem | undefined;
  /** For the shake and the creak gaps. */
  readonly random: Random;
}

export class DestructionFx {
  private readonly deps: FxDeps;
  /** The flash and the emitters; the owner adds it to its scene. */
  readonly object = new THREE.Group();
  private readonly bag = new DisposeBag();
  /**
   * A few emitters per effect, used round-robin: an emitter bursts at one
   * position per frame (`burstAt` moves it), so puffs at several places in
   * the same frame need several emitters.
   */
  private readonly emitters: Record<'fireball' | 'dust' | 'grit' | 'trickle' | 'collapse', Entity[]>;
  private readonly next: Record<'fireball' | 'dust' | 'grit' | 'trickle' | 'collapse', number> = { fireball: 0, dust: 0, grit: 0, trickle: 0, collapse: 0 };
  private readonly flash = new THREE.PointLight(0xffb066, 0, 22, 2);
  private flashLeft = 0;
  private warmed = false;
  private sounds = new Set<DestructionSoundName>();
  /** Seconds until each throttled sound may play again. */
  private readonly cooldown = new Map<DestructionSoundName, number>();
  /** Kilograms of debris landed lately, fading over half a second: what the collapse roar follows. */
  private rubble = 0;
  private shake = 0;
  /** Camera offset to add this frame. */
  readonly shakeOffset = new THREE.Vector3();
  private readonly listener: THREE.Vector3 = new THREE.Vector3();
  /** Seconds of `update`s since `listen`: the clock `heard` is stamped with. */
  private clock = 0;
  private heard: Heard[] | null = null;

  constructor(deps: FxDeps) {
    this.deps = deps;
    const pool = (descriptor: ParticleEmitterDescriptorInput, n: number): Entity[] => {
      const out: Entity[] = [];
      for (let i = 0; i < n; i++) {
        const eid = this.emitter({ ...descriptor, seed: (descriptor.seed ?? 1) + i * 7 });
        if (eid !== null) out.push(eid);
      }
      return out;
    };
    this.emitters = { fireball: pool(FIREBALL, 2), dust: pool(DUST, 10), grit: pool(GRIT, 3), trickle: pool(TRICKLE, 3), collapse: pool(COLLAPSE, 4) };
    this.flash.position.set(0, PARKED_Y, 0);
    this.object.add(this.flash);
    this.bag.add(() => {
      this.object.remove(this.flash);
      this.flash.dispose();
    });
  }

  private emitter(descriptor: ParticleEmitterDescriptorInput): Entity | null {
    const { entities, vfx } = this.deps;
    if (!vfx) return null;
    const eid = entities.create([Transform, { x: 0, y: PARKED_Y, z: 0 }]);
    this.bag.add(() => {
      if (entities.exists(eid)) entities.destroy(eid);
    });
    const handle = vfx.spawnEmitter(eid, descriptor);
    if (!handle) return null;
    // Parked out of view: unculled so the engine's warm-up compiles it with everything else.
    handle.object.frustumCulled = false;
    this.object.add(handle.object);
    this.bag.add(() => this.object.remove(handle.object));
    return eid;
  }

  /**
   * Hand the game's takes to the engine's audio: they decode in the background and play round-robin.
   * The air starts too (the engine holds loops until the first click unlocks audio). Sounds with no
   * takes, and everything without an audio system, stay silent.
   */
  loadSounds(sounds: DestructionSounds | undefined): void {
    const { audio } = this.deps;
    if (!audio || !sounds) return;
    for (const [name, urls] of Object.entries(sounds.takes) as Array<[DestructionSoundName, readonly string[] | undefined]>) {
      const voice = DESTRUCTION_VOICES[name];
      if (!voice || !urls || urls.length === 0) continue;
      const { volume, pitchVariance, maxInstances } = voice;
      audio.defineSound({ name: `destruction-${name}`, urls: [...urls], bus: 'sfx', volume, pitchVariance, maxInstances });
      this.sounds.add(name);
      this.bag.add(() => audio.undefineSound(`destruction-${name}`));
    }
    const air = sounds.air;
    if (air) {
      audio.defineSound({ name: 'destruction-air', url: air.url, bus: 'ambience', loop: true });
      audio.ambience.play('destruction-air', { volume: air.volume, fadeIn: 2 });
      this.bag.add(() => {
        audio.ambience.stop(0);
        audio.undefineSound('destruction-air');
      });
    }
  }

  private play(name: DestructionSoundName, at: THREE.Vector3, volume = 1, gap = 0): void {
    const audio = this.deps.audio;
    if (!audio || !this.sounds.has(name)) return;
    if (gap > 0) {
      if ((this.cooldown.get(name) ?? 0) > 0) return;
      this.cooldown.set(name, gap);
    }
    audio.playAt(`destruction-${name}`, { x: at.x, y: at.y, z: at.z }, { volume, spatial: { refDistance: DESTRUCTION_VOICES[name].reach } });
    this.heard?.push({ name, t: this.clock, x: at.x, y: at.y, z: at.z, volume });
  }

  private burst(which: keyof DestructionFx['emitters'], at: THREE.Vector3, count: number, dir = UP): void {
    const list = this.emitters[which];
    if (list.length === 0) return;
    const eid = list[this.next[which]++ % list.length]!;
    this.deps.vfx?.burstAt(eid, { x: at.x, y: at.y, z: at.z }, dir, count);
  }

  /** A rocket or charge going off. */
  explosion(at: THREE.Vector3, radius: number, normal: THREE.Vector3 | null = null): void {
    const out = normal ? { x: normal.x, y: normal.y, z: normal.z } : UP;
    const k = radius / 1.6;
    this.burst('fireball', at, Math.round(45 * k));
    this.burst('grit', at, Math.round(160 * k), out);
    this.burst('dust', at, Math.round(110 * k));
    // The blast wave raises a ring of dust off the ground around it.
    const ground = Math.max(0.25, at.y - 1.2);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const r = radius * 1.6;
      this.burst('dust', new THREE.Vector3(at.x + Math.cos(a) * r, ground, at.z + Math.sin(a) * r), Math.round(28 * k), { x: Math.cos(a), y: 0.35, z: Math.sin(a) });
    }
    this.flash.position.copy(at);
    this.flash.intensity = 220 * k;
    this.flashLeft = 0.14;
    this.play('boom', at, Math.min(1, 0.6 + 0.25 * k));
    const d = at.distanceTo(this.listener);
    this.shake = Math.max(this.shake, Math.min(0.45, (6 * k) / Math.max(4, d)));
  }

  /** Glue let go (Strain broke contacts): a crack and a puff where it happened. */
  cracks(points: readonly THREE.Vector3[]): void {
    if (points.length === 0) return;
    const c = points.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(points.length);
    this.play('crack', c, Math.min(1, 0.4 + points.length * 0.04), 0.12);
    for (const p of points.slice(0, 6)) this.burst('dust', p, 7);
  }

  /** A falling body broke up on impact. */
  shatter(at: THREE.Vector3, mass: number): void {
    // A big piece coming down raises a cloud that hangs over the wreck for a while.
    if (mass > 4000) this.burst('collapse', at, Math.min(40, Math.round(mass / 1500)));
    const n = Math.min(60, Math.round(mass / 300));
    this.burst('dust', at, Math.max(10, n));
    this.burst('grit', at, Math.max(10, n * 2));
    this.play('crumble', at, Math.min(1, 0.35 + mass / 20000), 0.08);
    this.play('thud', at, Math.min(1, 0.3 + mass / 15000), 0.05);
    this.rubble += mass;
    this.roar(at);
  }

  /**
   * Debris came down hard on something (`mass` all that landed this step, at up to `speed` m/s): a thud,
   * a crunch under a heavy hit, and, while a building's worth keeps arriving, the roar of it.
   */
  land(at: THREE.Vector3, mass: number, speed: number): void {
    const k = Math.min(1, (mass / 3000) * Math.min(1, speed / 8));
    // A thud every step of a collapse was a patter of the same few takes: the roar carries the mass.
    this.play('thud', at, 0.3 + 0.6 * k, 0.1);
    if (k > 0.5) this.play('crumble', at, 0.25 + 0.4 * k, 0.15);
    if (speed > 3) this.rubble += mass;
    this.roar(at);
  }

  /** Six tonnes or more landing within half a second roars, louder the more; the takes overlap into one long one. */
  private roar(at: THREE.Vector3): void {
    if (this.rubble > 6000) this.play('collapse', at, Math.min(1, 0.3 + this.rubble / 30000), 1.5);
  }

  /** Rebar snapping: a hinge gave way under `load` (N). Rubble nets letting go (a kN or two) stay quiet: they pattered. */
  snap(at: THREE.Vector3, load: number): void {
    if (load < 20_000) return;
    this.play('crack', at, Math.min(1, 0.35 + load / 150_000), 0.2);
  }

  /** Something hangs off the structure at `severity` (0–1) of all its hinges can hold for long: it groans. */
  strain(at: THREE.Vector3, severity: number): void {
    this.play('creak', at, 0.3 + 0.5 * severity, 2 + this.deps.random.next() * 2.5);
  }

  /** The container hit something: `speed` is how much its velocity changed in one step (m/s). */
  clang(at: THREE.Vector3, speed: number): void {
    this.play('clang', at, Math.min(1, 0.3 + speed / 3), 0.25);
  }

  /** A chunk near its limit: dust trickles from its underside, and the structure groans. */
  weakening(at: THREE.Vector3, severity: number): void {
    this.burst('trickle', at, Math.round(6 + severity * 10), { x: 0, y: -1, z: 0 });
    // Irregular: a chunk stays near its limit for many seconds, and a groan on the second was a metronome.
    this.play('creak', at, 0.4 + severity * 0.4, 2 + this.deps.random.next() * 2.5);
  }

  /** Start (or stop) logging every sound played, stamped in seconds from now: films mix them offline. */
  listen(on: boolean): void {
    this.heard = on ? [] : null;
    this.clock = 0;
  }

  /** The sounds logged since the last call, oldest first. */
  takeHeard(): Heard[] {
    return this.heard?.splice(0) ?? [];
  }

  /** Once per frame. `listener` is the camera position (shake falls off with distance). */
  update(dt: number, listener: THREE.Vector3): void {
    this.clock += dt;
    this.listener.copy(listener);
    if (!this.warmed) {
      // One under-the-ground burst from every emitter: their pipelines compile now, not mid-blast.
      this.warmed = true;
      for (const list of Object.values(this.emitters)) for (const eid of list) this.deps.vfx?.burstAt(eid, { x: 0, y: PARKED_Y, z: 0 }, UP, 2);
    }
    for (const [k, v] of this.cooldown) this.cooldown.set(k, v - dt);
    this.rubble *= Math.exp(-dt / 0.5);
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      this.flash.intensity *= 0.72;
      if (this.flashLeft <= 0) this.flash.intensity = 0;
    }
    this.shake *= Math.exp(-dt * 7);
    const s = this.shake;
    const r = this.deps.random;
    this.shakeOffset.set((r.next() - 0.5) * s, (r.next() - 0.5) * s, (r.next() - 0.5) * s);
  }

  dispose(): void {
    this.bag.dispose();
  }
}
