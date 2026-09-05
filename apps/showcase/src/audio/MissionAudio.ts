import type * as THREE from 'three/webgpu';
import type { AnimationWorld, AudioSystem, Entity, Logger, Random, SoundPlayAtOptions, SpatialOptions, Voice } from '@spark/engine';

/**
 * The mission's sound design at runtime (docs/audio/mission-sound-design.md).
 * `tools/audio/build.mjs` masters the generated takes and writes
 * `/audio/manifest.json`; this reads it, defines every cue that has files
 * (round-robin variants through the engine's `urls`) and offers the game
 * one verb per moment: `shot`, `impact`, `footstep`, `bark`, `heartbeat`...
 * A cue without files is a silent no-op, and the missing names are logged
 * once, so the game runs the same before and after the assets exist.
 */

export interface ManifestCue {
  readonly name: string;
  readonly kind: 'sfx' | 'voice';
  readonly bus: 'sfx' | 'ui' | 'ambience' | 'music';
  readonly loop: boolean;
  readonly volume: number;
  readonly volumeVariance: number;
  readonly pitchVariance: number;
  readonly cooldownMs: number;
  readonly maxInstances: number | null;
  readonly files: readonly { readonly url: string; readonly duration: number }[];
}

export interface AudioManifest {
  readonly cues: readonly ManifestCue[];
}

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
  emitter: { refDistance: 1.8, rolloff: 1.5, maxDistance: 24 },
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
/** Point loops: how many neon / steam emitters sound at once, and how often the nearest set is re-picked. */
const MAX_POINT_LOOPS = 6;
const POINT_LOOP_REPICK = 1.5;
/** Low-health heartbeat comes in below this health fraction. */
const HEARTBEAT_BELOW = 0.35;

interface PointLoop {
  readonly position: THREE.Vector3;
  readonly sound: string;
  readonly pitch: number;
  readonly volume: number;
  voice: Voice | null;
  distance: number;
}

type Vec3 = { x: number; y: number; z: number };

export class MissionAudio {
  /** Cue names present in the manifest with at least one file. */
  readonly available: ReadonlySet<string>;
  private readonly deps: MissionAudioDeps;
  private readonly defined: string[] = [];
  private readonly missing = new Set<string>();
  private readonly beds: Voice[] = [];
  private readonly loops: PointLoop[] = [];
  private heartbeat: Voice | null = null;
  private heartbeatLevel = 0;
  private plantLoop: Voice | null = null;
  private repickIn = 0;
  private nextDrip = 1;
  private nextThunder = 20;
  private nextDrone = 35;
  private unbindFootsteps: (() => void) | null = null;
  private disposed = false;

  private constructor(deps: MissionAudioDeps, manifest: AudioManifest | null) {
    this.deps = deps;
    const available = new Set<string>();
    if (manifest) {
      for (const cue of manifest.cues) {
        if (cue.files.length === 0) continue;
        deps.audio.defineSound({
          name: cue.name,
          urls: cue.files.map((f) => f.url),
          bus: cue.bus,
          volume: cue.volume,
          volumeVariance: cue.volumeVariance,
          pitchVariance: cue.pitchVariance,
          cooldownMs: cue.cooldownMs,
          maxInstances: cue.maxInstances ?? undefined,
          loop: cue.loop,
        });
        this.defined.push(cue.name);
        available.add(cue.name);
      }
      const absent = manifest.cues.filter((c) => c.files.length === 0).map((c) => c.name);
      if (absent.length > 0) deps.logger.warn(`audio: ${absent.length} cue(s) have no takes yet (pnpm audio:generate && pnpm audio:build): ${absent.join(', ')}`);
      deps.logger.info(`audio: ${available.size} cue(s) defined from the manifest`);
    }
    this.available = available;
  }

  /** Fetch the manifest and define its cues. A missing manifest yields a silent instance. */
  static async load(deps: MissionAudioDeps, url = '/audio/manifest.json'): Promise<MissionAudio> {
    let manifest: AudioManifest | null = null;
    try {
      const res = await fetch(url);
      if (res.ok) manifest = (await res.json()) as AudioManifest;
      else deps.logger.warn(`audio: no manifest at ${url} (${res.status}); the mission runs silent. Run pnpm audio:build.`);
    } catch (error) {
      deps.logger.warn(`audio: manifest fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new MissionAudio(deps, manifest);
  }

  has(name: string): boolean {
    return this.available.has(name);
  }

  /** Flat one-shot; a silent no-op for cues without takes. */
  play(name: string, options?: SoundPlayAtOptions): Voice | null {
    if (!this.guard(name)) return null;
    return this.deps.audio.play(name, options);
  }

  /** Spatial one-shot at an entity or a point. */
  playAt(name: string, target: Entity | Vec3, options?: SoundPlayAtOptions): Voice | null {
    if (!this.guard(name)) return null;
    return this.deps.audio.playAt(name, target, options);
  }

  private guard(name: string): boolean {
    if (this.disposed) return false;
    if (this.available.has(name)) return true;
    if (!this.missing.has(name)) {
      this.missing.add(name);
      this.deps.logger.debug(`audio: cue "${name}" has no takes; skipped`);
    }
    return false;
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
      this.heartbeat = this.deps.audio.play('heartbeat', { loop: true, volume: 0, fadeIn: 0.2 });
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
    const names = BARKS[kind].filter((n) => this.available.has(n));
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
      this.plantLoop = this.deps.audio.play('ui-plant-loop', { loop: true, fadeIn: 0.1 });
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
   * Start the beds and register the point emitters (neon lights, steam vents).
   * Only the nearest `MAX_POINT_LOOPS` emitters sound at a time; `update`
   * re-picks them as the listener moves.
   */
  startAmbience(neon: readonly THREE.Vector3[], steam: readonly THREE.Vector3[]): void {
    const { audio, random } = this.deps;
    for (const bed of ['rain-bed', 'city-bed']) {
      if (this.has(bed)) this.beds.push(audio.play(bed, { loop: true, fadeIn: 2.5 }));
    }
    if (this.has('neon-buzz')) for (const p of neon) this.loops.push({ position: p, sound: 'neon-buzz', pitch: random.range(0.94, 1.06), volume: random.range(0.7, 1), voice: null, distance: 0 });
    if (this.has('steam-hiss')) for (const p of steam) this.loops.push({ position: p, sound: 'steam-hiss', pitch: random.range(0.9, 1.1), volume: random.range(0.8, 1), voice: null, distance: 0 });
    this.repickIn = 0;
  }

  /** Per-frame ambience housekeeping: emitter selection, drips, distant thunder, a drone pass. */
  update(dt: number, listener: Vec3): void {
    if (this.disposed) return;
    const { audio, random } = this.deps;
    this.repickIn -= dt;
    if (this.repickIn <= 0 && this.loops.length > 0) {
      this.repickIn = POINT_LOOP_REPICK;
      for (const loop of this.loops) loop.distance = loop.position.distanceTo(listener as THREE.Vector3Like);
      const sorted = [...this.loops].sort((a, b) => a.distance - b.distance);
      for (let i = 0; i < sorted.length; i++) {
        const loop = sorted[i] as PointLoop;
        const wanted = i < MAX_POINT_LOOPS && loop.distance < SPATIAL.emitter.maxDistance!;
        if (wanted && !loop.voice) {
          loop.voice = audio.playAt(loop.sound, loop.position, { loop: true, spatial: SPATIAL.emitter, pitch: loop.pitch, volume: loop.volume, fadeIn: 0.8 });
        } else if (!wanted && loop.voice) {
          loop.voice.stop(0.8);
          loop.voice = null;
        }
      }
    }
    this.nextDrip -= dt;
    if (this.nextDrip <= 0) {
      this.nextDrip = random.range(0.7, 2.4);
      const angle = random.range(0, Math.PI * 2);
      const r = random.range(2, 9);
      this.playAt('drip', { x: listener.x + Math.cos(angle) * r, y: 0.1, z: listener.z + Math.sin(angle) * r }, { spatial: SPATIAL.drip });
    }
    this.nextThunder -= dt;
    if (this.nextThunder <= 0) {
      this.nextThunder = random.range(28, 70);
      this.play('thunder');
    }
    this.nextDrone -= dt;
    if (this.nextDrone <= 0) {
      this.nextDrone = random.range(45, 110);
      this.play('drone-pass');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindFootsteps?.();
    for (const bed of this.beds) bed.stop(0.3);
    for (const loop of this.loops) loop.voice?.stop(0.2);
    this.heartbeat?.stop(0.2);
    this.plantLoop?.stop(0.1);
    for (const name of this.defined) this.deps.audio.undefineSound(name);
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

/** Which impact family a level material belongs to, from the surface naming (`rendering/Surfaces.ts`). */
export function impactSurfaceFor(materialName: string | undefined, point: Vec3): ImpactSurface {
  const name = (materialName ?? '').toLowerCase();
  if (/metal|steel|pipe|shutter|bollard|grate|vent/.test(name)) return 'metal';
  if (/window|glass|neon/.test(name)) return 'glass';
  // Ground hits on the wet street splash.
  if (point.y < 0.08) return 'water';
  return 'concrete';
}
