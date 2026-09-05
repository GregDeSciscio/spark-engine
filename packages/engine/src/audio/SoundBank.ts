import type { Entity } from '../ecs/EntityWorld';
import type { Logger } from '../core/Logger';
import type { AudioSystem, SoundPlayAtOptions, Voice } from './AudioSystem';
import type { BusName } from './Buses';

/**
 * A bank of cues declared by a built manifest (`tools/audio/build.mjs` writes
 * one per game): every cue with files is defined on the audio system with its
 * round-robin variants; a cue without files is a silent no-op, logged once,
 * so a game runs the same before and after its takes exist. Dispose undefines
 * everything the bank defined.
 */
export interface SoundBankCue {
  readonly name: string;
  readonly bus?: BusName | undefined;
  readonly loop?: boolean | undefined;
  readonly volume?: number | undefined;
  readonly volumeVariance?: number | undefined;
  readonly pitchVariance?: number | undefined;
  readonly cooldownMs?: number | undefined;
  readonly maxInstances?: number | null | undefined;
  readonly priority?: number | undefined;
  readonly files: readonly { readonly url: string; readonly duration?: number | undefined }[];
}

export interface SoundBankManifest {
  readonly cues: readonly SoundBankCue[];
}

/** The subset of the audio system a bank (and the ambience helpers) play through. */
export interface SoundSink {
  play(sound: string, options?: SoundPlayAtOptions): Voice | null;
  playAt(sound: string, target: Entity | { x: number; y: number; z: number }, options?: SoundPlayAtOptions): Voice | null;
  has(sound: string): boolean;
}

export class SoundBank implements SoundSink {
  /** Cue names that have at least one file and are defined. */
  readonly available: ReadonlySet<string>;
  /** Cue names in the manifest with no files. */
  readonly missing: readonly string[];
  private readonly audio: AudioSystem;
  private readonly logger: Logger | null;
  private readonly skipped = new Set<string>();
  private disposed = false;

  constructor(audio: AudioSystem, manifest: SoundBankManifest | null, logger: Logger | null = null) {
    this.audio = audio;
    this.logger = logger;
    const available = new Set<string>();
    const missing: string[] = [];
    for (const cue of manifest?.cues ?? []) {
      if (cue.files.length === 0) {
        missing.push(cue.name);
        continue;
      }
      audio.defineSound({
        name: cue.name,
        urls: cue.files.map((f) => f.url),
        bus: cue.bus,
        volume: cue.volume,
        volumeVariance: cue.volumeVariance,
        pitchVariance: cue.pitchVariance,
        cooldownMs: cue.cooldownMs,
        maxInstances: cue.maxInstances ?? undefined,
        loop: cue.loop,
        priority: cue.priority,
      });
      available.add(cue.name);
    }
    this.available = available;
    this.missing = missing;
    if (logger) {
      if (missing.length > 0) logger.warn(`SoundBank: ${missing.length} cue(s) have no files: ${missing.join(', ')}`);
      logger.info(`SoundBank: ${available.size} cue(s) defined`);
    }
  }

  /**
   * Fetch a manifest and build the bank. A missing or unreadable manifest
   * gives an empty bank (every cue a no-op) and a warning, never a throw.
   */
  static async load(audio: AudioSystem, url: string, logger: Logger | null = null): Promise<SoundBank> {
    let manifest: SoundBankManifest | null = null;
    try {
      const res = await fetch(url);
      if (res.ok) manifest = (await res.json()) as SoundBankManifest;
      else logger?.warn(`SoundBank: no manifest at ${url} (${res.status}); the bank is empty`);
    } catch (error) {
      logger?.warn(`SoundBank: manifest fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new SoundBank(audio, manifest, logger);
  }

  has(name: string): boolean {
    return !this.disposed && this.available.has(name);
  }

  play(name: string, options?: SoundPlayAtOptions): Voice | null {
    if (!this.guard(name)) return null;
    return this.audio.play(name, options);
  }

  playAt(name: string, target: Entity | { x: number; y: number; z: number }, options?: SoundPlayAtOptions): Voice | null {
    if (!this.guard(name)) return null;
    return this.audio.playAt(name, target, options);
  }

  private guard(name: string): boolean {
    if (this.disposed) return false;
    if (this.available.has(name)) return true;
    if (!this.skipped.has(name)) {
      this.skipped.add(name);
      this.logger?.debug(`SoundBank: cue "${name}" has no files; skipped`);
    }
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const name of this.available) this.audio.undefineSound(name);
  }
}
