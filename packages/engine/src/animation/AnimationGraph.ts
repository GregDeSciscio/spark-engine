/**
 * Data-defined animation graphs (Milestone 6). Pure data + pure math, no three:
 * the state machine in `StateMachine.ts` interprets these, `AnimationWorld`
 * binds them to a mixer. Everything here is unit-testable without a renderer.
 */

export type CompareOp = '>' | '<' | '>=' | '<=' | '==' | '!=';

/** A condition on a float parameter, or a trigger (consumed when the transition fires). */
export type TransitionCondition = { param: string; op: CompareOp; value: number } | { trigger: string };

export interface TransitionDef {
  readonly to: string;
  readonly conditions?: readonly TransitionCondition[];
  /** Crossfade length in seconds. Default 0.2; 0 snaps. */
  readonly duration?: number;
  /**
   * Normalised time (0..1 within one loop) the source state must reach before this
   * transition can fire. Looping states fire once per loop when playback crosses it;
   * one-shot states fire as soon as it has been reached (`1` = clip end).
   */
  readonly exitTime?: number;
  /** Normalised start phase of the target state. Default 0. */
  readonly offset?: number;
  /** For `anyState` transitions: allow re-entering the state that is already current. Default false. */
  readonly allowSelf?: boolean;
}

export interface Blend1DPoint {
  readonly clip: string;
  readonly threshold: number;
}

/** A 1D blend tree: clips arranged along one float parameter. */
export interface Blend1DDef {
  readonly param: string;
  readonly points: readonly Blend1DPoint[];
}

export interface StateDef {
  readonly name: string;
  /** Single clip. Exactly one of `clip` / `blend` may be set; neither means an empty state (useful on additive layers). */
  readonly clip?: string;
  readonly blend?: Blend1DDef;
  /** Loop (default true; `spark.loop` in the clip extras overrides the default when present). */
  readonly loop?: boolean;
  /** Playback rate multiplier. Default 1. */
  readonly speed?: number;
  readonly transitions?: readonly TransitionDef[];
}

export interface LayerDef {
  readonly name?: string;
  readonly entry: string;
  readonly states: readonly StateDef[];
  /** Evaluated before the current state's own transitions, every step. */
  readonly anyState?: readonly TransitionDef[];
  /** Layers above the base are additive (three's mixer has no per-bone override). Default true for layer > 0. */
  readonly additive?: boolean;
  /** Bone-name prefixes this layer is allowed to drive. Omit for every bone. */
  readonly mask?: readonly string[];
}

export interface AnimationGraphDef {
  /** Initial parameter values. Unlisted parameters read as 0. */
  readonly params?: Readonly<Record<string, number>>;
  readonly layers: readonly LayerDef[];
}

export const DEFAULT_CROSSFADE = 0.2;

/** Throws with a readable message on a malformed graph; returns it unchanged otherwise. */
export function validateGraph(graph: AnimationGraphDef): AnimationGraphDef {
  if (!graph.layers || graph.layers.length === 0) throw new Error('AnimationGraph: at least one layer is required');
  graph.layers.forEach((layer, li) => {
    const label = `layer ${li}${layer.name ? ` (${layer.name})` : ''}`;
    if (layer.states.length === 0) throw new Error(`AnimationGraph: ${label} has no states`);
    const names = new Set<string>();
    for (const state of layer.states) {
      if (names.has(state.name)) throw new Error(`AnimationGraph: ${label} has two states named "${state.name}"`);
      names.add(state.name);
      if (state.clip !== undefined && state.blend !== undefined) {
        throw new Error(`AnimationGraph: state "${state.name}" sets both clip and blend`);
      }
      if (state.blend && state.blend.points.length === 0) throw new Error(`AnimationGraph: state "${state.name}" blend has no points`);
    }
    if (!names.has(layer.entry)) throw new Error(`AnimationGraph: ${label} entry state "${layer.entry}" does not exist`);
    const check = (t: TransitionDef, from: string): void => {
      if (!names.has(t.to)) throw new Error(`AnimationGraph: ${label} transition ${from} -> "${t.to}" targets a missing state`);
      if (t.exitTime !== undefined && (t.exitTime < 0 || !Number.isFinite(t.exitTime))) {
        throw new Error(`AnimationGraph: ${label} transition ${from} -> ${t.to} has an invalid exitTime`);
      }
      if (t.duration !== undefined && t.duration < 0) throw new Error(`AnimationGraph: ${label} transition ${from} -> ${t.to} has a negative duration`);
    };
    for (const t of layer.anyState ?? []) check(t, 'anyState');
    for (const state of layer.states) for (const t of state.transitions ?? []) check(t, state.name);
  });
  return graph;
}

/** Every clip name a graph references, in first-seen order. */
export function graphClipNames(graph: AnimationGraphDef): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const layer of graph.layers) {
    for (const state of layer.states) {
      if (state.clip !== undefined) add(state.clip);
      if (state.blend) for (const p of state.blend.points) add(p.clip);
    }
  }
  return out;
}

/**
 * Weights for a 1D blend at `value` over ascending `thresholds`. Below the first
 * point the first clip gets everything, above the last the last does; between
 * two neighbours the weight is linear. Weights sum to exactly 1 (all zero for
 * an empty list).
 */
export function blend1dWeights(thresholds: readonly number[], value: number, out: number[] = []): number[] {
  const n = thresholds.length;
  out.length = n;
  for (let i = 0; i < n; i++) out[i] = 0;
  if (n === 0) return out;
  const first = thresholds[0] as number;
  const last = thresholds[n - 1] as number;
  if (n === 1 || value <= first) {
    out[0] = 1;
    return out;
  }
  if (value >= last) {
    out[n - 1] = 1;
    return out;
  }
  for (let i = 0; i < n - 1; i++) {
    const a = thresholds[i] as number;
    const b = thresholds[i + 1] as number;
    if (value >= a && value <= b) {
      const span = b - a;
      const t = span > 0 ? (value - a) / span : 1;
      out[i] = 1 - t;
      out[i + 1] = t;
      return out;
    }
  }
  out[n - 1] = 1;
  return out;
}

export function compare(op: CompareOp, a: number, b: number): boolean {
  switch (op) {
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    case '==':
      return a === b;
    case '!=':
      return a !== b;
  }
}
