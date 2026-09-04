import { describe, expect, it } from 'vitest';
import {
  PREPASS_NAME,
  SCENE_PASS_NAME,
  classifyRenderObject,
  createWarmUpCounts,
  formatWarmUp,
  totalWarmUpCount,
  trackCompilation,
} from '../src/rendering/WarmUp';

describe('classifyRenderObject', () => {
  it('routes shadow materials first, then by pass name, else post', () => {
    expect(classifyRenderObject({ scene: { name: SCENE_PASS_NAME }, material: { isShadowPassMaterial: true } })).toBe('shadow');
    expect(classifyRenderObject({ scene: { name: PREPASS_NAME }, material: {} })).toBe('prepass');
    expect(classifyRenderObject({ scene: { name: SCENE_PASS_NAME }, material: {} })).toBe('scene');
    expect(classifyRenderObject({ scene: { name: '' }, material: {} })).toBe('post');
    expect(classifyRenderObject({ scene: { name: 'Bloom' }, material: { isShadowPassMaterial: false } })).toBe('post');
  });

  it('sums counts across passes', () => {
    const counts = createWarmUpCounts();
    counts.scene = 19;
    counts.prepass = 9;
    counts.shadow = 12;
    expect(totalWarmUpCount(counts)).toBe(40);
    expect(formatWarmUp({ pipelines: 40, byPass: counts, ms: 1834 })).toBe('warm-up: 40 pipelines (shadow 12, prepass 9, scene 19) in 1.83 s');
    expect(formatWarmUp({ pipelines: 0, byPass: createWarmUpCounts(), ms: 5 })).toBe('warm-up: 0 pipelines (none) in 0.01 s');
  });
});

describe('trackCompilation', () => {
  it('reports 0/total first, then one monotonic step per settled compile, failures included', async () => {
    const resolvers: (() => void)[] = [];
    const rejecters: ((e: Error) => void)[] = [];
    const promises = [
      new Promise<void>((resolve) => resolvers.push(resolve)),
      new Promise<void>((_, reject) => rejecters.push(reject)),
      new Promise<void>((resolve) => resolvers.push(resolve)),
    ];
    const seen: string[] = [];
    let finished = false;
    const done = trackCompilation(promises, (d, t) => seen.push(`${d}/${t}`)).then(() => {
      finished = true;
    });
    expect(seen).toEqual(['0/3']);
    resolvers[1]!();
    await Promise.resolve();
    expect(seen).toEqual(['0/3', '1/3']);
    expect(finished).toBe(false);
    rejecters[0]!(new Error('validation'));
    resolvers[0]!();
    await done;
    expect(seen).toEqual(['0/3', '1/3', '2/3', '3/3']);
    expect(finished).toBe(true);
  });

  it('resolves immediately with nothing to compile', async () => {
    const seen: [number, number][] = [];
    await trackCompilation([], (d, t) => seen.push([d, t]));
    expect(seen).toEqual([[0, 0]]);
  });
});
