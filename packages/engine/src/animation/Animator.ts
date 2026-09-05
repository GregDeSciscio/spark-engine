import * as THREE from 'three/webgpu';
import { EventEmitter } from '../core/Events';
import { defineComponentType } from '../ecs/Component';
import { Transform, Velocity } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import { SideTable } from '../ecs/SideTable';
import { graphClipNames, type AnimationGraphDef, type LayerDef } from './AnimationGraph';
import { rootMotionDelta, rotateByQuaternion, type Vec3Track, type Vec3Tuple } from './RootMotion';
import {
  AnimatorPlayback,
  type ClipInfo,
  type EventMarker,
  type FiredEvent,
  type PlayOptions,
  type StateSnapshot,
  type TransitionEvent,
} from './StateMachine';

/**
 * Numeric per-entity animation controls (ADR-003: numbers only; the mixer,
 * actions and state machine live in `AnimationWorld`'s side table).
 *
 * - `speed`: playback rate multiplier (1 = clip speed; 0 pauses).
 * - `layer1..3`: weight of layers 1..3, additive or override (layer 0 is always 1).
 * - `rootMotion`: 0 disables applying root motion for this entity.
 */
export const Animator = defineComponentType(
  'Animator',
  { speed: 'f32', layer1: 'f32', layer2: 'f32', layer3: 'f32', rootMotion: 'u8' },
  { speed: 1, layer1: 1, layer2: 1, layer3: 1, rootMotion: 1 },
);

export type RootMotionMode = 'transform' | 'velocity' | 'none';

export interface RootMotionOptions {
  /** `transform`: add the delta to Transform each fixed step. `velocity`: write it to Velocity. Default `transform`. */
  readonly mode?: RootMotionMode | undefined;
  /** Root bone name. Default: the first bone with a truthy `spark.rootBone` extra. */
  readonly bone?: string | undefined;
  /** Also apply the vertical component (default false: Y stays on the skeleton). */
  readonly vertical?: boolean | undefined;
}

export interface AttachOptions {
  readonly rootMotion?: RootMotionOptions | undefined;
  /** Extra / overriding event markers per clip name, merged with each clip's `spark.events` extras. */
  readonly events?: Readonly<Record<string, readonly EventMarker[]>> | undefined;
}

export interface AnimationEvent {
  readonly eid: Entity;
  readonly name: string;
  readonly clip: string;
  readonly state: string;
  readonly layer: number;
  /** Marker time within the clip, seconds. */
  readonly time: number;
  readonly marker: EventMarker;
}

export interface AnimationTransition {
  readonly eid: Entity;
  readonly layer: number;
  readonly from: string;
  readonly to: string;
}

export interface AnimationWorldEvents extends Record<string, unknown> {
  event: AnimationEvent;
  transition: AnimationTransition;
}

export interface AnimationWorldStats {
  readonly animators: number;
  readonly preparedClips: number;
}

interface LayerBinding {
  readonly actions: Map<string, THREE.AnimationAction>;
  readonly durations: Map<string, number>;
  /** Normal-blend layer above the base: its clips replace the base pose on the (masked) bones it drives. */
  readonly override: boolean;
}

/**
 * Three's mixer averages every normal-blend action on a property by weight, so
 * an override layer at share `s` against a base whose weights sum to 1 needs
 * weight `s / (1 - s)`. Capped so a full override leaves 0.1 percent of the base,
 * which no one can see, instead of a division by zero.
 */
const OVERRIDE_MAX_BOOST = 1000;
export function overrideBoost(share: number): number {
  if (share <= 0) return 0;
  if (share >= 1) return OVERRIDE_MAX_BOOST;
  return Math.min(OVERRIDE_MAX_BOOST, share / (1 - share));
}

interface LayerFade {
  target: number;
  /** Weight units per second; Infinity snaps. */
  rate: number;
}

interface Instance {
  /** Layer index → fade in progress (layers 1..3). */
  readonly fades: Map<number, LayerFade>;
  readonly root: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly playback: AnimatorPlayback;
  readonly layers: readonly LayerBinding[];
  readonly rootBone: THREE.Object3D | null;
  readonly rootRest: THREE.Vector3;
  readonly rootTracks: ReadonlyMap<string, Vec3Track>;
  readonly rootMode: RootMotionMode;
  readonly rootVertical: boolean;
  /** Root-motion delta accumulated since the last fixed step, in entity-local space. */
  readonly pending: Vec3Tuple;
  readonly listeners: Map<string, Set<(event: AnimationEvent) => void>>;
  lastEvent: AnimationEvent | null;
}

const FIXED_PREROLL_DT = 1 / 60;

/**
 * Skeletal animation for entities (Milestone 6). One per engine; scenes reach
 * it through `SceneContext.animation`.
 *
 * `attach()` binds an instantiated skinned model + its clips + a data-defined
 * graph to an entity. Every `update` stage `step()` advances the state machine,
 * fires events, writes action times / weights into the three mixer and
 * extracts root motion; every fixed step `applyRootMotion()` moves the entity's
 * Transform by the accumulated delta (before the physics kinematic push).
 */
export class AnimationWorld {
  readonly events = new EventEmitter<AnimationWorldEvents>();

  private readonly table: SideTable<Instance>;
  private readonly prepared = new Map<string, THREE.AnimationClip>();
  private readonly tmpQuat = { x: 0, y: 0, z: 0, w: 1 };
  private disposed = false;

  constructor(private readonly entities: EntityWorld) {
    this.table = new SideTable<Instance>(entities, (inst) => releaseInstance(inst));
  }

  // ---- attach / detach -----------------------------------------------------

  /**
   * Bind a model instance (from `ModelAsset.instantiate()`) to an entity.
   * `clips` are the asset's `animations`; they are shared, never mutated
   * (masked / additive layers get prepared copies, cached per clip).
   */
  attach(eid: Entity, root: THREE.Object3D, clips: readonly THREE.AnimationClip[], graph: AnimationGraphDef, options: AttachOptions = {}): void {
    if (this.disposed) throw new Error('AnimationWorld: attach after dispose');
    const byName = new Map<string, THREE.AnimationClip>();
    const infos = new Map<string, ClipInfo>();
    for (const clip of clips) {
      byName.set(clip.name, clip);
      infos.set(clip.name, clipInfo(clip, options.events?.[clip.name]));
    }
    for (const name of graphClipNames(graph)) {
      if (!byName.has(name)) throw new Error(`AnimationWorld: graph references clip "${name}" but the model has [${[...byName.keys()].join(', ')}]`);
    }
    const playback = new AnimatorPlayback(graph, infos);
    const mixer = new THREE.AnimationMixer(root);
    const layers: LayerBinding[] = graph.layers.map((layer, index) => this.bindLayer(mixer, root, layer, index, byName));

    const rootOptions = options.rootMotion ?? {};
    const rootBone = findRootBone(root, rootOptions.bone);
    const rootTracks = new Map<string, Vec3Track>();
    if (rootBone) {
      const trackName = `${rootBone.name}.position`;
      for (const clip of clips) {
        const track = clip.tracks.find((t) => t.name === trackName);
        if (track) rootTracks.set(clip.name, { times: track.times, values: track.values });
      }
    }

    const inst: Instance = {
      fades: new Map(),
      root,
      mixer,
      playback,
      layers,
      rootBone,
      rootRest: rootBone ? rootBone.position.clone() : new THREE.Vector3(),
      rootTracks,
      rootMode: rootBone ? (rootOptions.mode ?? 'transform') : 'none',
      rootVertical: rootOptions.vertical ?? false,
      pending: [0, 0, 0],
      listeners: new Map(),
      lastEvent: null,
    };
    if (!this.entities.has(eid, Animator)) this.entities.add(eid, Animator);
    this.table.set(eid, inst);
    // Pose the skeleton for the entry state now, so the first rendered frame is not the bind pose.
    playback.step(0);
    this.syncMixer(inst, eid, 1, 1, 1);
    inst.pending[0] = inst.pending[1] = inst.pending[2] = 0;
  }

  detach(eid: Entity): boolean {
    return this.table.delete(eid);
  }

  has(eid: Entity): boolean {
    return this.table.has(eid);
  }

  get count(): number {
    return this.table.size;
  }

  stats(): AnimationWorldStats {
    return { animators: this.table.size, preparedClips: this.prepared.size };
  }

  // ---- parameters / state ------------------------------------------------

  setParam(eid: Entity, name: string, value: number): void {
    this.table.require(eid).playback.setParam(name, value);
  }

  getParam(eid: Entity, name: string): number {
    return this.table.require(eid).playback.param(name);
  }

  setTrigger(eid: Entity, name: string): void {
    this.table.require(eid).playback.setTrigger(name);
  }

  resetTrigger(eid: Entity, name: string): void {
    this.table.require(eid).playback.resetTrigger(name);
  }

  /** Current state name on a layer (0 = base). */
  getState(eid: Entity, layer = 0): string {
    return this.table.require(eid).playback.getState(layer);
  }

  snapshot(eid: Entity, layer = 0): StateSnapshot {
    return this.table.require(eid).playback.snapshot(layer);
  }

  /** Force a state regardless of transition conditions. */
  play(eid: Entity, state: string, layer = 0, options?: PlayOptions): void {
    this.table.require(eid).playback.play(state, layer, options);
  }

  /** The most recent animation event this entity fired, if any. */
  lastEvent(eid: Entity): AnimationEvent | null {
    return this.table.get(eid)?.lastEvent ?? null;
  }

  /** The graph an entity was attached with (inspector: parameter and layer names). */
  graphOf(eid: Entity): AnimationGraphDef | undefined {
    return this.table.get(eid)?.playback.graph;
  }

  /** Listen for one named event on one entity. Returns the unsubscribe function. */
  on(eid: Entity, eventName: string, listener: (event: AnimationEvent) => void): () => void {
    const inst = this.table.require(eid);
    let set = inst.listeners.get(eventName);
    if (!set) {
      set = new Set();
      inst.listeners.set(eventName, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /**
   * Advance one entity silently by `seconds` (no events, no root motion):
   * de-synchronises crowds at spawn so they are not all on the same frame.
   */
  advance(eid: Entity, seconds: number, stepDt = FIXED_PREROLL_DT): void {
    const inst = this.table.require(eid);
    let remaining = Math.max(0, seconds);
    while (remaining > 0) {
      const dt = Math.min(stepDt, remaining);
      inst.playback.step(dt);
      remaining -= dt;
    }
    this.syncMixer(inst, eid, 1, 1, 1);
    inst.pending[0] = inst.pending[1] = inst.pending[2] = 0;
  }

  /** The three mixer behind an entity (debugging, custom actions). */
  mixerOf(eid: Entity): THREE.AnimationMixer | undefined {
    return this.table.get(eid)?.mixer;
  }

  /**
   * Fade layer 1..3's weight to `target` over `seconds` (0 snaps). The weight
   * lives in the `Animator` component (`layer1..3`); this moves it each step
   * so a game does not hand-roll the same lerp per actor.
   */
  setLayerWeight(eid: Entity, layer: number, target: number, seconds = 0): void {
    if (layer < 1 || layer > 3) throw new Error(`AnimationWorld.setLayerWeight: layer must be 1..3, got ${layer}`);
    const inst = this.table.require(eid);
    const clamped = Math.max(0, Math.min(1, target));
    if (seconds <= 0) {
      inst.fades.delete(layer);
      this.writeLayerWeight(eid, layer, clamped);
      return;
    }
    const current = this.getLayerWeight(eid, layer);
    inst.fades.set(layer, { target: clamped, rate: Math.abs(clamped - current) / seconds || Number.POSITIVE_INFINITY });
  }

  getLayerWeight(eid: Entity, layer: number): number {
    const a = this.entities.store(Animator);
    const store = layer === 1 ? a.layer1 : layer === 2 ? a.layer2 : a.layer3;
    return store[eid] ?? 1;
  }

  private writeLayerWeight(eid: Entity, layer: number, weight: number): void {
    const a = this.entities.store(Animator);
    const store = layer === 1 ? a.layer1 : layer === 2 ? a.layer2 : a.layer3;
    store[eid] = weight;
  }

  private advanceFades(eid: Entity, inst: Instance, dt: number): void {
    if (inst.fades.size === 0) return;
    for (const [layer, fade] of inst.fades) {
      const current = this.getLayerWeight(eid, layer);
      const step = fade.rate * dt;
      const next = Math.abs(fade.target - current) <= step ? fade.target : current + Math.sign(fade.target - current) * step;
      this.writeLayerWeight(eid, layer, next);
      if (next === fade.target) inst.fades.delete(layer);
    }
  }

  // ---- systems ---------------------------------------------------------------

  /** Update stage: advance every animator by `dt`, fire events, pose skeletons, accumulate root motion. */
  step(world: EntityWorld, dt: number): void {
    if (this.disposed) return;
    const a = world.store(Animator);
    for (const [eid, inst] of this.table.entries()) {
      const speed = a.speed[eid] ?? 1;
      inst.playback.step(dt * speed);
      this.advanceFades(eid, inst, dt);
      this.syncMixer(inst, eid, a.layer1[eid] ?? 1, a.layer2[eid] ?? 1, a.layer3[eid] ?? 1);
      this.dispatch(eid, inst, inst.playback.fired, inst.playback.transitions);
    }
  }

  /** Fixed stage (before the physics kinematic push): move entities by their accumulated root motion. */
  applyRootMotion(world: EntityWorld, dt: number): void {
    if (this.disposed) return;
    const t = world.store(Transform);
    const a = world.store(Animator);
    for (const [eid, inst] of this.table.entries()) {
      const v = inst.pending;
      if (inst.rootMode === 'none' || (a.rootMotion[eid] ?? 1) === 0) {
        v[0] = v[1] = v[2] = 0;
        continue;
      }
      if (v[0] === 0 && v[1] === 0 && v[2] === 0) {
        if (inst.rootMode === 'velocity' && world.has(eid, Velocity)) {
          const vel = world.store(Velocity);
          vel.x[eid] = 0;
          vel.y[eid] = inst.rootVertical ? 0 : (vel.y[eid] ?? 0);
          vel.z[eid] = 0;
        }
        continue;
      }
      if (!world.has(eid, Transform)) {
        v[0] = v[1] = v[2] = 0;
        continue;
      }
      const q = this.tmpQuat;
      q.x = t.qx[eid] ?? 0;
      q.y = t.qy[eid] ?? 0;
      q.z = t.qz[eid] ?? 0;
      q.w = t.qw[eid] ?? 1;
      rotateByQuaternion(v, q.x, q.y, q.z, q.w);
      if (inst.rootMode === 'transform') {
        t.x[eid] = (t.x[eid] ?? 0) + v[0];
        if (inst.rootVertical) t.y[eid] = (t.y[eid] ?? 0) + v[1];
        t.z[eid] = (t.z[eid] ?? 0) + v[2];
      } else {
        if (!world.has(eid, Velocity)) world.add(eid, Velocity);
        const vel = world.store(Velocity);
        const inv = dt > 0 ? 1 / dt : 0;
        vel.x[eid] = v[0] * inv;
        if (inst.rootVertical) vel.y[eid] = v[1] * inv;
        vel.z[eid] = v[2] * inv;
      }
      v[0] = v[1] = v[2] = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.table.dispose();
    this.prepared.clear();
    this.events.clear();
  }

  // ---- internals ---------------------------------------------------------------

  private bindLayer(mixer: THREE.AnimationMixer, root: THREE.Object3D, layer: LayerDef, index: number, byName: ReadonlyMap<string, THREE.AnimationClip>): LayerBinding {
    const additive = index > 0 && (layer.additive ?? true);
    const actions = new Map<string, THREE.AnimationAction>();
    const durations = new Map<string, number>();
    const names = new Set<string>();
    for (const state of layer.states) {
      if (state.clip !== undefined) names.add(state.clip);
      if (state.blend) for (const p of state.blend.points) names.add(p.clip);
    }
    for (const name of names) {
      const source = byName.get(name) as THREE.AnimationClip;
      const clip = !layer.mask && !additive ? source : this.prepareClip(source, layer.mask, additive);
      const action = mixer.clipAction(clip, root, additive ? THREE.AdditiveAnimationBlendMode : THREE.NormalAnimationBlendMode);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.enabled = true;
      action.play();
      action.setEffectiveWeight(0);
      actions.set(name, action);
      durations.set(name, source.duration);
    }
    return { actions, durations, override: index > 0 && !additive };
  }

  /** Masked and/or additive copy of a clip. Cached so every instance shares one. */
  private prepareClip(source: THREE.AnimationClip, mask: readonly string[] | undefined, additive: boolean): THREE.AnimationClip {
    const key = `${source.uuid}|${mask ? mask.join(',') : '*'}|${additive ? 'add' : 'norm'}`;
    const cached = this.prepared.get(key);
    if (cached) return cached;
    const tracks = source.tracks
      .filter((track) => {
        if (!mask) return true;
        const node = THREE.PropertyBinding.parseTrackName(track.name).nodeName ?? '';
        return mask.some((prefix) => node.startsWith(prefix));
      })
      .map((track) => track.clone());
    const clip = new THREE.AnimationClip(source.name, source.duration, tracks);
    if (additive) THREE.AnimationUtils.makeClipAdditive(clip);
    this.prepared.set(key, clip);
    return clip;
  }

  /** Push the state machine's samples into mixer actions, evaluate, extract and neutralise root motion. */
  private syncMixer(inst: Instance, eid: Entity, layer1: number, layer2: number, layer3: number): void {
    const layerWeights = [1, layer1, layer2, layer3];
    const playback = inst.playback;
    for (let i = 0; i < inst.layers.length; i++) {
      const binding = inst.layers[i] as LayerBinding;
      const layerWeight = layerWeights[i] ?? 1;
      for (const action of binding.actions.values()) action.setEffectiveWeight(0);
      if (layerWeight <= 0) continue;
      const layer = playback.layers[i];
      if (!layer) continue;
      // An override layer's samples sum to 1 inside the layer; the boost makes the layer as a whole win by its weight.
      const scale = binding.override ? overrideBoost(Math.min(1, layerWeight)) : layerWeight;
      for (const sample of layer.samples) {
        const action = binding.actions.get(sample.clip);
        if (!action) continue;
        const w = sample.weight * scale;
        if (w <= 0) continue;
        const duration = binding.durations.get(sample.clip) ?? action.getClip().duration;
        const existing = action.getEffectiveWeight();
        // The same clip can be live twice (a ghost and a fresh instance); one action
        // carries both: sum the weights, keep the heavier instance's time.
        if (existing <= 0 || w > existing) action.time = Math.min(duration, Math.max(0, sample.time));
        action.setEffectiveWeight(existing + w);
        if (i === 0 && inst.rootMode !== 'none') {
          const track = inst.rootTracks.get(sample.clip);
          if (track) rootMotionDelta(track, sample.prevTime, sample.time, sample.loops, duration, inst.pending, sample.weight);
        }
      }
    }
    inst.mixer.update(0);
    if (inst.rootBone) {
      // Root motion is applied to the entity, never to the mesh: pin the root bone.
      inst.rootBone.position.x = inst.rootRest.x;
      inst.rootBone.position.z = inst.rootRest.z;
      if (inst.rootVertical) inst.rootBone.position.y = inst.rootRest.y;
      else inst.pending[1] = 0;
    }
  }

  private dispatch(eid: Entity, inst: Instance, fired: readonly FiredEvent[], transitions: readonly TransitionEvent[]): void {
    for (const t of transitions) this.events.emit('transition', { eid, layer: t.layer, from: t.from, to: t.to });
    for (const f of fired) {
      const event: AnimationEvent = { eid, name: f.name, clip: f.clip, state: f.state, layer: f.layer, time: f.time, marker: f.marker };
      inst.lastEvent = event;
      this.events.emit('event', event);
      const set = inst.listeners.get(f.name);
      if (set) for (const listener of Array.from(set)) listener(event);
    }
  }
}

// ---- helpers -------------------------------------------------------------------

function releaseInstance(inst: Instance): void {
  inst.mixer.stopAllAction();
  inst.mixer.uncacheRoot(inst.root);
  inst.listeners.clear();
}

/** Marker list from a clip's `spark.events` extra (validated loosely) merged with explicit extras. */
function clipInfo(clip: THREE.AnimationClip, extra: readonly EventMarker[] | undefined): ClipInfo {
  const userData = clip.userData as Record<string, unknown>;
  const events: EventMarker[] = [];
  const raw = userData['spark.events'];
  if (Array.isArray(raw)) {
    for (const item of raw as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const marker = item as Record<string, unknown>;
      if (typeof marker.name !== 'string' || typeof marker.time !== 'number') continue;
      events.push(marker as unknown as EventMarker);
    }
  }
  if (extra) events.push(...extra);
  events.sort((a, b) => a.time - b.time);
  const loop = typeof userData['spark.loop'] === 'boolean' ? (userData['spark.loop'] as boolean) : undefined;
  return { name: clip.name, duration: clip.duration, loop, events };
}

function findRootBone(root: THREE.Object3D, name: string | undefined): THREE.Object3D | null {
  let found: THREE.Object3D | null = null;
  root.traverse((object) => {
    if (found) return;
    if (name !== undefined) {
      if (object.name === name) found = object;
    } else if ((object.userData as Record<string, unknown>)['spark.rootBone']) {
      found = object;
    }
  });
  return found;
}
