import type { Random } from '../core/Random';
import type { Voice } from './AudioSystem';
import type { SoundSink } from './SoundBank';
import type { SpatialOptions } from './Spatial';

/**
 * Ambience helpers on top of a `SoundSink` (an `AudioSystem` or a `SoundBank`).
 *
 * `EmitterPool`: looping point sources (neon signs, vents, machinery). Only
 * the nearest `max` within range sound at a time; the set is re-picked every
 * `repickSeconds` as the listener moves, so a level can register every
 * emitter it has without spending a voice on each.
 *
 * `Scatter`: one-shots on a random timer, either around the listener at a
 * random radius (drips, creaks) or flat (distant thunder, a fly-by).
 */
type Vec3 = { x: number; y: number; z: number };

export interface EmitterPoolOptions {
  /** How many emitters sound at once. Default 6. */
  readonly max?: number | undefined;
  /** Seconds between re-picks of the nearest set. Default 1.5. */
  readonly repickSeconds?: number | undefined;
  /** Spatial settings every emitter plays with; `maxDistance` is also the range an emitter must be within to sound. */
  readonly spatial: SpatialOptions;
  /** Fade when an emitter starts or stops. Default 0.8 s. */
  readonly fadeSeconds?: number | undefined;
}

export interface EmitterSpec {
  readonly position: Vec3;
  readonly sound: string;
  readonly pitch?: number | undefined;
  readonly volume?: number | undefined;
}

interface Emitter extends EmitterSpec {
  voice: Voice | null;
  distance: number;
}

export class EmitterPool {
  private readonly emitters: Emitter[] = [];
  private readonly max: number;
  private readonly repickSeconds: number;
  private readonly fade: number;
  private readonly spatial: SpatialOptions;
  private repickIn = 0;

  constructor(
    private readonly sink: SoundSink,
    options: EmitterPoolOptions,
  ) {
    this.max = options.max ?? 6;
    this.repickSeconds = options.repickSeconds ?? 1.5;
    this.fade = options.fadeSeconds ?? 0.8;
    this.spatial = options.spatial;
  }

  /** Register an emitter. Nothing plays until `update` runs. */
  add(spec: EmitterSpec): void {
    this.emitters.push({ ...spec, voice: null, distance: Number.POSITIVE_INFINITY });
    this.repickIn = 0;
  }

  get count(): number {
    return this.emitters.length;
  }

  get playing(): number {
    let n = 0;
    for (const e of this.emitters) if (e.voice?.isPlaying()) n += 1;
    return n;
  }

  /** Distance to the closest registered emitter as of the last re-pick, or null. */
  get nearest(): number | null {
    let best: number | null = null;
    for (const e of this.emitters) if (best === null || e.distance < best) best = e.distance;
    return best === null || !Number.isFinite(best) ? null : best;
  }

  update(dt: number, listener: Vec3): void {
    this.repickIn -= dt;
    if (this.repickIn > 0 || this.emitters.length === 0) return;
    this.repickIn = this.repickSeconds;
    for (const e of this.emitters) {
      const dx = e.position.x - listener.x;
      const dy = e.position.y - listener.y;
      const dz = e.position.z - listener.z;
      e.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const range = this.spatial.maxDistance ?? Number.POSITIVE_INFINITY;
    const sorted = [...this.emitters].sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i] as Emitter;
      const wanted = i < this.max && e.distance < range;
      if (wanted && !e.voice) {
        e.voice = this.sink.playAt(e.sound, e.position, { loop: true, spatial: this.spatial, pitch: e.pitch, volume: e.volume, fadeIn: this.fade });
      } else if (!wanted && e.voice) {
        e.voice.stop(this.fade);
        e.voice = null;
      }
    }
  }

  stopAll(fadeSeconds = 0.2): void {
    for (const e of this.emitters) {
      e.voice?.stop(fadeSeconds);
      e.voice = null;
    }
  }
}

export interface ScatterOptions {
  /** Seconds between plays, drawn uniformly. */
  readonly interval: readonly [number, number];
  /** Radius band around the listener for a positioned scatter; omit for a flat one-shot. */
  readonly radius?: readonly [number, number] | undefined;
  /** Height of positioned plays (world Y). Default: the listener's height. */
  readonly y?: number | undefined;
  readonly spatial?: SpatialOptions | undefined;
  /** Seconds before the first play. Default: one interval. */
  readonly initialDelay?: number | undefined;
}

export class Scatter {
  private nextIn: number;

  constructor(
    private readonly sink: SoundSink,
    private readonly sound: string,
    private readonly options: ScatterOptions,
    private readonly random: Random,
  ) {
    this.nextIn = options.initialDelay ?? random.range(options.interval[0], options.interval[1]);
  }

  update(dt: number, listener: Vec3): void {
    this.nextIn -= dt;
    if (this.nextIn > 0) return;
    this.nextIn = this.random.range(this.options.interval[0], this.options.interval[1]);
    if (!this.options.radius) {
      this.sink.play(this.sound);
      return;
    }
    const angle = this.random.range(0, Math.PI * 2);
    const r = this.random.range(this.options.radius[0], this.options.radius[1]);
    this.sink.playAt(this.sound, { x: listener.x + Math.cos(angle) * r, y: this.options.y ?? listener.y, z: listener.z + Math.sin(angle) * r }, { spatial: this.options.spatial });
  }
}
