import {
  blend1dWeights,
  compare,
  DEFAULT_CROSSFADE,
  validateGraph,
  type AnimationGraphDef,
  type LayerDef,
  type StateDef,
  type TransitionDef,
} from './AnimationGraph';

/**
 * The animation state machine, pure logic (no three). One `LayerStateMachine`
 * per graph layer; `AnimatorPlayback` owns the layers plus the shared
 * parameter / trigger store. Each `step(dt)` advances playback phases, fires
 * events, evaluates transitions and ramps crossfade weights, then publishes
 * `samples`: which clip should be evaluated at what time with what weight.
 * `AnimationWorld` turns those into mixer action state.
 *
 * Determinism: everything here is a function of (graph, dt sequence, params);
 * events are detected by interval crossing, so a step that spans several
 * markers, or wraps the clip end more than once, fires each marker exactly
 * as many times as playback crossed it.
 */

export interface EventMarker {
  readonly name: string;
  /** Seconds from clip start. */
  readonly time: number;
  readonly [extra: string]: unknown;
}

/** What the state machine needs to know about a clip. */
export interface ClipInfo {
  readonly name: string;
  readonly duration: number;
  /** Default loop flag for states that do not set their own (`spark.loop` extra). */
  readonly loop?: boolean | undefined;
  readonly events?: readonly EventMarker[] | undefined;
}

/** One clip's contribution for this step. */
export interface ClipSample {
  clip: string;
  /** Clip-local playback time in seconds. */
  time: number;
  prevTime: number;
  /** Times playback crossed the clip end during this step. */
  loops: number;
  /** State weight × blend weight, in [0, 1]. */
  weight: number;
}

export interface FiredEvent {
  name: string;
  clip: string;
  state: string;
  layer: number;
  /** Marker time in seconds. */
  time: number;
  marker: EventMarker;
}

export interface TransitionEvent {
  layer: number;
  from: string;
  to: string;
}

export interface ParamSource {
  param(name: string): number;
  hasTrigger(name: string): boolean;
  consumeTrigger(name: string): void;
}

export interface PlayOptions {
  /** Crossfade seconds. Default `DEFAULT_CROSSFADE`. */
  duration?: number | undefined;
  /** Normalised start phase. Default 0. */
  offset?: number | undefined;
}

export interface StateSnapshot {
  readonly state: string;
  /** Normalised phase (loops counted for looping states; clamped to 1 for one-shots). */
  readonly phase: number;
  /** Phase within the current loop, 0..1. */
  readonly normalizedTime: number;
  /** Current state's weight, < 1 during a crossfade. */
  readonly weight: number;
  readonly transitioning: boolean;
}

interface ResolvedState {
  readonly def: StateDef;
  readonly name: string;
  readonly loop: boolean;
  readonly speed: number;
  readonly clips: readonly ClipInfo[];
  readonly thresholds: readonly number[];
  readonly blendParam: string | null;
  readonly transitions: readonly TransitionDef[];
}

interface Instance {
  readonly state: ResolvedState;
  phase: number;
  prevPhase: number;
  weight: number;
  /** Weight when the latest transition began; ghosts fade from here to 0. */
  w0: number;
  /** True until the first step after entry, so a marker sitting exactly on the entry phase fires. */
  entered: boolean;
}

const MAX_GHOSTS = 3;
const EPS = 1e-6;

export class LayerStateMachine {
  readonly index: number;
  readonly def: LayerDef;
  /** Filled by `step()`: every clip to evaluate this step. Reused array. */
  readonly samples: ClipSample[] = [];
  /** Filled by `step()`: events crossed this step, in clip order. Reused array. */
  readonly fired: FiredEvent[] = [];
  /** Set by `step()` when a transition began during it. */
  transitioned: TransitionEvent | null = null;

  private readonly states = new Map<string, ResolvedState>();
  private readonly anyState: readonly TransitionDef[];
  private instances: Instance[] = [];
  private transitionElapsed = 0;
  private transitionDuration = 0;
  private beganThisStep = false;
  private readonly blendScratch: number[] = [];
  private readonly crossings: Array<{ at: number; marker: EventMarker }> = [];

  constructor(def: LayerDef, clips: ReadonlyMap<string, ClipInfo>, index = 0) {
    this.def = def;
    this.index = index;
    this.anyState = def.anyState ?? [];
    for (const state of def.states) this.states.set(state.name, resolveState(state, clips));
    const entry = this.states.get(def.entry);
    if (!entry) throw new Error(`LayerStateMachine: entry state "${def.entry}" missing`);
    this.instances = [{ state: entry, phase: 0, prevPhase: 0, weight: 1, w0: 1, entered: true }];
  }

  get current(): string {
    return this.currentInstance().state.name;
  }

  get transitioning(): boolean {
    return this.instances.length > 1;
  }

  /** 1 when no crossfade is running. */
  get transitionProgress(): number {
    if (this.instances.length <= 1 || this.transitionDuration <= 0) return 1;
    return Math.min(1, this.transitionElapsed / this.transitionDuration);
  }

  snapshot(): StateSnapshot {
    const inst = this.currentInstance();
    return {
      state: inst.state.name,
      phase: inst.phase,
      normalizedTime: inst.state.loop ? inst.phase - Math.floor(inst.phase) : Math.min(1, inst.phase),
      weight: inst.weight,
      transitioning: this.instances.length > 1,
    };
  }

  hasState(name: string): boolean {
    return this.states.has(name);
  }

  /** Force a state regardless of conditions. */
  play(name: string, options: PlayOptions = {}): void {
    const target = this.states.get(name);
    if (!target) throw new Error(`LayerStateMachine: no state "${name}"`);
    this.begin(target, options.duration ?? DEFAULT_CROSSFADE, options.offset ?? 0);
    // A forced transition outside `step()` must not be mistaken for one begun inside it.
    this.beganThisStep = false;
    this.transitioned = null;
    if (this.transitionDuration <= 0) this.finishTransition();
  }

  step(dt: number, params: ParamSource): void {
    this.fired.length = 0;
    this.transitioned = null;
    this.beganThisStep = false;

    // 1. Advance every instance (ghosts keep playing so a crossfade stays continuous).
    for (const inst of this.instances) {
      const duration = this.stateDuration(inst.state, params);
      inst.prevPhase = inst.phase;
      if (duration > 0) inst.phase += dt / duration;
      if (!inst.state.loop) inst.phase = Math.min(1, inst.phase);
    }

    // 2. Events for the current state only (ghosts are fading out; they do not fire).
    const current = this.currentInstance();
    this.collectEvents(current, params);

    // 3. Transitions: anyState first (priority), then the current state's own, first match wins.
    this.evaluateTransitions(current, params);

    // 4. Crossfade ramp.
    if (this.instances.length > 1) {
      if (!this.beganThisStep) this.transitionElapsed += dt;
      let ramp = this.transitionDuration > 0 ? Math.min(1, this.transitionElapsed / this.transitionDuration) : 1;
      if (ramp >= 1 - EPS) ramp = 1;
      const head = this.currentInstance();
      head.weight = ramp;
      for (let i = 0; i < this.instances.length - 1; i++) {
        const ghost = this.instances[i] as Instance;
        ghost.weight = ghost.w0 * (1 - ramp);
      }
      if (ramp >= 1) this.finishTransition();
    }
    for (const inst of this.instances) inst.entered = false;

    // 5. Samples.
    this.buildSamples(params);
  }

  // ---- internals -----------------------------------------------------------

  private currentInstance(): Instance {
    return this.instances[this.instances.length - 1] as Instance;
  }

  private stateDuration(state: ResolvedState, params: ParamSource): number {
    const speed = state.speed > 0 ? state.speed : 1;
    if (state.clips.length === 0) return 1 / speed;
    if (state.blendParam === null) return (state.clips[0] as ClipInfo).duration / speed;
    const weights = blend1dWeights(state.thresholds, params.param(state.blendParam), this.blendScratch);
    let duration = 0;
    for (let i = 0; i < state.clips.length; i++) duration += (weights[i] as number) * (state.clips[i] as ClipInfo).duration;
    return duration / speed;
  }

  /** The clip whose markers drive events: the single clip, or the heaviest in a blend. */
  private dominantClip(state: ResolvedState, params: ParamSource): ClipInfo | null {
    if (state.clips.length === 0) return null;
    if (state.blendParam === null) return state.clips[0] as ClipInfo;
    const weights = blend1dWeights(state.thresholds, params.param(state.blendParam), this.blendScratch);
    let best = 0;
    for (let i = 1; i < weights.length; i++) if ((weights[i] as number) > (weights[best] as number)) best = i;
    return state.clips[best] as ClipInfo;
  }

  private collectEvents(inst: Instance, params: ParamSource): void {
    const clip = this.dominantClip(inst.state, params);
    if (!clip || !clip.events || clip.events.length === 0 || clip.duration <= 0) return;
    const prev = inst.prevPhase;
    const cur = inst.phase;
    const inclusive = inst.entered;
    const crossings = this.crossings;
    crossings.length = 0;
    for (const marker of clip.events) {
      if (marker.time < 0 || marker.time > clip.duration) continue;
      const m = marker.time / clip.duration;
      if (inst.state.loop) {
        // Every integer k with prev < k + m <= cur (prev <= on the entry step).
        const kStart = inclusive ? Math.ceil(prev - m - EPS) : Math.floor(prev - m + EPS) + 1;
        const kEnd = Math.floor(cur - m + EPS);
        for (let k = kStart; k <= kEnd; k++) crossings.push({ at: k + m, marker });
      } else {
        const crossed = inclusive ? m >= prev - EPS && m <= cur + EPS : m > prev + EPS && m <= cur + EPS;
        if (crossed) crossings.push({ at: m, marker });
      }
    }
    // Chronological, so a big step that spans several markers reports them in playback order.
    if (crossings.length > 1) crossings.sort((a, b) => a.at - b.at);
    for (const c of crossings) this.fire(c.marker, clip, inst.state);
    crossings.length = 0;
  }

  private fire(marker: EventMarker, clip: ClipInfo, state: ResolvedState): void {
    this.fired.push({ name: marker.name, clip: clip.name, state: state.name, layer: this.index, time: marker.time, marker });
  }

  private evaluateTransitions(current: Instance, params: ParamSource): void {
    for (const t of this.anyState) {
      if (t.to === current.state.name && !t.allowSelf) continue;
      if (this.matches(t, current, params)) {
        this.take(t, params);
        return;
      }
    }
    for (const t of current.state.transitions) {
      if (this.matches(t, current, params)) {
        this.take(t, params);
        return;
      }
    }
  }

  private matches(t: TransitionDef, inst: Instance, params: ParamSource): boolean {
    if (t.exitTime !== undefined) {
      const prev = inst.prevPhase;
      const cur = inst.phase;
      if (inst.state.loop) {
        // Crossed k + exitTime for some integer k during this step: once per loop.
        const kStart = inst.entered ? Math.ceil(prev - t.exitTime - EPS) : Math.floor(prev - t.exitTime + EPS) + 1;
        const kEnd = Math.floor(cur - t.exitTime + EPS);
        if (kEnd < kStart) return false;
      } else if (cur + EPS < t.exitTime) {
        return false;
      }
    }
    if (t.conditions) {
      for (const c of t.conditions) {
        if ('trigger' in c) {
          if (!params.hasTrigger(c.trigger)) return false;
        } else if (!compare(c.op, params.param(c.param), c.value)) {
          return false;
        }
      }
    }
    return true;
  }

  private take(t: TransitionDef, params: ParamSource): void {
    if (t.conditions) for (const c of t.conditions) if ('trigger' in c) params.consumeTrigger(c.trigger);
    const target = this.states.get(t.to) as ResolvedState;
    this.begin(target, t.duration ?? DEFAULT_CROSSFADE, t.offset ?? 0);
  }

  private begin(target: ResolvedState, duration: number, offset: number): void {
    const from = this.currentInstance().state.name;
    // Everything active becomes a ghost, fading from its current weight to 0.
    let sum = 0;
    for (const inst of this.instances) {
      inst.w0 = inst.weight;
      sum += inst.w0;
    }
    if (sum > 0) for (const inst of this.instances) inst.w0 /= sum;
    this.instances = this.instances.filter((inst) => inst.w0 > EPS);
    while (this.instances.length > MAX_GHOSTS) {
      let lowest = 0;
      for (let i = 1; i < this.instances.length; i++) {
        if ((this.instances[i] as Instance).w0 < (this.instances[lowest] as Instance).w0) lowest = i;
      }
      this.instances.splice(lowest, 1);
      let total = 0;
      for (const inst of this.instances) total += inst.w0;
      if (total > 0) for (const inst of this.instances) inst.w0 /= total;
    }
    const snap = duration <= 0;
    const next: Instance = {
      state: target,
      phase: target.loop ? offset : Math.min(1, offset),
      prevPhase: target.loop ? offset : Math.min(1, offset),
      weight: snap ? 1 : 0,
      w0: 0,
      entered: true,
    };
    this.instances.push(next);
    this.transitionDuration = duration;
    this.transitionElapsed = 0;
    this.beganThisStep = true;
    this.transitioned = { layer: this.index, from, to: target.name };
    if (snap) this.finishTransition();
  }

  private finishTransition(): void {
    const head = this.currentInstance();
    head.weight = 1;
    head.w0 = 1;
    this.instances = [head];
    this.transitionDuration = 0;
    this.transitionElapsed = 0;
  }

  private buildSamples(params: ParamSource): void {
    const samples = this.samples;
    samples.length = 0;
    for (const inst of this.instances) {
      if (inst.weight <= EPS) continue;
      const state = inst.state;
      if (state.clips.length === 0) continue;
      const loops = state.loop ? Math.floor(inst.phase + EPS) - Math.floor(inst.prevPhase + EPS) : 0;
      if (state.blendParam === null) {
        this.pushSample(state.clips[0] as ClipInfo, inst, loops, inst.weight);
        continue;
      }
      const weights = blend1dWeights(state.thresholds, params.param(state.blendParam), this.blendScratch);
      for (let i = 0; i < state.clips.length; i++) {
        const w = (weights[i] as number) * inst.weight;
        if (w <= EPS) continue;
        this.pushSample(state.clips[i] as ClipInfo, inst, loops, w);
      }
    }
  }

  private pushSample(clip: ClipInfo, inst: Instance, loops: number, weight: number): void {
    const loop = inst.state.loop;
    this.samples.push({
      clip: clip.name,
      time: phaseToTime(inst.phase, clip.duration, loop),
      prevTime: phaseToTime(inst.prevPhase, clip.duration, loop),
      loops,
      weight,
    });
  }
}

function phaseToTime(phase: number, duration: number, loop: boolean): number {
  if (!loop) return Math.min(1, Math.max(0, phase)) * duration;
  let frac = phase - Math.floor(phase + EPS);
  if (frac < 0) frac = 0;
  return frac * duration;
}

function resolveState(def: StateDef, clips: ReadonlyMap<string, ClipInfo>): ResolvedState {
  const require = (name: string): ClipInfo => {
    const clip = clips.get(name);
    if (!clip) throw new Error(`AnimationGraph: state "${def.name}" references unknown clip "${name}"`);
    return clip;
  };
  const speed = def.speed ?? 1;
  const transitions = def.transitions ?? [];
  if (def.blend) {
    const points = [...def.blend.points].sort((a, b) => a.threshold - b.threshold);
    return {
      def,
      name: def.name,
      loop: def.loop ?? true,
      speed,
      clips: points.map((p) => require(p.clip)),
      thresholds: points.map((p) => p.threshold),
      blendParam: def.blend.param,
      transitions,
    };
  }
  if (def.clip !== undefined) {
    const clip = require(def.clip);
    return { def, name: def.name, loop: def.loop ?? clip.loop ?? true, speed, clips: [clip], thresholds: [], blendParam: null, transitions };
  }
  return { def, name: def.name, loop: def.loop ?? true, speed, clips: [], thresholds: [], blendParam: null, transitions };
}

/**
 * All layers of one graph plus the shared parameters and triggers. Triggers
 * persist until a transition consumes them (or `resetTrigger`).
 */
export class AnimatorPlayback implements ParamSource {
  readonly graph: AnimationGraphDef;
  readonly layers: readonly LayerStateMachine[];
  /** Events fired by the latest `step()`, every layer. Reused array. */
  readonly fired: FiredEvent[] = [];
  /** Transitions begun by the latest `step()`. Reused array. */
  readonly transitions: TransitionEvent[] = [];

  private readonly params = new Map<string, number>();
  private readonly triggers = new Set<string>();

  constructor(graph: AnimationGraphDef, clips: ReadonlyMap<string, ClipInfo>) {
    this.graph = validateGraph(graph);
    for (const [name, value] of Object.entries(graph.params ?? {})) this.params.set(name, value);
    this.layers = graph.layers.map((layer, i) => new LayerStateMachine(layer, clips, i));
  }

  param(name: string): number {
    return this.params.get(name) ?? 0;
  }

  setParam(name: string, value: number): void {
    this.params.set(name, value);
  }

  setTrigger(name: string): void {
    this.triggers.add(name);
  }

  resetTrigger(name: string): void {
    this.triggers.delete(name);
  }

  hasTrigger(name: string): boolean {
    return this.triggers.has(name);
  }

  consumeTrigger(name: string): void {
    this.triggers.delete(name);
  }

  getState(layer = 0): string {
    return this.layer(layer).current;
  }

  snapshot(layer = 0): StateSnapshot {
    return this.layer(layer).snapshot();
  }

  play(state: string, layer = 0, options?: PlayOptions): void {
    this.layer(layer).play(state, options);
  }

  step(dt: number): void {
    this.fired.length = 0;
    this.transitions.length = 0;
    for (const layer of this.layers) {
      layer.step(dt, this);
      for (const e of layer.fired) this.fired.push(e);
      if (layer.transitioned) this.transitions.push(layer.transitioned);
    }
  }

  private layer(index: number): LayerStateMachine {
    const layer = this.layers[index];
    if (!layer) throw new Error(`AnimatorPlayback: no layer ${index}`);
    return layer;
  }
}
