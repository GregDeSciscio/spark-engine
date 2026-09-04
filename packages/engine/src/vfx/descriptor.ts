import type * as THREE from 'three/webgpu';

/**
 * Pure (GPU-free) half of the particle system: the emitter descriptor, its
 * validation and defaults, over-life curves, the deterministic per-particle
 * hash mirror, and per-step spawn accounting. Everything here is unit-tested;
 * `ParticleSystem.ts` consumes it.
 */

// ---- shapes ---------------------------------------------------------------

export type EmitterShape =
  | { readonly kind: 'point' }
  /** Volume (or surface when `shell`) of a sphere. Outward normal is the shape direction. */
  | { readonly kind: 'sphere'; readonly radius: number; readonly shell?: boolean }
  /** Axis-aligned box centred on the emitter. Shape direction is +Y. */
  | { readonly kind: 'box'; readonly size: readonly [number, number, number] }
  /** Disc of `radius` at the base, velocities inside a cone of half-angle `angle` (radians) around local +Y. */
  | { readonly kind: 'cone'; readonly radius: number; readonly angle: number };

export type ShapeKind = EmitterShape['kind'];

/** Numeric shape codes as the compute shader sees them. */
export const SHAPE_CODE: Record<ShapeKind, number> = { point: 0, sphere: 1, box: 2, cone: 3 };

// ---- curves -----------------------------------------------------------------

/** `[t, value]`, `t` in [0, 1]. */
export type CurveKey = readonly [t: number, value: number];
/** `[t, r, g, b, a]`, `t` in [0, 1]. HDR colour values are allowed. */
export type ColorKey = readonly [t: number, r: number, g: number, b: number, a: number];

/** Number of evenly spaced samples the GPU receives for each over-life curve. */
export const CURVE_SAMPLES = 8;

// ---- render -----------------------------------------------------------------

export interface SpriteRenderDescriptor {
  readonly kind: 'sprite';
  readonly blend: 'additive' | 'alpha';
  /** `disc`: soft radial falloff. `streak`: quad stretched along the view-space velocity. */
  readonly shape: 'disc' | 'streak';
  /** Streak length added per unit of speed (seconds of travel). Ignored for `disc`. */
  readonly stretch: number;
  /**
   * Soft-particle fade distance in world units against the scene depth
   * (0 = off). Costs one depth copy per frame per emitter material; keep it
   * for large slow sprites (smoke), never for 100k streaks.
   */
  readonly softness: number;
  /**
   * Near-camera fall-off distance in world units (0 = off). Sprites closer
   * than this to the camera shrink and fade toward zero at the lens, so a
   * rain streak passing the camera does not become a thick smear across the
   * frame. Free: one view-space distance per vertex.
   */
  readonly nearFade: number;
  readonly texture: THREE.Texture | null;
  readonly fog: boolean;
  readonly depthWrite: boolean;
}

export interface MeshRenderDescriptor {
  readonly kind: 'mesh';
  readonly geometry: THREE.BufferGeometry;
  /** Any three node material. The system writes its `positionNode` and `normalNode`. */
  readonly material: THREE.NodeMaterial;
  /** `velocity`: local +Y follows the particle velocity. `none`: world-axis aligned. */
  readonly align: 'none' | 'velocity';
}

export type RenderDescriptor = SpriteRenderDescriptor | MeshRenderDescriptor;

// ---- emitter --------------------------------------------------------------------

export interface ParticleEmitterDescriptor {
  /** Maximum simultaneous particles. Storage buffers are sized to this. */
  readonly capacity: number;
  /** Continuous spawn rate in particles per second (0 = bursts only). */
  readonly rate: number;
  /** Seconds, `[min, max]`. */
  readonly lifetime: readonly [number, number];
  readonly shape: EmitterShape;
  /**
   * `world`: particles are spawned at the emitter's world transform and then
   * live in world space. `local`: they live in the emitter's frame and move
   * with it.
   */
  readonly space: 'world' | 'local';
  /** Initial direction in emitter space, or `shape` for the shape's own direction. */
  readonly direction: readonly [number, number, number] | 'shape';
  readonly speed: readonly [number, number];
  /** 0 = exactly `direction`, 1 = fully random direction. */
  readonly spread: number;
  /** World-Y acceleration in units/s². Negative is down. */
  readonly gravity: number;
  /** Per-second rate at which velocity approaches `wind` (plain drag when wind is zero). */
  readonly drag: number;
  readonly wind: readonly [number, number, number];
  /** Curl-free perlin turbulence added to velocity. `strength` in units/s², `frequency` in 1/units, `speed` scrolls the field. */
  readonly noise: { readonly strength: number; readonly frequency: number; readonly speed: number };
  /** Base particle size in world units, `[min, max]`. */
  readonly size: readonly [number, number];
  /** Multiplier over life. Sampled to `CURVE_SAMPLES` points for the GPU. */
  readonly sizeOverLife: readonly CurveKey[];
  /** RGBA over life. */
  readonly colorOverLife: readonly ColorKey[];
  /** Sprite roll speed in rad/s, `[min, max]`; sign is random. */
  readonly rotation: readonly [number, number];
  /**
   * When set, particles never die: they wrap inside a box of this size
   * centred on the emitter (rain, snow, dust volumes). `rate` is normally 0
   * and `prewarm` true for these.
   */
  readonly wrap: { readonly size: readonly [number, number, number] } | null;
  /** Start with every particle alive at a random point of its life. */
  readonly prewarm: boolean;
  readonly render: RenderDescriptor;
  /** Emitter seed; combined with the engine seed by the system. */
  readonly seed: number;
}

export type ParticleEmitterDescriptorInput = Partial<Omit<ParticleEmitterDescriptor, 'render' | 'noise'>> & {
  readonly render?: Partial<SpriteRenderDescriptor> | MeshRenderDescriptor;
  readonly noise?: Partial<ParticleEmitterDescriptor['noise']>;
};

export const MAX_EMITTER_CAPACITY = 4_000_000;

const DEFAULT_SPRITE: SpriteRenderDescriptor = {
  kind: 'sprite',
  blend: 'alpha',
  shape: 'disc',
  stretch: 0,
  softness: 0,
  nearFade: 0,
  texture: null,
  fog: true,
  depthWrite: false,
};

const DEFAULTS: Omit<ParticleEmitterDescriptor, 'render'> = {
  capacity: 256,
  rate: 20,
  lifetime: [1, 2],
  shape: { kind: 'point' },
  space: 'world',
  direction: [0, 1, 0],
  speed: [1, 2],
  spread: 0.2,
  gravity: 0,
  drag: 0,
  wind: [0, 0, 0],
  noise: { strength: 0, frequency: 1, speed: 0 },
  size: [0.2, 0.3],
  sizeOverLife: [[0, 1], [1, 1]],
  colorOverLife: [[0, 1, 1, 1, 1], [1, 1, 1, 1, 0]],
  rotation: [0, 0],
  wrap: null,
  prewarm: false,
  seed: 0,
};

function assertFinite(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`ParticleEmitter: ${name} must be a finite number, got ${String(value)}`);
}

function assertRange(name: string, range: readonly [number, number], min = 0): void {
  if (!Array.isArray(range) || range.length !== 2) throw new Error(`ParticleEmitter: ${name} must be [min, max]`);
  assertFinite(`${name}[0]`, range[0]);
  assertFinite(`${name}[1]`, range[1]);
  if (range[0] > range[1]) throw new Error(`ParticleEmitter: ${name} min ${range[0]} exceeds max ${range[1]}`);
  if (range[0] < min) throw new Error(`ParticleEmitter: ${name} must be >= ${min}`);
}

function assertVec3(name: string, v: readonly [number, number, number]): void {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`ParticleEmitter: ${name} must be [x, y, z]`);
  for (let i = 0; i < 3; i++) assertFinite(`${name}[${i}]`, v[i] as number);
}

function validateCurve(name: string, keys: readonly (readonly number[])[], width: number): void {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error(`ParticleEmitter: ${name} needs at least one key`);
  let last = -Infinity;
  for (const key of keys) {
    if (!Array.isArray(key) || key.length !== width) throw new Error(`ParticleEmitter: ${name} keys must have ${width} numbers`);
    for (const v of key) assertFinite(`${name} key`, v);
    const t = key[0] as number;
    if (t < 0 || t > 1) throw new Error(`ParticleEmitter: ${name} key time ${t} outside [0, 1]`);
    if (t < last) throw new Error(`ParticleEmitter: ${name} keys must be sorted by time`);
    last = t;
  }
}

function validateShape(shape: EmitterShape): void {
  switch (shape.kind) {
    case 'point':
      return;
    case 'sphere':
      assertFinite('shape.radius', shape.radius);
      if (shape.radius < 0) throw new Error('ParticleEmitter: shape.radius must be >= 0');
      return;
    case 'box':
      assertVec3('shape.size', shape.size);
      return;
    case 'cone':
      assertFinite('shape.radius', shape.radius);
      assertFinite('shape.angle', shape.angle);
      if (shape.radius < 0) throw new Error('ParticleEmitter: shape.radius must be >= 0');
      if (shape.angle < 0 || shape.angle > Math.PI) throw new Error('ParticleEmitter: shape.angle must be in [0, π]');
      return;
    default:
      throw new Error(`ParticleEmitter: unknown shape kind "${String((shape as { kind: unknown }).kind)}"`);
  }
}

/**
 * Fill defaults and validate. Throws on anything the GPU side could not
 * represent. The result is a new, fully specified descriptor; the input is
 * not mutated.
 */
export function resolveEmitterDescriptor(input: ParticleEmitterDescriptorInput = {}): ParticleEmitterDescriptor {
  const { render: renderInput, noise: noiseInput, ...rest } = input;
  const render: RenderDescriptor =
    renderInput && renderInput.kind === 'mesh' ? renderInput : { ...DEFAULT_SPRITE, ...(renderInput as Partial<SpriteRenderDescriptor> | undefined) };
  const desc: ParticleEmitterDescriptor = {
    ...DEFAULTS,
    ...rest,
    noise: { ...DEFAULTS.noise, ...noiseInput },
    render,
  };

  assertFinite('capacity', desc.capacity);
  if (!Number.isInteger(desc.capacity) || desc.capacity < 1 || desc.capacity > MAX_EMITTER_CAPACITY) {
    throw new Error(`ParticleEmitter: capacity must be an integer in [1, ${MAX_EMITTER_CAPACITY}], got ${desc.capacity}`);
  }
  assertFinite('rate', desc.rate);
  if (desc.rate < 0) throw new Error('ParticleEmitter: rate must be >= 0');
  assertRange('lifetime', desc.lifetime);
  if (desc.lifetime[1] <= 0) throw new Error('ParticleEmitter: lifetime max must be > 0');
  validateShape(desc.shape);
  if (desc.space !== 'world' && desc.space !== 'local') throw new Error(`ParticleEmitter: space must be "world" or "local"`);
  if (desc.direction !== 'shape') assertVec3('direction', desc.direction);
  assertRange('speed', desc.speed, -Infinity);
  assertFinite('spread', desc.spread);
  if (desc.spread < 0 || desc.spread > 1) throw new Error('ParticleEmitter: spread must be in [0, 1]');
  assertFinite('gravity', desc.gravity);
  assertFinite('drag', desc.drag);
  if (desc.drag < 0) throw new Error('ParticleEmitter: drag must be >= 0');
  assertVec3('wind', desc.wind);
  assertFinite('noise.strength', desc.noise.strength);
  assertFinite('noise.frequency', desc.noise.frequency);
  assertFinite('noise.speed', desc.noise.speed);
  assertRange('size', desc.size);
  validateCurve('sizeOverLife', desc.sizeOverLife, 2);
  validateCurve('colorOverLife', desc.colorOverLife, 5);
  assertRange('rotation', desc.rotation, -Infinity);
  if (desc.wrap !== null) assertVec3('wrap.size', desc.wrap.size);
  assertFinite('seed', desc.seed);
  if (render.kind === 'sprite') {
    if (render.blend !== 'additive' && render.blend !== 'alpha') throw new Error('ParticleEmitter: render.blend must be "additive" or "alpha"');
    if (render.shape !== 'disc' && render.shape !== 'streak') throw new Error('ParticleEmitter: render.shape must be "disc" or "streak"');
    assertFinite('render.stretch', render.stretch);
    assertFinite('render.softness', render.softness);
    if (render.softness < 0) throw new Error('ParticleEmitter: render.softness must be >= 0');
    assertFinite('render.nearFade', render.nearFade);
    if (render.nearFade < 0) throw new Error('ParticleEmitter: render.nearFade must be >= 0');
  } else if (render.kind === 'mesh') {
    if (!render.geometry) throw new Error('ParticleEmitter: mesh render needs a geometry');
    if (!render.material) throw new Error('ParticleEmitter: mesh render needs a node material');
    if (render.align !== 'none' && render.align !== 'velocity') throw new Error('ParticleEmitter: render.align must be "none" or "velocity"');
  } else {
    throw new Error(`ParticleEmitter: unknown render kind "${String((render as { kind: unknown }).kind)}"`);
  }
  return desc;
}

// ---- curve sampling ---------------------------------------------------------

/** Linear interpolation over sorted keys, clamped at both ends. */
export function sampleCurve(keys: readonly CurveKey[], t: number): number {
  const first = keys[0];
  if (!first) return 1;
  if (t <= first[0]) return first[1];
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i] as CurveKey;
    if (t <= b[0]) {
      const a = keys[i - 1] as CurveKey;
      const span = b[0] - a[0];
      const f = span > 0 ? (t - a[0]) / span : 1;
      return a[1] + (b[1] - a[1]) * f;
    }
  }
  return (keys[keys.length - 1] as CurveKey)[1];
}

/** Same as `sampleCurve` for RGBA keys. Writes into `out` and returns it. */
export function sampleColorCurve(keys: readonly ColorKey[], t: number, out: number[] = [0, 0, 0, 0]): number[] {
  const first = keys[0];
  if (!first) {
    out[0] = out[1] = out[2] = out[3] = 1;
    return out;
  }
  const write = (a: ColorKey, b: ColorKey, f: number): number[] => {
    for (let c = 0; c < 4; c++) out[c] = (a[c + 1] as number) + ((b[c + 1] as number) - (a[c + 1] as number)) * f;
    return out;
  };
  if (t <= first[0]) return write(first, first, 0);
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i] as ColorKey;
    if (t <= b[0]) {
      const a = keys[i - 1] as ColorKey;
      const span = b[0] - a[0];
      return write(a, b, span > 0 ? (t - a[0]) / span : 1);
    }
  }
  const last = keys[keys.length - 1] as ColorKey;
  return write(last, last, 0);
}

/** `samples` evenly spaced values of the curve over [0, 1], for the GPU uniform array. */
export function bakeCurve(keys: readonly CurveKey[], samples = CURVE_SAMPLES): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = sampleCurve(keys, samples > 1 ? i / (samples - 1) : 0);
  return out;
}

/** RGBA quads, `samples` of them, evenly spaced over [0, 1]. */
export function bakeColorCurve(keys: readonly ColorKey[], samples = CURVE_SAMPLES): Float32Array {
  const out = new Float32Array(samples * 4);
  const rgba = [0, 0, 0, 0];
  for (let i = 0; i < samples; i++) {
    sampleColorCurve(keys, samples > 1 ? i / (samples - 1) : 0, rgba);
    out.set(rgba, i * 4);
  }
  return out;
}

// ---- deterministic hashing ----------------------------------------------------

/**
 * CPU mirror of TSL's `hash()` (PCG, pcg-random.org via shadertoy XlGcRh):
 * uint32 in → float in [0, 1). The compute shader derives every random
 * spawn attribute from this, so anything on the CPU that wants to predict a
 * particle (tests, gameplay hooks) gets bit-identical values.
 */
export function hash01(seed: number): number {
  const state = (Math.imul(seed >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  const result = ((word >>> 22) ^ word) >>> 0;
  return result / 4294967296;
}

/** Multipliers mixing particle index and generation into one hash base. Shared with the shader. */
export const HASH_INDEX_MUL = 1664525;
export const HASH_GENERATION_MUL = 22695477;

/**
 * Hash base for particle `index` on its `generation`-th (re)spawn under
 * `seed`. The k-th random number of that spawn is `hash01(base + k)`.
 */
export function particleHashBase(index: number, generation: number, seed: number): number {
  return (Math.imul(index >>> 0, HASH_INDEX_MUL) + Math.imul(generation >>> 0, HASH_GENERATION_MUL) + (seed >>> 0)) >>> 0;
}

export function particleRandom(index: number, generation: number, seed: number, k: number): number {
  return hash01((particleHashBase(index, generation, seed) + (k >>> 0)) >>> 0);
}

// ---- spawn accounting --------------------------------------------------------

/**
 * Integer spawns for one fixed step at `rate` particles/s, carrying the
 * fractional remainder forward so long-run counts are exact. Pure.
 */
export function spawnCountForStep(rate: number, dt: number, carry: number): { count: number; carry: number } {
  if (!(rate > 0) || !(dt > 0)) return { count: 0, carry };
  const total = rate * dt + carry;
  const count = Math.floor(total + 1e-9);
  return { count, carry: total - count };
}

/**
 * Per-emitter CPU-side spawn bookkeeping: the ring cursor into the particle
 * pool, the fractional carry, queued bursts, and how many spawns are waiting
 * for the next GPU dispatch.
 */
export class SpawnAccumulator {
  readonly capacity: number;
  private carry = 0;
  private cursor = 0;
  private pending = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`SpawnAccumulator: capacity must be a positive integer, got ${capacity}`);
    this.capacity = capacity;
  }

  /** Queue one fixed step of continuous emission. Returns spawns added by this step. */
  step(rate: number, dt: number): number {
    const r = spawnCountForStep(rate, dt, this.carry);
    this.carry = r.carry;
    this.pending += r.count;
    return r.count;
  }

  /** Queue an immediate burst. */
  burst(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.pending += Math.floor(count);
  }

  /** Spawns queued and not yet handed to the GPU. */
  get pendingCount(): number {
    return this.pending;
  }

  /** Where the next spawn window starts in the ring. */
  get ringCursor(): number {
    return this.cursor;
  }

  /**
   * Hand the queued spawns to the GPU as one window `[start, start + count)`
   * (mod capacity), advancing the ring. More than `capacity` pending spawns
   * clamp to `capacity`: the pool cannot hold more than one full ring per
   * dispatch, and the excess is dropped rather than double-spawning slots.
   */
  flush(): { start: number; count: number } {
    const count = Math.min(this.pending, this.capacity);
    const start = this.cursor;
    this.cursor = (this.cursor + count) % this.capacity;
    this.pending = 0;
    return { start, count };
  }

  reset(): void {
    this.carry = 0;
    this.cursor = 0;
    this.pending = 0;
  }
}

/**
 * Cheap CPU estimate of live particles for stats overlays: spawns are
 * remembered with their latest possible death time. Wrap emitters are always
 * full.
 */
export class LiveEstimator {
  private readonly events: { expires: number; count: number }[] = [];
  private total = 0;

  record(time: number, count: number, maxLifetime: number): void {
    if (count <= 0) return;
    this.events.push({ expires: time + maxLifetime, count });
    this.total += count;
  }

  /** Live count at `time`, capped at `capacity`. */
  estimate(time: number, capacity: number): number {
    while (this.events.length > 0 && (this.events[0] as { expires: number }).expires <= time) {
      this.total -= (this.events.shift() as { count: number }).count;
    }
    return Math.min(capacity, this.total);
  }

  clear(): void {
    this.events.length = 0;
    this.total = 0;
  }
}
