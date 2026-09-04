import { describe, expect, it } from 'vitest';
import { blend1dWeights, graphClipNames, validateGraph, type AnimationGraphDef } from '../src/animation/AnimationGraph';
import { rootMotionDelta, rotateByQuaternion, sampleVec3, type Vec3Tuple } from '../src/animation/RootMotion';
import { AnimatorPlayback, type ClipInfo, type FiredEvent, type LayerStateMachine } from '../src/animation/StateMachine';

// Pure-logic tests: no three, no DOM. The state machine, blend math, crossfade
// ramps, event crossing and root-motion extraction are all exercised here.

const DT = 1 / 60;

const CLIPS = new Map<string, ClipInfo>([
  ['idle', { name: 'idle', duration: 2.0, events: [] }],
  [
    'walk',
    {
      name: 'walk',
      duration: 1.0,
      events: [
        { name: 'footstep', time: 0.25, foot: 'L' },
        { name: 'footstep', time: 0.75, foot: 'R' },
      ],
    },
  ],
  ['run', { name: 'run', duration: 0.5, events: [{ name: 'footstep', time: 0.1 }] }],
  ['attack', { name: 'attack', duration: 0.6, loop: false, events: [{ name: 'hit', time: 0.3 }] }],
  ['hit', { name: 'hit', duration: 0.4, loop: false, events: [{ name: 'flinch', time: 0.05 }] }],
  ['death', { name: 'death', duration: 1.2, loop: false, events: [{ name: 'land', time: 0.7 }] }],
]);

const GRAPH: AnimationGraphDef = {
  params: { speed: 0, dead: 0 },
  layers: [
    {
      name: 'base',
      entry: 'locomotion',
      states: [
        {
          name: 'locomotion',
          blend: {
            param: 'speed',
            points: [
              { clip: 'idle', threshold: 0 },
              { clip: 'walk', threshold: 1 },
              { clip: 'run', threshold: 4 },
            ],
          },
        },
        { name: 'hit', clip: 'hit', transitions: [{ to: 'locomotion', exitTime: 1, duration: 0.1 }] },
        { name: 'death', clip: 'death', transitions: [{ to: 'locomotion', conditions: [{ trigger: 'respawn' }], duration: 0.2 }] },
      ],
      anyState: [
        { to: 'death', conditions: [{ trigger: 'die' }], duration: 0.1 },
        { to: 'hit', conditions: [{ trigger: 'hit' }, { param: 'dead', op: '==', value: 0 }], duration: 0.05, allowSelf: true },
      ],
    },
    {
      name: 'upper',
      entry: 'none',
      mask: ['chest', 'upperArm_R'],
      states: [{ name: 'none' }, { name: 'attack', clip: 'attack', transitions: [{ to: 'none', exitTime: 1, duration: 0.1 }] }],
      anyState: [{ to: 'attack', conditions: [{ trigger: 'attack' }], duration: 0 }],
    },
  ],
};

function stepFor(pb: AnimatorPlayback, seconds: number, dt = DT): FiredEvent[] {
  const fired: FiredEvent[] = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    pb.step(dt);
    fired.push(...pb.fired);
  }
  return fired;
}

function sumWeights(layer: LayerStateMachine): number {
  return layer.samples.reduce((n, s) => n + s.weight, 0);
}

describe('AnimationGraph', () => {
  it('validates entry, duplicate states and dangling transitions', () => {
    expect(() => validateGraph({ layers: [] })).toThrow(/at least one layer/);
    expect(() => validateGraph({ layers: [{ entry: 'x', states: [{ name: 'a' }] }] })).toThrow(/entry state "x"/);
    expect(() => validateGraph({ layers: [{ entry: 'a', states: [{ name: 'a' }, { name: 'a' }] }] })).toThrow(/two states named/);
    expect(() => validateGraph({ layers: [{ entry: 'a', states: [{ name: 'a', transitions: [{ to: 'nope' }] }] }] })).toThrow(/missing state/);
    expect(() => validateGraph({ layers: [{ entry: 'a', states: [{ name: 'a', clip: 'x', blend: { param: 'p', points: [] } }] }] })).toThrow(/both clip and blend/);
    expect(validateGraph(GRAPH)).toBe(GRAPH);
    expect(graphClipNames(GRAPH)).toEqual(['idle', 'walk', 'run', 'hit', 'death', 'attack']);
  });

  it('rejects graphs whose clips the model does not have', () => {
    expect(() => new AnimatorPlayback({ layers: [{ entry: 'a', states: [{ name: 'a', clip: 'missing' }] }] }, CLIPS)).toThrow(/unknown clip "missing"/);
  });
});

describe('blend1dWeights', () => {
  const thresholds = [0, 1, 4];

  it('clamps to the endpoints', () => {
    expect(blend1dWeights(thresholds, -3)).toEqual([1, 0, 0]);
    expect(blend1dWeights(thresholds, 0)).toEqual([1, 0, 0]);
    expect(blend1dWeights(thresholds, 4)).toEqual([0, 0, 1]);
    expect(blend1dWeights(thresholds, 99)).toEqual([0, 0, 1]);
  });

  it('is linear between neighbours and always sums to 1', () => {
    expect(blend1dWeights(thresholds, 0.5)).toEqual([0.5, 0.5, 0]);
    expect(blend1dWeights(thresholds, 1)).toEqual([0, 1, 0]);
    const mid = blend1dWeights(thresholds, 2.5);
    expect(mid[0]).toBe(0);
    expect(mid[1]).toBeCloseTo(0.5);
    expect(mid[2]).toBeCloseTo(0.5);
    for (let v = -1; v <= 5; v += 0.37) {
      const w = blend1dWeights(thresholds, v);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles degenerate lists', () => {
    expect(blend1dWeights([], 1)).toEqual([]);
    expect(blend1dWeights([2], 0)).toEqual([1]);
    expect(blend1dWeights([1, 1], 1)).toEqual([1, 0]);
  });
});

describe('LayerStateMachine: transitions', () => {
  it('starts in the entry state with full weight and samples the blend tree', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    expect(pb.getState()).toBe('locomotion');
    pb.step(DT);
    const base = pb.layers[0] as LayerStateMachine;
    expect(base.samples.map((s) => s.clip)).toEqual(['idle']);
    expect(sumWeights(base)).toBeCloseTo(1);
    pb.setParam('speed', 2.5);
    pb.step(DT);
    expect(base.samples.map((s) => s.clip).sort()).toEqual(['run', 'walk']);
    expect(sumWeights(base)).toBeCloseTo(1);
  });

  it('fires condition transitions and consumes the trigger on use', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.setTrigger('hit');
    expect(pb.hasTrigger('hit')).toBe(true);
    pb.step(DT);
    expect(pb.getState()).toBe('hit');
    expect(pb.hasTrigger('hit')).toBe(false);
    expect(pb.transitions).toEqual([{ layer: 0, from: 'locomotion', to: 'hit' }]);
  });

  it('keeps an unconsumed trigger until a transition can use it', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.setParam('dead', 1);
    pb.setTrigger('hit'); // blocked by dead == 0
    stepFor(pb, 0.5);
    expect(pb.getState()).toBe('locomotion');
    expect(pb.hasTrigger('hit')).toBe(true);
    pb.setParam('dead', 0);
    pb.step(DT);
    expect(pb.getState()).toBe('hit');
    expect(pb.hasTrigger('hit')).toBe(false);
    pb.setTrigger('hit');
    pb.resetTrigger('hit');
    expect(pb.hasTrigger('hit')).toBe(false);
  });

  it('evaluates parameter comparisons', () => {
    const graph: AnimationGraphDef = {
      layers: [
        {
          entry: 'a',
          states: [
            { name: 'a', clip: 'idle', transitions: [{ to: 'b', conditions: [{ param: 'x', op: '>=', value: 2 }], duration: 0 }] },
            { name: 'b', clip: 'walk', transitions: [{ to: 'a', conditions: [{ param: 'x', op: '<', value: 1 }], duration: 0 }] },
          ],
        },
      ],
    };
    const pb = new AnimatorPlayback(graph, CLIPS);
    pb.setParam('x', 1.99);
    pb.step(DT);
    expect(pb.getState()).toBe('a');
    pb.setParam('x', 2);
    pb.step(DT);
    expect(pb.getState()).toBe('b');
    pb.setParam('x', 1);
    pb.step(DT);
    expect(pb.getState()).toBe('b');
    pb.setParam('x', 0.5);
    pb.step(DT);
    expect(pb.getState()).toBe('a');
  });

  it('one-shot states exit at exitTime = 1 after the clip end, never earlier', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.setTrigger('hit');
    pb.step(DT);
    expect(pb.getState()).toBe('hit');
    // hit is 0.4 s: still in hit at 0.35 s, back in locomotion once 0.4 s has elapsed.
    stepFor(pb, 0.35);
    expect(pb.getState()).toBe('hit');
    stepFor(pb, 0.1);
    expect(pb.getState()).toBe('locomotion');
  });

  it('looping states with an exitTime fire once per loop when playback crosses it', () => {
    const graph: AnimationGraphDef = {
      layers: [
        {
          entry: 'walk',
          states: [
            { name: 'walk', clip: 'walk', transitions: [{ to: 'idle', exitTime: 0.5, conditions: [{ param: 'stop', op: '==', value: 1 }], duration: 0 }] },
            { name: 'idle', clip: 'idle' },
          ],
        },
      ],
    };
    const pb = new AnimatorPlayback(graph, CLIPS);
    // Condition true but exit time (0.5 s of a 1 s clip) not yet reached.
    pb.setParam('stop', 1);
    stepFor(pb, 0.4);
    expect(pb.getState()).toBe('walk');
    // Miss the crossing (condition false while 0.5 passes), then it must wait for the next loop.
    pb.setParam('stop', 0);
    stepFor(pb, 0.2);
    pb.setParam('stop', 1);
    stepFor(pb, 0.3); // t = 0.9: no crossing yet
    expect(pb.getState()).toBe('walk');
    stepFor(pb, 0.7); // t = 1.6: crossed 1.5
    expect(pb.getState()).toBe('idle');
  });

  it('gives anyState transitions priority over the current state, in declared order', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    // hit's own exit-time transition is ready, but a die trigger wins.
    pb.setTrigger('hit');
    pb.step(DT);
    stepFor(pb, 0.45);
    expect(pb.getState()).toBe('locomotion');
    pb.setTrigger('hit');
    pb.step(DT);
    pb.setTrigger('die');
    pb.setTrigger('hit'); // both pending: die is declared first
    pb.step(DT);
    expect(pb.getState()).toBe('death');
    expect(pb.hasTrigger('die')).toBe(false);
    // The losing trigger stays pending; with dead=1 its transition is blocked for the whole clip.
    expect(pb.hasTrigger('hit')).toBe(true);
    pb.setParam('dead', 1);
    stepFor(pb, 1.5);
    expect(pb.getState()).toBe('death');
    expect(pb.snapshot().normalizedTime).toBe(1); // held on the last frame
    // Once dead is cleared the pending hit fires before the respawn (anyState order), unless reset.
    pb.resetTrigger('hit');
    pb.setParam('dead', 0);
    pb.setTrigger('respawn');
    pb.step(DT);
    expect(pb.getState()).toBe('locomotion');
  });

  it('anyState does not re-enter the current state unless allowSelf, and restarts it when it does', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.setTrigger('die');
    pb.step(DT);
    stepFor(pb, 0.5);
    pb.setTrigger('die');
    pb.step(DT);
    expect(pb.getState()).toBe('death');
    expect(pb.transitions).toEqual([]); // no self transition
    expect(pb.hasTrigger('die')).toBe(true); // and the trigger was not consumed
    pb.resetTrigger('die');

    const pb2 = new AnimatorPlayback(GRAPH, CLIPS);
    pb2.setTrigger('hit');
    pb2.step(DT);
    stepFor(pb2, 0.2);
    expect(pb2.snapshot().phase).toBeGreaterThan(0.4);
    pb2.setTrigger('hit');
    pb2.step(DT);
    expect(pb2.transitions).toEqual([{ layer: 0, from: 'hit', to: 'hit' }]);
    expect(pb2.snapshot().phase).toBe(0);
  });

  it('play() forces a state and honours offset', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.play('death', 0, { duration: 0, offset: 0.5 });
    expect(pb.getState()).toBe('death');
    expect(pb.snapshot().phase).toBe(0.5);
    pb.step(DT);
    expect((pb.layers[0] as LayerStateMachine).samples).toEqual([expect.objectContaining({ clip: 'death', weight: 1 })]);
  });

  it('runs layers independently on shared parameters', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.setParam('speed', 1);
    pb.setTrigger('attack');
    pb.step(DT);
    expect(pb.getState(0)).toBe('locomotion');
    expect(pb.getState(1)).toBe('attack');
    expect((pb.layers[1] as LayerStateMachine).samples).toEqual([expect.objectContaining({ clip: 'attack', weight: 1 })]);
    stepFor(pb, 0.7);
    expect(pb.getState(1)).toBe('none');
    stepFor(pb, 0.2);
    expect((pb.layers[1] as LayerStateMachine).samples).toEqual([]);
  });
});

describe('LayerStateMachine: crossfades', () => {
  it('ramps the new state in and the old state out, weights summing to 1 throughout', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    const base = pb.layers[0] as LayerStateMachine;
    pb.setTrigger('die'); // 0.1 s crossfade
    pb.step(DT);
    // On the step the transition begins the new state has no weight yet.
    expect(base.transitioning).toBe(true);
    expect(base.snapshot().weight).toBe(0);
    expect(sumWeights(base)).toBeCloseTo(1);
    const weights: number[] = [];
    for (let i = 0; i < 6; i++) {
      pb.step(DT);
      weights.push(base.snapshot().weight);
      expect(sumWeights(base)).toBeCloseTo(1, 6);
    }
    expect(weights[0]).toBeCloseTo(DT / 0.1);
    expect(weights[2]).toBeCloseTo((3 * DT) / 0.1);
    for (let i = 1; i < weights.length; i++) expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1] as number);
    expect(weights[5]).toBe(1);
    expect(base.transitioning).toBe(false);
    expect(base.samples.map((s) => s.clip)).toEqual(['death']);
  });

  it('an interrupted crossfade keeps the total at 1 and fades the interrupted states out', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    const base = pb.layers[0] as LayerStateMachine;
    pb.setParam('speed', 1); // walk
    pb.setTrigger('hit'); // 0.05 s
    pb.step(DT);
    pb.step(DT); // hit weight = 1/3, walk 2/3
    expect(base.snapshot().weight).toBeCloseTo(DT / 0.05);
    pb.setTrigger('die'); // 0.1 s, interrupts
    pb.step(DT);
    expect(pb.getState()).toBe('death');
    expect(sumWeights(base)).toBeCloseTo(1);
    const byClip = new Map(base.samples.map((s) => [s.clip, s.weight]));
    expect(byClip.get('hit')).toBeCloseTo(1 / 3);
    expect(byClip.get('walk')).toBeCloseTo(2 / 3);
    pb.step(DT);
    expect(sumWeights(base)).toBeCloseTo(1);
    const after = new Map(base.samples.map((s) => [s.clip, s.weight]));
    expect(after.get('death')).toBeCloseTo(DT / 0.1);
    expect(after.get('hit')).toBeCloseTo((1 / 3) * (1 - DT / 0.1));
    expect(after.get('walk')).toBeCloseTo((2 / 3) * (1 - DT / 0.1));
  });

  it('a zero-duration transition snaps', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.setTrigger('attack');
    pb.step(DT);
    const upper = pb.layers[1] as LayerStateMachine;
    expect(upper.transitioning).toBe(false);
    expect(upper.snapshot().weight).toBe(1);
  });
});

describe('animation events', () => {
  const walkOnly: AnimationGraphDef = { layers: [{ entry: 'walk', states: [{ name: 'walk', clip: 'walk' }] }] };

  it('fires each marker exactly once per loop at 60 Hz', () => {
    const pb = new AnimatorPlayback(walkOnly, CLIPS);
    const fired = stepFor(pb, 3.0); // three loops of a 1 s clip
    expect(fired.map((e) => e.marker.foot)).toEqual(['L', 'R', 'L', 'R', 'L', 'R']);
    expect(fired[0]).toMatchObject({ name: 'footstep', clip: 'walk', state: 'walk', layer: 0, time: 0.25 });
  });

  it('never skips a marker at a low frame rate: one step crossing several markers fires them all', () => {
    const pb = new AnimatorPlayback(walkOnly, CLIPS);
    pb.step(0.9); // crosses 0.25 and 0.75
    expect(pb.fired.map((e) => e.marker.foot)).toEqual(['L', 'R']);
    pb.step(0.9); // 0.9 -> 1.8: crosses 1.25 and 1.75 (wrap)
    expect(pb.fired.map((e) => e.marker.foot)).toEqual(['L', 'R']);
  });

  it('a step wrapping the clip end more than once fires every crossing', () => {
    const pb = new AnimatorPlayback(walkOnly, CLIPS);
    pb.step(0.5); // t = 0.5: L
    expect(pb.fired.length).toBe(1);
    pb.step(2.3); // 0.5 -> 2.8: 0.75, 1.25, 1.75, 2.25, 2.75
    expect(pb.fired.map((e) => e.marker.foot)).toEqual(['R', 'L', 'R', 'L', 'R']);
    const sample = (pb.layers[0] as LayerStateMachine).samples[0];
    expect(sample?.loops).toBe(2);
    expect(sample?.prevTime).toBeCloseTo(0.5);
    expect(sample?.time).toBeCloseTo(0.8);
  });

  it('fires a marker sitting exactly on the entry phase, and clip-end markers once', () => {
    const clips = new Map(CLIPS);
    clips.set('clap', { name: 'clap', duration: 1, events: [{ name: 'start', time: 0 }, { name: 'end', time: 1 }], loop: false });
    const pb = new AnimatorPlayback({ layers: [{ entry: 'clap', states: [{ name: 'clap', clip: 'clap' }] }] }, clips);
    const fired = stepFor(pb, 1.5);
    expect(fired.map((e) => e.name)).toEqual(['start', 'end']);
  });

  it('one-shot events fire once and never again while the pose holds', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.setTrigger('die');
    pb.step(DT);
    const fired = stepFor(pb, 2.0);
    expect(fired.map((e) => e.name)).toEqual(['land']);
    expect(fired[0]?.time).toBe(0.7);
  });

  it('uses the dominant clip of a blend tree for events', () => {
    const pb = new AnimatorPlayback(GRAPH, CLIPS);
    pb.setParam('speed', 3.9); // mostly run (0.5 s, one marker per loop)
    const fired = stepFor(pb, 1.0);
    expect(fired.every((e) => e.clip === 'run')).toBe(true);
    expect(fired.length).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic: the same dt sequence produces the same events and samples', () => {
    const run = (): string => {
      const pb = new AnimatorPlayback(GRAPH, CLIPS);
      const out: string[] = [];
      for (let i = 0; i < 240; i++) {
        pb.setParam('speed', (i % 90) / 30);
        if (i === 40) pb.setTrigger('attack');
        if (i === 100) pb.setTrigger('hit');
        if (i === 180) pb.setTrigger('die');
        pb.step(DT);
        out.push(pb.fired.map((e) => `${e.layer}:${e.name}@${i}`).join(','));
        for (const layer of pb.layers) out.push(layer.samples.map((s) => `${s.clip}:${s.time.toFixed(5)}:${s.weight.toFixed(5)}`).join('|'));
      }
      return out.join('\n');
    };
    expect(run()).toBe(run());
  });
});

describe('root motion', () => {
  // A root track moving 1.2 m along +Z over a 1 s loop, plus a bump in Y.
  const track = { times: [0, 0.5, 1], values: [0, 0, 0, 0, 0.1, 0.6, 0, 0, 1.2] };

  it('samples linearly and clamps', () => {
    const close = (a: readonly number[], b: readonly number[]): void => {
      expect(a.length).toBe(b.length);
      a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 10));
    };
    close(sampleVec3(track, -1), [0, 0, 0]);
    close(sampleVec3(track, 0.25), [0, 0.05, 0.3]);
    close(sampleVec3(track, 0.75), [0, 0.05, 0.9]);
    close(sampleVec3(track, 7), [0, 0, 1.2]);
    expect(sampleVec3({ times: [], values: [] }, 0.3)).toEqual([0, 0, 0]);
    expect(sampleVec3({ times: [0], values: [1, 2, 3] }, 5)).toEqual([1, 2, 3]);
  });

  it('extracts the in-loop delta', () => {
    const out: Vec3Tuple = [0, 0, 0];
    rootMotionDelta(track, 0.25, 0.75, 0, 1, out);
    expect(out[2]).toBeCloseTo(0.6);
    expect(out[1]).toBeCloseTo(0);
  });

  it('accounts for the wrap so a loop boundary never jumps backwards', () => {
    const out: Vec3Tuple = [0, 0, 0];
    rootMotionDelta(track, 0.9, 0.1, 1, 1, out);
    expect(out[2]).toBeCloseTo(0.24); // 0.9 -> 1.0 (0.12) + 0.0 -> 0.1 (0.12)
    const multi: Vec3Tuple = [0, 0, 0];
    rootMotionDelta(track, 0.5, 0.8, 2, 1, multi);
    expect(multi[2]).toBeCloseTo(0.6 + 1.2 + 0.96); // tail + one whole loop + head
  });

  it('scales by weight and accumulates, so blended clips sum their motion', () => {
    const out: Vec3Tuple = [0, 0, 0];
    rootMotionDelta(track, 0, 0.5, 0, 1, out, 0.25);
    rootMotionDelta({ times: [0, 1], values: [0, 0, 0, 0, 0, 2.8] }, 0, 0.5, 0, 1, out, 0.75);
    expect(out[2]).toBeCloseTo(0.25 * 0.6 + 0.75 * 1.4);
  });

  it('agrees with the per-step sum over a whole loop at 60 Hz', () => {
    const pb = new AnimatorPlayback({ layers: [{ entry: 'walk', states: [{ name: 'walk', clip: 'walk' }] }] }, CLIPS);
    const total: Vec3Tuple = [0, 0, 0];
    for (let i = 0; i < 120; i++) {
      pb.step(DT);
      for (const s of (pb.layers[0] as LayerStateMachine).samples) rootMotionDelta(track, s.prevTime, s.time, s.loops, 1, total, s.weight);
    }
    expect(total[2]).toBeCloseTo(2.4, 5);
    expect(total[1]).toBeCloseTo(0, 5);
  });

  it('rotates deltas into the entity facing', () => {
    const half = Math.PI / 4; // 90 degrees about Y
    const v = rotateByQuaternion([0, 0, 1], 0, Math.sin(half), 0, Math.cos(half));
    expect(v[0]).toBeCloseTo(1);
    expect(v[2]).toBeCloseTo(0);
    const identity = rotateByQuaternion([1, 2, 3], 0, 0, 0, 1);
    expect(identity).toEqual([1, 2, 3]);
  });
});
