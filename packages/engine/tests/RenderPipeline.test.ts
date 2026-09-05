import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import { RenderPipeline, type StylizeStage } from '../src/rendering/RenderPipeline';
import { getQualitySettings } from '../src/rendering/QualityPresets';

/** three's RenderPipeline only stores the renderer at construction; nothing here renders. */
function makePipeline(): RenderPipeline {
  return new RenderPipeline({} as unknown as THREE.WebGPURenderer, 'webgpu', getQualitySettings('high'));
}

describe('RenderPipeline stylize stage', () => {
  it('is listed as an effect, unavailable until a stage is set, and removable', () => {
    const pipeline = makePipeline();
    const before = pipeline.getEffects().find((e) => e.name === 'stylize');
    expect(before).toEqual({ name: 'stylize', enabled: true, available: false });
    expect(pipeline.getStylize()).toBeNull();

    const stage: StylizeStage = ({ color }) => color;
    pipeline.setStylize(stage);
    expect(pipeline.getStylize()).toBe(stage);
    expect(pipeline.isAvailable('stylize')).toBe(true);

    pipeline.setEffectEnabled('stylize', false);
    expect(pipeline.isEffectEnabled('stylize')).toBe(false);
    expect(pipeline.isAvailable('stylize')).toBe(true);

    pipeline.setStylize(null);
    expect(pipeline.getStylize()).toBeNull();
    expect(pipeline.isAvailable('stylize')).toBe(false);
  });

  it('sits between the grade and FXAA in the effect order', () => {
    const pipeline = makePipeline();
    const names = pipeline.getEffects().map((e) => e.name);
    expect(names.indexOf('stylize')).toBe(names.indexOf('grade') + 1);
    expect(names.indexOf('fxaa')).toBe(names.indexOf('stylize') + 1);
  });
});
