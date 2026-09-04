import type { Random } from '../core/Random';
import { isBusName, type BusName } from './Buses';

/** How a sound is declared by a scene: a URL to decode, or a buffer already in hand. */
export interface SoundDefinition {
  readonly name: string;
  /** Decoded through the audio buffer cache. Mutually exclusive with `buffer`. */
  readonly url?: string | undefined;
  /** A pre-decoded buffer (procedural placeholders use this). */
  readonly buffer?: AudioBuffer | undefined;
  readonly bus?: BusName | undefined;
  /** Base gain, linear. Default 1. */
  readonly volume?: number | undefined;
  /** ± random gain variation, linear (0.2 → 0.8..1.2 × volume). Default 0. */
  readonly volumeVariance?: number | undefined;
  /** ± random playback-rate variation in semitones. Default 0. */
  readonly pitchVariance?: number | undefined;
  /** Minimum ms between two starts of this sound. Default 0. */
  readonly cooldownMs?: number | undefined;
  /** Simultaneous instances; a new start beyond this is refused. Default unlimited. */
  readonly maxInstances?: number | undefined;
  /** Default loop flag for `play()`. */
  readonly loop?: boolean | undefined;
  /** Steal priority within the bus (see VoicePool). Default 0; loops default 10. */
  readonly priority?: number | undefined;
}

export interface ResolvedSound {
  readonly name: string;
  readonly url: string | null;
  readonly bus: BusName;
  readonly volume: number;
  readonly volumeVariance: number;
  readonly pitchVariance: number;
  readonly cooldownMs: number;
  readonly maxInstances: number;
  readonly loop: boolean;
  readonly priority: number;
}

/** Validate and fill defaults. Throws with the offending field named. */
export function resolveSoundDefinition(def: SoundDefinition): ResolvedSound {
  if (!def.name) throw new Error('defineSound: name is required');
  if (!def.url && !def.buffer) throw new Error(`defineSound("${def.name}"): url or buffer is required`);
  if (def.url && def.buffer) throw new Error(`defineSound("${def.name}"): url and buffer are mutually exclusive`);
  const bus = def.bus ?? 'sfx';
  if (!isBusName(bus)) throw new Error(`defineSound("${def.name}"): unknown bus "${String(bus)}"`);
  const volume = def.volume ?? 1;
  if (!Number.isFinite(volume) || volume < 0) throw new Error(`defineSound("${def.name}"): volume must be >= 0`);
  const volumeVariance = def.volumeVariance ?? 0;
  if (!Number.isFinite(volumeVariance) || volumeVariance < 0 || volumeVariance > 1) {
    throw new Error(`defineSound("${def.name}"): volumeVariance must be in [0, 1]`);
  }
  const pitchVariance = def.pitchVariance ?? 0;
  if (!Number.isFinite(pitchVariance) || pitchVariance < 0) throw new Error(`defineSound("${def.name}"): pitchVariance must be >= 0`);
  const cooldownMs = def.cooldownMs ?? 0;
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error(`defineSound("${def.name}"): cooldownMs must be >= 0`);
  const maxInstances = def.maxInstances ?? Number.POSITIVE_INFINITY;
  if (Number.isNaN(maxInstances) || maxInstances < 1) throw new Error(`defineSound("${def.name}"): maxInstances must be >= 1`);
  const loop = def.loop ?? false;
  return {
    name: def.name,
    url: def.url ?? null,
    bus,
    volume,
    volumeVariance,
    pitchVariance,
    cooldownMs,
    maxInstances,
    loop,
    priority: def.priority ?? (loop ? 10 : 0),
  };
}

/** Semitones → playback-rate multiplier. */
export function semitonesToRate(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/** A seeded playback rate within ±`varianceSemitones` of `base`. */
export function varyPitch(random: Random, base: number, varianceSemitones: number): number {
  if (varianceSemitones <= 0) return base;
  return base * semitonesToRate(random.range(-varianceSemitones, varianceSemitones));
}

/** A seeded gain within ±`variance` (fraction of base) of `base`, never negative. */
export function varyVolume(random: Random, base: number, variance: number): number {
  if (variance <= 0) return base;
  return Math.max(0, base * (1 + random.range(-variance, variance)));
}

/**
 * Cooldown + instance-cap gate for one sound. Pure: time and instance counts
 * come from the caller, so it is testable and independent of the audio clock.
 */
export class SoundGate {
  private lastStartMs = Number.NEGATIVE_INFINITY;
  private instances = 0;
  private refused = 0;

  constructor(
    private readonly cooldownMs: number,
    private readonly maxInstances: number,
  ) {}

  get active(): number {
    return this.instances;
  }

  /** Starts refused by cooldown or cap (a stat). */
  get refusedCount(): number {
    return this.refused;
  }

  /** Try to start at `nowMs`. On success the instance count is taken; call `end()` when the voice finishes. */
  tryStart(nowMs: number): boolean {
    if (nowMs - this.lastStartMs < this.cooldownMs || this.instances >= this.maxInstances) {
      this.refused += 1;
      return false;
    }
    this.lastStartMs = nowMs;
    this.instances += 1;
    return true;
  }

  end(): void {
    this.instances = Math.max(0, this.instances - 1);
  }

  reset(): void {
    this.lastStartMs = Number.NEGATIVE_INFINITY;
    this.instances = 0;
  }
}
