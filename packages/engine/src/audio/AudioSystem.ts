import type * as THREE from 'three/webgpu';
import type { AnimationWorld } from '../animation/Animator';
import type { Disposable } from '../core/Disposable';
import { Logger } from '../core/Logger';
import { Random } from '../core/Random';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import type { System } from '../ecs/System';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { BUS_NAMES, DEFAULT_MAX_VOICES, busGain, clamp01, type BusName, type BusState } from './Buses';
import { MusicPlayer } from './MusicPlayer';
import { resolveSoundDefinition, varyPitch, varyVolume, SoundGate, type ResolvedSound, type SoundDefinition } from './SoundDefinition';
import { resolveSpatial, type SpatialOptions } from './Spatial';
import { DeadVoice, LiveVoice, PendingVoice, type Voice } from './Voice';
import { VoicePool } from './VoicePool';
import { bindAnimationEvents, bindPhysicsEvents, type AnimationBindingOptions, type PhysicsBindingOptions, type PhysicsEventName } from './bindings';

export type { Voice } from './Voice';

export interface SoundPlayOptions {
  /** Override the sound's bus. */
  readonly bus?: BusName | undefined;
  /** Gain multiplier on the sound's base volume. Default 1. */
  readonly volume?: number | undefined;
  /** Playback-rate multiplier on top of the sound's seeded variance. Default 1. */
  readonly pitch?: number | undefined;
  readonly loop?: boolean | undefined;
  readonly loopStart?: number | undefined;
  readonly loopEnd?: number | undefined;
  /** Seconds before the voice starts. Default 0. */
  readonly delay?: number | undefined;
  /** Seconds to fade in. Default 0. */
  readonly fadeIn?: number | undefined;
  /** Steal priority override (see VoicePool). */
  readonly priority?: number | undefined;
}

export interface SoundPlayAtOptions extends SoundPlayOptions {
  readonly spatial?: SpatialOptions | undefined;
}

export type AudioContextStateName = 'unavailable' | 'locked' | AudioContextState;

export interface AudioStats {
  /** `locked`: no context yet (waiting for a gesture); `unavailable`: no WebAudio in this environment. */
  readonly state: AudioContextStateName;
  readonly unlocked: boolean;
  readonly sampleRate: number;
  readonly masterVolume: number;
  readonly buses: Readonly<Record<BusName, BusState>>;
  readonly activeVoices: number;
  readonly pendingLoops: number;
  readonly spatialVoices: number;
  readonly loadedBuffers: number;
  readonly sounds: number;
  /** One-shots refused because the context was still locked. */
  readonly droppedBeforeUnlock: number;
  /** Starts refused by cooldown / instance caps. */
  readonly gated: number;
  /** Voices evicted by the steal policy. */
  readonly stolen: number;
  readonly music: ReturnType<MusicPlayer['stats']>;
  readonly ambience: ReturnType<MusicPlayer['stats']>;
  readonly listener: { x: number; y: number; z: number } | null;
}

export interface AudioSystemOptions {
  /** The entity world spatial voices read Transforms from. */
  readonly entities: EntityWorld;
  /** Seed for the system's own variance stream (independent of scene randomness). */
  readonly seed: number;
  /** Fallback listener camera when a scene has not called `setListenerCamera()`. */
  readonly camera?: (() => THREE.Camera | null) | undefined;
  readonly maxVoices?: Partial<Readonly<Record<BusName, number>>> | undefined;
  readonly logger?: Logger | undefined;
}

interface SoundEntry {
  readonly def: ResolvedSound;
  buffer: AudioBuffer | null;
  readonly gate: SoundGate;
}

interface BufferEntry {
  buffer: AudioBuffer | null;
  promise: Promise<AudioBuffer>;
  refs: number;
}

interface PendingLoop {
  readonly handle: PendingVoice;
  readonly sound: string;
  readonly options: SoundPlayAtOptions;
  readonly target: Entity | { x: number; y: number; z: number } | null;
}

type Vec3 = { x: number; y: number; z: number };

const AUDIO_ORDER = { listener: 1100 } as const;

/**
 * The engine audio subsystem (`engine.audio`). One lazily created
 * `AudioContext` (browsers refuse to start one before a gesture and log a
 * warning if you try), a bus graph `master → limiter → destination` with
 * `music | sfx | ui | ambience` feeding master, a capped voice pool, spatial
 * voices following entities, and a listener following the active camera.
 *
 * Before the context exists: loops (`loop: true`, music, ambience) are queued
 * and start on unlock; one-shots are dropped and counted. Buffers can still be
 * decoded (through an OfflineAudioContext) so everything is ready on unlock.
 */
export class AudioSystem implements Disposable {
  readonly music: MusicPlayer;
  readonly ambience: MusicPlayer;

  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private readonly busNodes = new Map<BusName, GainNode>();
  private readonly buses: Record<BusName, BusState>;
  private masterVolume = 1;

  private readonly sounds = new Map<string, SoundEntry>();
  private readonly buffers = new Map<string, BufferEntry>();
  private readonly pool: VoicePool;
  private readonly live = new Map<number, LiveVoice>();
  private readonly pending: PendingLoop[] = [];
  private readonly attached = new Map<Voice, Entity>();
  private readonly gates = new Map<number, SoundGate>();
  private readonly entities: EntityWorld;
  private readonly random: Random;
  private readonly log: Logger;
  private readonly cameraProvider: () => THREE.Camera | null;
  private listenerCamera: THREE.Camera | null = null;
  private readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private hasListener = false;
  private gestureTarget: EventTarget | null = null;
  private dropped = 0;
  private gated = 0;
  private disposed = false;
  private resuming: Promise<AudioContextStateName> | null = null;

  constructor(options: AudioSystemOptions) {
    this.entities = options.entities;
    this.random = new Random(options.seed);
    this.log = options.logger ?? new Logger('audio');
    this.cameraProvider = options.camera ?? (() => null);
    const caps = { ...DEFAULT_MAX_VOICES, ...options.maxVoices };
    this.pool = new VoicePool(caps);
    this.buses = Object.fromEntries(BUS_NAMES.map((b) => [b, { volume: 1, muted: false, voices: 0, maxVoices: caps[b] }])) as Record<BusName, BusState>;
    this.music = new MusicPlayer(this, 'music');
    this.ambience = new MusicPlayer(this, 'ambience');
  }

  // ---- context lifecycle -----------------------------------------------------

  /** The live context, or null until the first `resume()` / user gesture. */
  get audioContext(): AudioContext | null {
    return this.context;
  }

  get state(): AudioContextStateName {
    if (!hasWebAudio()) return 'unavailable';
    return this.context ? this.context.state : 'locked';
  }

  get unlocked(): boolean {
    return this.context?.state === 'running';
  }

  /**
   * Create the context if needed and resume it. Call from a user-gesture
   * handler; the engine also does this automatically on the first
   * pointerdown / keydown through `installGestureUnlock()`.
   */
  resume(): Promise<AudioContextStateName> {
    if (this.disposed) return Promise.resolve('closed');
    if (this.resuming) return this.resuming;
    const ctx = this.ensureContext();
    if (!ctx) return Promise.resolve('unavailable');
    this.resuming = ctx
      .resume()
      .then(() => {
        this.flushPending();
        return ctx.state as AudioContextStateName;
      })
      .catch((error: unknown) => {
        this.log.warn(`resume failed: ${error instanceof Error ? error.message : String(error)}`);
        return ctx.state as AudioContextStateName;
      })
      .finally(() => {
        this.resuming = null;
      });
    return this.resuming;
  }

  suspend(): Promise<void> {
    return this.context?.suspend() ?? Promise.resolve();
  }

  /** One-shot pointerdown/keydown listeners that unlock the context. Idempotent. */
  installGestureUnlock(target: EventTarget = window): void {
    if (this.gestureTarget || this.disposed) return;
    this.gestureTarget = target;
    target.addEventListener('pointerdown', this.onGesture, { passive: true });
    target.addEventListener('keydown', this.onGesture, { passive: true });
  }

  private readonly onGesture = (): void => {
    void this.resume().then((state) => {
      if (state === 'running') this.removeGestureListeners();
    });
  };

  private removeGestureListeners(): void {
    const target = this.gestureTarget;
    if (!target) return;
    this.gestureTarget = null;
    target.removeEventListener('pointerdown', this.onGesture);
    target.removeEventListener('keydown', this.onGesture);
  }

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    if (!hasWebAudio()) return null;
    const Ctor = (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    // A gentle limiter so stacked one-shots never clip the output.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter).connect(ctx.destination);
    for (const name of BUS_NAMES) {
      const node = ctx.createGain();
      const state = this.buses[name];
      node.gain.value = busGain(state.volume, state.muted);
      node.connect(master);
      this.busNodes.set(name, node);
    }
    this.context = ctx;
    this.masterGain = master;
    this.limiter = limiter;
    this.log.info(`context created (${ctx.sampleRate} Hz, state=${ctx.state})`);
    return ctx;
  }

  private flushPending(): void {
    if (!this.context || this.pending.length === 0) return;
    const queue = this.pending.splice(0, this.pending.length);
    for (const item of queue) {
      if (item.handle.isStopped) continue;
      const overrides = item.handle.overrides;
      const options: SoundPlayAtOptions = { ...item.options, loop: true };
      const target = overrides.position ?? item.target;
      const voice = target === null ? this.startVoice(item.sound, options, null, null) : this.startVoice(item.sound, options, target, options.spatial ?? {});
      if (voice instanceof LiveVoice) {
        item.handle.bind(voice);
        if (typeof target === 'number') this.attached.set(voice, target);
      } else {
        item.handle.stop();
      }
    }
  }

  // ---- buses -----------------------------------------------------------------

  setMasterVolume(volume: number): void {
    this.masterVolume = clamp01(volume);
    if (this.masterGain && this.context) this.masterGain.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.02);
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  setVolume(bus: BusName, volume: number): void {
    const state = this.bus(bus);
    state.volume = clamp01(volume);
    this.applyBusGain(bus);
  }

  getVolume(bus: BusName): number {
    return this.bus(bus).volume;
  }

  mute(bus: BusName, muted = true): void {
    this.bus(bus).muted = muted;
    this.applyBusGain(bus);
  }

  isMuted(bus: BusName): boolean {
    return this.bus(bus).muted;
  }

  private bus(name: BusName): BusState {
    const state = this.buses[name];
    if (!state) throw new Error(`AudioSystem: unknown bus "${String(name)}"`);
    return state;
  }

  private applyBusGain(bus: BusName): void {
    const node = this.busNodes.get(bus);
    if (!node || !this.context) return;
    const state = this.buses[bus];
    node.gain.setTargetAtTime(busGain(state.volume, state.muted), this.context.currentTime, 0.02);
  }

  // ---- buffers ---------------------------------------------------------------

  /**
   * Fetch + decode an audio file. Cached and reference counted per URL;
   * `releaseBuffer(url)` gives the reference back. Decoding works before the
   * context is unlocked (an OfflineAudioContext decodes when needed).
   */
  loadBuffer(url: string): Promise<AudioBuffer> {
    if (this.disposed) return Promise.reject(new Error('AudioSystem: load after dispose'));
    const existing = this.buffers.get(url);
    if (existing) {
      existing.refs += 1;
      return existing.promise;
    }
    const entry: BufferEntry = { buffer: null, promise: Promise.resolve(null as unknown as AudioBuffer), refs: 1 };
    entry.promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.arrayBuffer();
      })
      .then((bytes) => this.decode(bytes))
      .then((buffer) => {
        entry.buffer = buffer;
        return buffer;
      })
      .catch((error: unknown) => {
        this.buffers.delete(url);
        this.log.error(`failed to load ${url}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      });
    this.buffers.set(url, entry);
    return entry.promise;
  }

  releaseBuffer(url: string): boolean {
    const entry = this.buffers.get(url);
    if (!entry) return false;
    entry.refs -= 1;
    if (entry.refs <= 0) this.buffers.delete(url);
    return true;
  }

  /** Register an already-decoded buffer under a URL-like key (procedural placeholders). */
  registerBuffer(key: string, buffer: AudioBuffer): void {
    const existing = this.buffers.get(key);
    if (existing) {
      existing.refs += 1;
      existing.buffer = buffer;
      return;
    }
    this.buffers.set(key, { buffer, promise: Promise.resolve(buffer), refs: 1 });
  }

  getBuffer(key: string): AudioBuffer | null {
    return this.buffers.get(key)?.buffer ?? null;
  }

  private decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    const ctx: BaseAudioContext | null = this.context ?? offlineDecoder();
    if (!ctx) return Promise.reject(new Error('AudioSystem: no decoder available'));
    return ctx.decodeAudioData(bytes);
  }

  // ---- sounds ----------------------------------------------------------------

  /**
   * Declare a sound by name. `url` sounds start decoding immediately and can be
   * played once the buffer lands; `buffer` sounds are playable at once.
   */
  defineSound(definition: SoundDefinition): ResolvedSound {
    if (this.disposed) throw new Error('AudioSystem: defineSound after dispose');
    const def = resolveSoundDefinition(definition);
    this.undefineSound(def.name);
    const entry: SoundEntry = { def, buffer: definition.buffer ?? null, gate: new SoundGate(def.cooldownMs, def.maxInstances) };
    this.sounds.set(def.name, entry);
    // Inline buffers live in the cache under the sound name so stats / getBuffer see them.
    if (definition.buffer) this.registerBuffer(def.name, definition.buffer);
    if (def.url) {
      void this.loadBuffer(def.url).then(
        (buffer) => {
          if (this.sounds.get(def.name) === entry) entry.buffer = buffer;
        },
        () => {
          // Logged by loadBuffer; the sound simply never becomes playable.
        },
      );
    }
    return def;
  }

  undefineSound(name: string): boolean {
    const entry = this.sounds.get(name);
    if (!entry) return false;
    this.sounds.delete(name);
    this.releaseBuffer(entry.def.url ?? name);
    return true;
  }

  hasSound(name: string): boolean {
    return this.sounds.has(name);
  }

  /** True once the sound's buffer is decoded (placeholders: immediately). */
  isSoundReady(name: string): boolean {
    return this.sounds.get(name)?.buffer !== null && this.sounds.has(name);
  }

  // ---- playback ----------------------------------------------------------------

  /** Play a defined sound (by name, or an inline definition registered on the fly). */
  play(sound: string | SoundDefinition, options: SoundPlayOptions = {}): Voice {
    const name = typeof sound === 'string' ? sound : this.defineSound(sound).name;
    return this.startOrQueue(name, options, null);
  }

  /** Play a sound in the world, at an entity's Transform (following it) or a fixed position. */
  playAt(sound: string | SoundDefinition, target: Entity | Vec3, options: SoundPlayAtOptions = {}): Voice {
    const name = typeof sound === 'string' ? sound : this.defineSound(sound).name;
    return this.startOrQueue(name, options, target);
  }

  /** Stop every voice (optionally fading), including queued loops. */
  stopAll(fadeSeconds = 0): void {
    for (const item of this.pending) item.handle.stop();
    this.pending.length = 0;
    for (const voice of [...this.live.values()]) voice.stop(fadeSeconds);
  }

  private startOrQueue(name: string, options: SoundPlayAtOptions, target: Entity | Vec3 | null): Voice {
    const entry = this.sounds.get(name);
    if (!entry) {
      this.log.warn(`play("${name}"): sound is not defined`);
      return new DeadVoice(options.bus ?? 'sfx', name);
    }
    const loop = options.loop ?? entry.def.loop;
    const bus = options.bus ?? entry.def.bus;
    if (!this.context || this.context.state !== 'running') {
      if (loop) {
        const handle = new PendingVoice(bus, name);
        this.pending.push({ handle, sound: name, options, target });
        return handle;
      }
      this.dropped += 1;
      return new DeadVoice(bus, name);
    }
    const spatial = target === null ? null : (options.spatial ?? {});
    const voice = this.startVoice(name, options, target, spatial);
    if (voice instanceof LiveVoice && typeof target === 'number') this.attached.set(voice, target);
    return voice;
  }

  private startVoice(name: string, options: SoundPlayAtOptions, target: Entity | Vec3 | null, spatial: SpatialOptions | null): Voice {
    const ctx = this.context;
    const entry = this.sounds.get(name);
    const bus = options.bus ?? entry?.def.bus ?? 'sfx';
    if (!ctx || !entry) return new DeadVoice(bus, name);
    if (!entry.buffer) {
      this.log.debug(`play("${name}"): buffer not decoded yet`);
      return new DeadVoice(bus, name);
    }
    if (!entry.gate.tryStart(performance.now())) {
      this.gated += 1;
      return new DeadVoice(bus, name);
    }
    const loop = options.loop ?? entry.def.loop;
    const priority = options.priority ?? (loop && entry.def.priority === 0 ? 10 : entry.def.priority);
    const { slot, steal } = this.pool.allocate(bus, priority);
    if (steal) this.live.get(steal.id)?.stop(0.02);
    if (!slot) {
      entry.gate.end();
      return new DeadVoice(bus, name);
    }
    const destination = this.busNodes.get(bus);
    if (!destination) {
      this.pool.release(slot.id);
      entry.gate.end();
      return new DeadVoice(bus, name);
    }
    let position: Vec3 | null = null;
    if (typeof target === 'number') position = this.entityPosition(target);
    else if (target) position = target;
    const voice = new LiveVoice(
      slot.id,
      bus,
      name,
      ctx,
      destination,
      {
        buffer: entry.buffer,
        bus,
        volume: varyVolume(this.random, entry.def.volume, entry.def.volumeVariance) * (options.volume ?? 1),
        rate: varyPitch(this.random, options.pitch ?? 1, entry.def.pitchVariance),
        loop,
        loopStart: options.loopStart,
        loopEnd: options.loopEnd,
        delay: Math.max(0, options.delay ?? 0),
        fadeIn: Math.max(0, options.fadeIn ?? 0),
        spatial: spatial ? resolveSpatial(spatial) : null,
        position,
      },
      (ended) => this.onVoiceEnded(ended),
    );
    this.live.set(slot.id, voice);
    this.gates.set(slot.id, entry.gate);
    this.buses[bus].voices = this.pool.countOn(bus);
    return voice;
  }

  private onVoiceEnded(voice: LiveVoice): void {
    this.pool.release(voice.id);
    this.live.delete(voice.id);
    this.attached.delete(voice);
    this.gates.get(voice.id)?.end();
    this.gates.delete(voice.id);
    this.buses[voice.bus].voices = this.pool.countOn(voice.bus);
  }

  private entityPosition(eid: Entity): Vec3 | null {
    const world = this.entities;
    if (!world.exists(eid) || !world.has(eid, Transform)) return null;
    const t = world.store(Transform);
    return { x: t.x[eid] ?? 0, y: t.y[eid] ?? 0, z: t.z[eid] ?? 0 };
  }

  // ---- listener / per-frame --------------------------------------------------------

  /** The camera the listener follows. Scenes with their own rig call this; otherwise the engine's live scene camera is used. */
  setListenerCamera(camera: THREE.Camera | null): void {
    this.listenerCamera = camera;
  }

  /** Late-stage system: listener ← camera, spatial voices ← entity Transforms. */
  update(world: EntityWorld = this.entities): void {
    if (this.disposed) return;
    const camera = this.listenerCamera ?? this.cameraProvider();
    const ctx = this.context;
    if (camera) {
      camera.updateMatrixWorld();
      const m = camera.matrixWorld.elements;
      this.listenerPos.x = m[12] ?? 0;
      this.listenerPos.y = m[13] ?? 0;
      this.listenerPos.z = m[14] ?? 0;
      this.hasListener = true;
      if (ctx) {
        const listener = ctx.listener;
        // Camera looks down local −Z; up is local +Y.
        const fx = -(m[8] ?? 0);
        const fy = -(m[9] ?? 0);
        const fz = -(m[10] ?? 1);
        const ux = m[4] ?? 0;
        const uy = m[5] ?? 1;
        const uz = m[6] ?? 0;
        if (listener.positionX) {
          listener.positionX.value = this.listenerPos.x;
          listener.positionY.value = this.listenerPos.y;
          listener.positionZ.value = this.listenerPos.z;
          listener.forwardX.value = fx;
          listener.forwardY.value = fy;
          listener.forwardZ.value = fz;
          listener.upX.value = ux;
          listener.upY.value = uy;
          listener.upZ.value = uz;
        } else {
          listener.setPosition(this.listenerPos.x, this.listenerPos.y, this.listenerPos.z);
          listener.setOrientation(fx, fy, fz, ux, uy, uz);
        }
      }
    }
    if (this.attached.size === 0) return;
    const t = world.store(Transform);
    for (const [voice, eid] of this.attached) {
      if (!world.exists(eid)) {
        voice.stop(0.05);
        this.attached.delete(voice);
        continue;
      }
      voice.setPosition(t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0);
    }
  }

  /** The system that drives `update()` each frame; the engine registers it. */
  createSystems(): readonly System[] {
    return [
      {
        name: 'AudioListenerSystem',
        stage: 'late',
        order: AUDIO_ORDER.listener,
        run: (world) => this.update(world),
      },
    ];
  }

  // ---- event hooks ---------------------------------------------------------------

  /** `{ footstep: 'placeholder-footstep' }` → every footstep marker plays spatially at its entity. */
  bindAnimationEvents(animation: AnimationWorld, map: Readonly<Record<string, string>>, options?: AnimationBindingOptions): () => void {
    return bindAnimationEvents(this, animation, map, options);
  }

  /** `{ collisionStart: 'placeholder-impact' }` with a relative-speed threshold. */
  bindPhysicsEvents(physics: PhysicsWorld, map: Partial<Readonly<Record<PhysicsEventName, string>>>, options?: PhysicsBindingOptions): () => void {
    return bindPhysicsEvents(this, physics, map, options);
  }

  // ---- stats / teardown ------------------------------------------------------------

  stats(): AudioStats {
    let spatial = 0;
    for (const voice of this.live.values()) if (this.attached.has(voice)) spatial += 1;
    let loaded = 0;
    for (const entry of this.buffers.values()) if (entry.buffer) loaded += 1;
    const buses = Object.fromEntries(BUS_NAMES.map((b) => [b, { ...this.buses[b], voices: this.pool.countOn(b) }])) as Record<BusName, BusState>;
    return {
      state: this.state,
      unlocked: this.unlocked,
      sampleRate: this.context?.sampleRate ?? 0,
      masterVolume: this.masterVolume,
      buses,
      activeVoices: this.live.size,
      pendingLoops: this.pending.length,
      spatialVoices: spatial,
      loadedBuffers: loaded,
      sounds: this.sounds.size,
      droppedBeforeUnlock: this.dropped,
      gated: this.gated,
      stolen: this.pool.stolenCount,
      music: this.music.stats(),
      ambience: this.ambience.stats(),
      listener: this.hasListener ? { ...this.listenerPos } : null,
    };
  }

  /** Number of WebAudio nodes the system holds (graph sanity in probes). */
  nodeCount(): number {
    if (!this.context) return 0;
    // master + limiter + buses; each live voice is source + gain (+ panner).
    let n = 2 + this.busNodes.size;
    for (const voice of this.live.values()) n += this.attached.has(voice) ? 3 : 2;
    return n;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeGestureListeners();
    this.music.dispose();
    this.ambience.dispose();
    this.stopAll(0);
    this.live.clear();
    this.attached.clear();
    this.gates.clear();
    this.pool.clear();
    this.sounds.clear();
    this.buffers.clear();
    for (const node of this.busNodes.values()) node.disconnect();
    this.busNodes.clear();
    this.masterGain?.disconnect();
    this.limiter?.disconnect();
    this.masterGain = null;
    this.limiter = null;
    const ctx = this.context;
    this.context = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    this.log.info('disposed');
  }
}

export { AUDIO_ORDER };
export type { AnimationBindingOptions, PhysicsBindingOptions, PhysicsEventName };

function hasWebAudio(): boolean {
  const g = globalThis as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  return typeof g.AudioContext === 'function' || typeof g.webkitAudioContext === 'function';
}

let decoder: OfflineAudioContext | null = null;

/** A tiny offline context used only for `decodeAudioData` before the real context exists. */
function offlineDecoder(): OfflineAudioContext | null {
  if (decoder) return decoder;
  const g = globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) return null;
  decoder = new Ctor(1, 1, 44_100);
  return decoder;
}
