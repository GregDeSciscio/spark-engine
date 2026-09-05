import type { BusName } from './Buses';
import type { ResolvedSpatial } from './Spatial';

/** What `play()` / `playAt()` hand back. Safe to keep after the voice ends; every method is a no-op then. */
export interface Voice {
  readonly id: number;
  readonly bus: BusName;
  readonly sound: string;
  /** True while the voice is waiting for the AudioContext to be unlocked (loops only). */
  readonly pending: boolean;
  isPlaying(): boolean;
  /** Stop, with an optional linear fade in seconds. */
  stop(fadeSeconds?: number): void;
  /** Voice gain (linear) on top of the sound's base volume. */
  setVolume(volume: number, rampSeconds?: number): void;
  /** Playback rate multiplier. */
  setPitch(rate: number, rampSeconds?: number): void;
  /** Move a spatial voice. Non-spatial voices ignore it. */
  setPosition(x: number, y: number, z: number): void;
}

export interface VoiceStartOptions {
  readonly buffer: AudioBuffer;
  readonly bus: BusName;
  readonly volume: number;
  readonly rate: number;
  readonly loop: boolean;
  readonly loopStart?: number | undefined;
  readonly loopEnd?: number | undefined;
  /** Seconds of context time to wait before starting. */
  readonly delay: number;
  readonly fadeIn: number;
  readonly spatial: ResolvedSpatial | null;
  readonly position: { x: number; y: number; z: number } | null;
}

/**
 * One playing sound: `AudioBufferSourceNode → GainNode [→ PannerNode] → bus`.
 * The system owns the pool slot and calls `onEnded` to release it.
 */
export class LiveVoice implements Voice {
  readonly pending = false;
  private readonly source: AudioBufferSourceNode;
  private readonly gain: GainNode;
  private readonly panner: PannerNode | null;
  /** Whether this voice plays through a panner (at an entity or a fixed point). */
  get isSpatial(): boolean {
    return this.panner !== null;
  }
  private readonly context: BaseAudioContext;
  private playing = true;
  private ended = false;

  constructor(
    readonly id: number,
    readonly bus: BusName,
    readonly sound: string,
    context: BaseAudioContext,
    destination: AudioNode,
    options: VoiceStartOptions,
    private readonly onEnded: (voice: LiveVoice) => void,
  ) {
    this.context = context;
    this.source = context.createBufferSource();
    this.source.buffer = options.buffer;
    this.source.loop = options.loop;
    if (options.loop) {
      if (options.loopStart !== undefined) this.source.loopStart = options.loopStart;
      if (options.loopEnd !== undefined) this.source.loopEnd = options.loopEnd;
    }
    this.source.playbackRate.value = options.rate;
    this.gain = context.createGain();
    const now = context.currentTime;
    if (options.fadeIn > 0) {
      this.gain.gain.setValueAtTime(0, now + options.delay);
      this.gain.gain.linearRampToValueAtTime(options.volume, now + options.delay + options.fadeIn);
    } else {
      this.gain.gain.value = options.volume;
    }
    this.source.connect(this.gain);
    if (options.spatial) {
      const panner = context.createPanner();
      panner.panningModel = options.spatial.hrtf ? 'HRTF' : 'equalpower';
      panner.distanceModel = options.spatial.distanceModel;
      panner.refDistance = options.spatial.refDistance;
      panner.rolloffFactor = options.spatial.rolloff;
      panner.maxDistance = options.spatial.maxDistance;
      this.panner = panner;
      this.gain.connect(panner);
      panner.connect(destination);
      if (options.position) this.setPosition(options.position.x, options.position.y, options.position.z);
    } else {
      this.panner = null;
      this.gain.connect(destination);
    }
    this.source.onended = () => this.finish();
    this.source.start(now + options.delay);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  stop(fadeSeconds = 0): void {
    if (!this.playing) return;
    this.playing = false;
    const now = this.context.currentTime;
    if (fadeSeconds > 0) {
      const g = this.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fadeSeconds);
      try {
        this.source.stop(now + fadeSeconds);
      } catch {
        this.finish();
      }
    } else {
      try {
        this.source.stop();
      } catch {
        // Not started yet (delayed start) or already stopped: fall through to release.
      }
      this.finish();
    }
  }

  setVolume(volume: number, rampSeconds = 0): void {
    if (this.ended) return;
    const g = this.gain.gain;
    const now = this.context.currentTime;
    const v = Math.max(0, volume);
    if (rampSeconds > 0) {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(v, now + rampSeconds);
    } else {
      g.value = v;
    }
  }

  setPitch(rate: number, rampSeconds = 0): void {
    if (this.ended) return;
    const p = this.source.playbackRate;
    const r = Math.max(0.01, rate);
    if (rampSeconds > 0) {
      const now = this.context.currentTime;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(r, now + rampSeconds);
    } else {
      p.value = r;
    }
  }

  setPosition(x: number, y: number, z: number): void {
    const panner = this.panner;
    if (!panner || this.ended) return;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else {
      panner.setPosition(x, y, z);
    }
  }

  /** Current gain value (for stats / tests). */
  get volume(): number {
    return this.gain.gain.value;
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.playing = false;
    this.source.onended = null;
    try {
      this.source.disconnect();
      this.gain.disconnect();
      this.panner?.disconnect();
    } catch {
      // Already disconnected.
    }
    this.onEnded(this);
  }
}

/** A voice handle for something that could not start (before unlock, refused by a gate, or a cap). */
export class DeadVoice implements Voice {
  readonly id = 0;
  readonly pending = false;
  constructor(
    readonly bus: BusName,
    readonly sound: string,
  ) {}
  isPlaying(): boolean {
    return false;
  }
  stop(): void {}
  setVolume(): void {}
  setPitch(): void {}
  setPosition(): void {}
}

/**
 * A loop requested before the AudioContext exists. Records the settings it was
 * asked for and forwards to the live voice once `bind()` is called on unlock.
 */
export class PendingVoice implements Voice {
  readonly id = 0;
  private live: Voice | null = null;
  private stopped = false;
  private volume: number | null = null;
  private rate: number | null = null;
  private position: { x: number; y: number; z: number } | null = null;

  constructor(
    readonly bus: BusName,
    readonly sound: string,
  ) {}

  get pending(): boolean {
    return this.live === null && !this.stopped;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get overrides(): { volume: number | null; rate: number | null; position: { x: number; y: number; z: number } | null } {
    return { volume: this.volume, rate: this.rate, position: this.position };
  }

  bind(live: Voice): void {
    this.live = live;
    if (this.volume !== null) live.setVolume(this.volume);
    if (this.rate !== null) live.setPitch(this.rate);
    if (this.position) live.setPosition(this.position.x, this.position.y, this.position.z);
  }

  isPlaying(): boolean {
    return this.live ? this.live.isPlaying() : !this.stopped;
  }

  stop(fadeSeconds?: number): void {
    this.stopped = true;
    this.live?.stop(fadeSeconds);
  }

  setVolume(volume: number, rampSeconds?: number): void {
    this.volume = volume;
    this.live?.setVolume(volume, rampSeconds);
  }

  setPitch(rate: number, rampSeconds?: number): void {
    this.rate = rate;
    this.live?.setPitch(rate, rampSeconds);
  }

  setPosition(x: number, y: number, z: number): void {
    if (this.position) {
      this.position.x = x;
      this.position.y = y;
      this.position.z = z;
    } else {
      this.position = { x, y, z };
    }
    this.live?.setPosition(x, y, z);
  }
}
