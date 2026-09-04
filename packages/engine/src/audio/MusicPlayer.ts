import type { BusName } from './Buses';
import { intensityGain } from './Crossfade';
import type { Voice } from './Voice';

/** A track: one loop, or a base loop plus an intensity stem started in lockstep. */
export interface MusicTrack {
  readonly base: string;
  /** Optional stem faded in by `setIntensity()`; must have the same length as `base` to stay aligned. */
  readonly layer?: string | undefined;
}

export interface MusicPlayOptions {
  /** Seconds to fade the new track in. Default 1. */
  readonly fadeIn?: number | undefined;
  /** Seconds to fade the previous track out. Default = fadeIn. */
  readonly crossfade?: number | undefined;
  readonly loop?: boolean | undefined;
  readonly loopStart?: number | undefined;
  readonly loopEnd?: number | undefined;
  /** Track gain, linear. Default 1. */
  readonly volume?: number | undefined;
}

export interface MusicPlayerStats {
  readonly current: string | null;
  readonly intensity: number;
  readonly layered: boolean;
  readonly fadingOut: number;
}

/** What the player needs from the system: a way to start looping voices on its bus. */
export interface MusicVoiceSource {
  play(sound: string, options: { bus: BusName; loop: boolean; loopStart?: number | undefined; loopEnd?: number | undefined; volume: number; fadeIn: number; priority: number }): Voice;
}

interface Playing {
  readonly name: string;
  readonly base: Voice;
  readonly layer: Voice | null;
  volume: number;
}

/**
 * Track playback for the `music` and `ambience` buses: play with fade-in,
 * crossfade to the next track, and blend an intensity stem (equal-power) so
 * gameplay can raise the energy without a cut. One instance per bus.
 */
export class MusicPlayer {
  private current: Playing | null = null;
  private readonly fading = new Set<Voice>();
  private intensity = 0;

  constructor(
    private readonly source: MusicVoiceSource,
    readonly bus: BusName,
  ) {}

  get currentTrack(): string | null {
    return this.current?.name ?? null;
  }

  get currentIntensity(): number {
    return this.intensity;
  }

  /** Start a track. If one is playing it crossfades out. Re-playing the current track is a no-op. */
  play(track: string | MusicTrack, options: MusicPlayOptions = {}): void {
    const def: MusicTrack = typeof track === 'string' ? { base: track } : track;
    const name = def.layer ? `${def.base}+${def.layer}` : def.base;
    if (this.current?.name === name) return;
    const fadeIn = options.fadeIn ?? 1;
    const crossfade = options.crossfade ?? fadeIn;
    this.fadeOutCurrent(crossfade);
    const volume = options.volume ?? 1;
    const loop = options.loop ?? true;
    const common = { bus: this.bus, loop, loopStart: options.loopStart, loopEnd: options.loopEnd, fadeIn, priority: 20 };
    const base = this.source.play(def.base, { ...common, volume });
    let layer: Voice | null = null;
    if (def.layer) {
      layer = this.source.play(def.layer, { ...common, volume: volume * intensityGain(this.intensity) });
    }
    this.current = { name, base, layer, volume };
  }

  /** Blend the intensity stem in (1) or out (0). Equal-power, so the base never has to duck. */
  setIntensity(value: number, rampSeconds = 0.5): void {
    const v = value < 0 ? 0 : value > 1 ? 1 : value;
    if (v === this.intensity) return;
    this.intensity = v;
    const cur = this.current;
    if (cur?.layer) cur.layer.setVolume(cur.volume * intensityGain(v), rampSeconds);
  }

  setVolume(volume: number, rampSeconds = 0): void {
    const cur = this.current;
    if (!cur) return;
    cur.volume = Math.max(0, volume);
    cur.base.setVolume(cur.volume, rampSeconds);
    cur.layer?.setVolume(cur.volume * intensityGain(this.intensity), rampSeconds);
  }

  stop(fadeSeconds = 1): void {
    this.fadeOutCurrent(fadeSeconds);
  }

  isPlaying(): boolean {
    return this.current?.base.isPlaying() ?? false;
  }

  stats(): MusicPlayerStats {
    for (const v of this.fading) if (!v.isPlaying()) this.fading.delete(v);
    return { current: this.currentTrack, intensity: this.intensity, layered: this.current?.layer !== null && this.current !== null, fadingOut: this.fading.size };
  }

  dispose(): void {
    this.fadeOutCurrent(0);
    for (const v of this.fading) v.stop();
    this.fading.clear();
  }

  private fadeOutCurrent(seconds: number): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    for (const v of [cur.base, cur.layer]) {
      if (!v) continue;
      v.stop(seconds);
      if (seconds > 0) this.fading.add(v);
    }
  }
}
