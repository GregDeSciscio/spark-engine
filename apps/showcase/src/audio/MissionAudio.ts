import type * as THREE from 'three/webgpu';
import {
  EmitterPool,
  Scatter,
  SoundBank,
  surfaceKindOf,
  type AnimationWorld,
  type AudioSystem,
  type Entity,
  type Logger,
  type Random,
  type SoundPlayAtOptions,
  type SpatialOptions,
  type Voice,
} from '@spark/engine';

/**
 * The mission's sound design at runtime (docs/audio/mission-sound-design.md).
 * The engine's `SoundBank` reads the built manifest and defines every cue that
 * has takes (cues without takes are silent no-ops); this layer is the game's
 * vocabulary on top of it: one verb per moment (`shot`, `impact`, `footstep`,
 * `bark`, `heartbeat`...), the bark groups, the distance crossfade for enemy
 * fire, and the ambience (beds, an `EmitterPool` of neon, lamp and steam
 * hums, `Scatter` timers for drips, thunder and drone passes).
 */
export interface MissionAudioDeps {
  readonly audio: AudioSystem;
  readonly animation: AnimationWorld;
  readonly random: Random;
  readonly logger: Logger;
}

export type ImpactSurface = 'concrete' | 'metal' | 'glass' | 'water';
export type BarkKind = 'suspicious' | 'alert' | 'search' | 'reload' | 'hit' | 'death';
export type FootstepKind = 'walk' | 'run' | 'sprint' | 'crouch' | 'land';

/** Spatial presets by role. */
const SPATIAL: Record<'gun' | 'gunFar' | 'body' | 'foot' | 'voice' | 'emitter' | 'drip', SpatialOptions> = {
  gun: { refDistance: 4, rolloff: 1, maxDistance: 90 },
  gunFar: { refDistance: 20, rolloff: 0.7, maxDistance: 200 },
  body: { refDistance: 2.5, rolloff: 1.1, maxDistance: 45 },
  foot: { refDistance: 2, rolloff: 1.3, maxDistance: 30 },
  voice: { refDistance: 4, rolloff: 1, maxDistance: 60 },
  emitter: { refDistance: 2, rolloff: 1.4, maxDistance: 30 },
  drip: { refDistance: 2, rolloff: 1.4, maxDistance: 18 },
};

/** Bark groups: the base name and its numbered siblings from the manifest. */
const BARKS: Record<BarkKind, readonly string[]> = {
  suspicious: ['bark-suspicious', 'bark-suspicious-2'],
  alert: ['bark-alert', 'bark-alert-2', 'bark-alert-3'],
  search: ['bark-search', 'bark-search-2'],
  reload: ['bark-reload'],
  hit: ['bark-hit'],
  death: ['bark-death'],
};

/** The enemy rifle: near and far layers crossfade over this distance band (metres). */
const SHOT_NEAR_FULL = 14;
const SHOT_NEAR_GONE = 55;
const SHOT_FAR_START = 8;
const SHOT_FAR_FULL = 40;
/** Point emitters: how many neon / lamp / steam hums sound at once. */
const MAX_EMITTERS = 8;
/** Low-health heartbeat comes in below this health fraction. */
const HEARTBEAT_BELOW = 0.35;

type Vec3 = { x: number; y: number; z: number };

export interface LightEmitters {
  readonly neon: readonly THREE.Vector3[];
  readonly lamps: readonly THREE.Vector3[];
}

export class MissionAudio {
  /** Cue names present in the manifest with at least one file. */
  readonly available: ReadonlySet<string>;
  private readonly deps: MissionAudioDeps;
  private readonly bank: SoundBank;
  private readonly emitters: EmitterPool;
  private readonly scatters: Scatter[] = [];
  private readonly beds: Voice[] = [];
  private heartbeat: Voice | null = null;
  private heartbeatLevel = 0;
  private plantLoop: Voice | null = null;
  /** Light emitters are read on the second frame: entity-driven lights only get their Object3D position from the render sync. */
  private pendingLights: (() => LightEmitters) | null = null;
  private framesSeen = 0;
  private unbindFootsteps: (() => void) | null = null;
  private readonly lastListener = { x: 0, y: 0, z: 0 };
  private disposed = false;

  private constructor(deps: MissionAudioDeps, bank: SoundBank) {
    this.deps = deps;
    this.bank = bank;
    this.available = bank.available;
    this.emitters = new EmitterPool(bank, { max: MAX_EMITTERS, repickSeconds: 1.5, spatial: SPATIAL.emitter });
  }

  /** Fetch the manifest and define its cues. A missing manifest yields a silent instance. */
  static async load(deps: MissionAudioDeps, url = '/audio/manifest.json'): Promise<MissionAudio> {
    const bank = await SoundBank.load(deps.audio, url, deps.logger);
    if (bank.missing.length > 0) deps.logger.warn('audio: takes are generated with pnpm audio:generate && pnpm audio:build');
    return new MissionAudio(deps, bank);
  }

  has(name: string): boolean {
    return this.bank.has(name);
  }

  /** What the ambience layer is doing, for probes. */
  stats(): { cues: number; beds: number; emitters: number; emittersPlaying: number; nearestEmitter: number | null; listener: number[]; heartbeat: boolean; plantLoop: boolean } {
    const nearest = this.emitters.nearest;
    return {
      cues: this.available.size,
      beds: this.beds.filter((b) => b.isPlaying()).length,
      emitters: this.emitters.count,
      emittersPlaying: this.emitters.playing,
      nearestEmitter: nearest === null ? null : Math.round(nearest * 10) / 10,
      listener: [this.lastListener.x, this.lastListener.y, this.lastListener.z].map((v) => Math.round(v * 10) / 10),
      heartbeat: this.heartbeat !== null,
      plantLoop: this.plantLoop !== null,
    };
  }

  /** Flat one-shot; a silent no-op for cues without takes. */
  play(name: string, options?: SoundPlayAtOptions): Voice | null {
    return this.disposed ? null : this.bank.play(name, options);
  }

  /** Spatial one-shot at an entity or a point. */
  playAt(name: string, target: Entity | Vec3, options?: SoundPlayAtOptions): Voice | null {
    return this.disposed ? null : this.bank.playAt(name, target, options);
  }

  // ---- weapons ---------------------------------------------------------------------

  /** The operator fired: the near shot at the muzzle, the street's slapback, a casing a beat later at the feet. */
  shot(eid: Entity, feet: Vec3): void {
    this.playAt('rifle-shot', eid, { spatial: SPATIAL.gun });
    this.play('rifle-tail');
    this.playAt('casing', { x: feet.x, y: feet.y + 0.05, z: feet.z }, { delay: 0.22 + this.deps.random.range(0, 0.12), spatial: SPATIAL.foot });
  }

  /** An enemy fired at `distance` metres from the listener: near and far layers crossfade with distance. */
  enemyShot(eid: Entity, distance: number): void {
    const near = clamp01(1 - (distance - SHOT_NEAR_FULL) / (SHOT_NEAR_GONE - SHOT_NEAR_FULL));
    const far = clamp01((distance - SHOT_FAR_START) / (SHOT_FAR_FULL - SHOT_FAR_START));
    if (near > 0.02) this.playAt('rifle-shot', eid, { spatial: SPATIAL.gun, volume: near });
    if (far > 0.02) this.playAt('rifle-distant', eid, { spatial: SPATIAL.gunFar, volume: far });
  }

  reload(eid: Entity, player: boolean): void {
    this.playAt('rifle-reload', eid, { spatial: SPATIAL.body, volume: player ? 1 : 0.7 });
  }

  empty(): void {
    this.play('rifle-empty');
  }

  /** Raising or lowering the rifle: the same foley, lowered a touch when coming down. */
  aim(raised: boolean): void {
    this.play('aim-in', { pitch: raised ? 1 : 0.9, volume: raised ? 1 : 0.7 });
  }

  // ---- impacts and bodies ----------------------------------------------------------------

  impact(point: Vec3, surface: ImpactSurface): void {
    this.playAt(`impact-${surface}`, point, { spatial: SPATIAL.body });
  }

  /** A round hit a body. */
  flesh(point: Vec3, head: boolean): void {
    this.playAt(head ? 'impact-head' : 'impact-flesh', point, { spatial: SPATIAL.body });
    this.playAt('blood-splatter', point, { spatial: SPATIAL.body, delay: 0.05, volume: head ? 1 : 0.7 });
  }

  /** A round passed close to the listener at `point`. */
  whiz(point: Vec3): void {
    this.playAt('whiz', point, { spatial: { refDistance: 1, rolloff: 1, maxDistance: 6 } });
  }

  bodyFall(point: Vec3): void {
    this.playAt('body-fall', point, { spatial: SPATIAL.body });
  }

  // ---- movement --------------------------------------------------------------------------

  /**
   * Route every `footstep` marker from every animator to a step sound by clip:
   * walk and crouch walk to the soft step, run and sprint to the hard one,
   * the landing clip to the landing thud. `loudness(eid)` scales per actor.
   */
  bindFootsteps(loudness: (eid: Entity) => number = () => 1): void {
    this.unbindFootsteps?.();
    this.unbindFootsteps = this.deps.animation.events.on('event', (event) => {
      if (event.name !== 'footstep') return;
      const kind = footstepKind(event.clip);
      if (!kind) return;
      this.footstep(event.eid, kind, loudness(event.eid));
    });
  }

  footstep(eid: Entity, kind: FootstepKind, volume = 1): void {
    switch (kind) {
      case 'walk':
        this.playAt('footstep-walk', eid, { spatial: SPATIAL.foot, volume });
        break;
      case 'crouch':
        this.playAt('footstep-walk', eid, { spatial: SPATIAL.foot, volume: volume * 0.5, pitch: 0.95 });
        break;
      case 'run':
        this.playAt('footstep-run', eid, { spatial: SPATIAL.foot, volume });
        break;
      case 'sprint':
        this.playAt('footstep-run', eid, { spatial: SPATIAL.foot, volume: volume * 1.2, pitch: 1.05 });
        break;
      case 'land':
        this.playAt('land', eid, { spatial: SPATIAL.foot, volume });
        break;
    }
  }

  /** Stance change: gear shifting. */
  gear(eid: Entity): void {
    this.playAt('gear-rustle', eid, { spatial: SPATIAL.foot });
  }

  // ---- the operator ----------------------------------------------------------------------

  hurt(): void {
    this.play('hurt');
  }

  playerDeath(): void {
    this.play('death-player');
    this.play('ui-failed', { delay: 0.9 });
    this.setHeartbeat(0);
  }

  /** Per-frame: the low-health heartbeat loop follows health below the threshold. */
  setHeartbeat(health01: number): void {
    const level = health01 < HEARTBEAT_BELOW && health01 > 0 ? 1 - health01 / HEARTBEAT_BELOW : 0;
    if (level > 0 && !this.heartbeat && this.has('heartbeat')) {
      this.heartbeat = this.bank.play('heartbeat', { loop: true, volume: 0, fadeIn: 0.2 });
    }
    if (!this.heartbeat) return;
    if (Math.abs(level - this.heartbeatLevel) > 0.01 || (level === 0 && this.heartbeatLevel !== 0)) {
      this.heartbeatLevel = level;
      this.heartbeat.setVolume(level * 0.85, 0.3);
      this.heartbeat.setPitch(1 + level * 0.25, 0.3);
    }
    if (level === 0) {
      this.heartbeat.stop(0.6);
      this.heartbeat = null;
    }
  }

  // ---- enemies --------------------------------------------------------------------------

  bark(eid: Entity, kind: BarkKind): void {
    const names = BARKS[kind].filter((n) => this.has(n));
    if (names.length === 0) return;
    this.playAt(this.deps.random.pick(names), eid, { spatial: SPATIAL.voice });
  }

  // ---- interface and objectives --------------------------------------------------------------

  hitmarker(head: boolean): void {
    this.play(head ? 'ui-headshot' : 'ui-hitmarker');
  }

  objectiveComplete(kind: 'reach' | 'plant' | 'eliminate', missionComplete: boolean): void {
    if (kind === 'plant') this.play('ui-plant-done');
    this.play('ui-objective', { delay: kind === 'plant' ? 0.6 : 0 });
    this.play('ui-checkpoint', { delay: 1.1 });
    if (missionComplete) this.play('ui-complete', { delay: 1.6 });
  }

  /** The plant hold: a loop while `progress` is between 0 and 1, its pitch rising with progress. */
  setPlantProgress(progress: number): void {
    const active = progress > 0 && progress < 1;
    if (active && !this.plantLoop && this.has('ui-plant-loop')) {
      this.plantLoop = this.bank.play('ui-plant-loop', { loop: true, fadeIn: 0.1 });
    }
    if (this.plantLoop) {
      if (active) this.plantLoop.setPitch(1 + progress * 0.35, 0.1);
      else {
        this.plantLoop.stop(0.15);
        this.plantLoop = null;
      }
    }
  }

  /** The first hostile going alert. */
  alertStinger(): void {
    this.play('ui-alert');
  }

  // ---- ambience ------------------------------------------------------------------------------

  /**
   * Start the beds, the scatter timers and the point emitters: neon signs hum,
   * street lamps get the same hum lower and quieter (a ballast), steam vents
   * hiss. `lights` is read on the second frame (see `pendingLights`).
   */
  startAmbience(emitters: { readonly lights: () => LightEmitters; readonly steam: readonly THREE.Vector3[] }): void {
    const { random } = this.deps;
    for (const bed of ['rain-bed', 'city-bed']) {
      const voice = this.bank.play(bed, { loop: true, fadeIn: 2.5 });
      if (voice) this.beds.push(voice);
    }
    for (const p of emitters.steam) this.emitters.add({ position: p, sound: 'steam-hiss', pitch: random.range(0.9, 1.1), volume: random.range(0.8, 1) });
    this.pendingLights = emitters.lights;
    this.framesSeen = 0;
    this.scatters.push(
      new Scatter(this.bank, 'drip', { interval: [0.7, 2.4], radius: [2, 9], y: 0.1, spatial: SPATIAL.drip, initialDelay: 1 }, random),
      new Scatter(this.bank, 'thunder', { interval: [28, 70], initialDelay: 20 }, random),
      new Scatter(this.bank, 'drone-pass', { interval: [45, 110], initialDelay: 35 }, random),
    );
  }

  private registerLights(): void {
    if (!this.pendingLights) return;
    const { random } = this.deps;
    const { neon, lamps } = this.pendingLights();
    this.pendingLights = null;
    for (const p of neon) this.emitters.add({ position: p, sound: 'neon-buzz', pitch: random.range(0.94, 1.06), volume: random.range(0.7, 1) });
    for (const p of lamps) this.emitters.add({ position: p, sound: 'neon-buzz', pitch: random.range(0.82, 0.9), volume: random.range(0.35, 0.5) });
  }

  /**
   * The level's static point lights as emitter positions: saturated colours
   * are neon signs, warm near-white ones are street lamps. Dim or unlit lights
   * (muzzle flashes at rest) are skipped.
   */
  static emittersFromScene(scene: THREE.Object3D): { neon: THREE.Vector3[]; lamps: THREE.Vector3[] } {
    const neon: THREE.Vector3[] = [];
    const lamps: THREE.Vector3[] = [];
    scene.traverse((o) => {
      const light = o as THREE.PointLight;
      if (!light.isPointLight || light.intensity < 5) return;
      const c = light.color;
      const saturation = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      const position = light.getWorldPosition(light.position.clone());
      (saturation > 0.5 ? neon : lamps).push(position);
    });
    return { neon, lamps };
  }

  /** Per-frame ambience housekeeping: emitter selection and the scatter timers. */
  update(dt: number, listener: Vec3): void {
    if (this.disposed) return;
    this.lastListener.x = listener.x;
    this.lastListener.y = listener.y;
    this.lastListener.z = listener.z;
    this.framesSeen += 1;
    if (this.pendingLights && this.framesSeen >= 2) this.registerLights();
    this.emitters.update(dt, listener);
    for (const s of this.scatters) s.update(dt, listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindFootsteps?.();
    for (const bed of this.beds) bed.stop(0.3);
    this.emitters.stopAll(0.2);
    this.heartbeat?.stop(0.2);
    this.plantLoop?.stop(0.1);
    this.bank.dispose();
  }
}

function footstepKind(clip: string): FootstepKind | null {
  switch (clip) {
    case 'walk':
      return 'walk';
    case 'crouch_walk':
      return 'crouch';
    case 'run':
      return 'run';
    case 'sprint':
      return 'sprint';
    case 'land':
      return 'land';
    default:
      return null;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Which impact family a level material belongs to: the engine's surface kind, with the wet street's ground hits splashing. */
export function impactSurfaceFor(materialName: string | undefined, point: Vec3): ImpactSurface {
  switch (surfaceKindOf(materialName)) {
    case 'metal':
      return 'metal';
    case 'glass':
      return 'glass';
    default:
      return point.y < 0.08 ? 'water' : 'concrete';
  }
}
