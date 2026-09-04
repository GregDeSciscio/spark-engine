import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  CLUSTERED_LIGHT_CAPACITY,
  CLUSTER_PRESETS,
  clusterCount,
  clusterGridForPreset,
  clusterStorageBytes,
  isClusterableLight,
} from '../src/rendering/ClusteredLights';
import { COMPAT_LIGHT_CAP, effectiveLightBudget, lightImportance, selectLights } from '../src/rendering/LightingSystem';
import { QUALITY_PRESETS } from '../src/core/Config';

describe('light importance', () => {
  it('is the intensity inside the light radius and falls off with the squared gap outside it', () => {
    expect(lightImportance(10, 3, 5)).toBe(10);
    expect(lightImportance(10, 5, 5)).toBe(10);
    expect(lightImportance(10, 6, 5)).toBeCloseTo(10 / 2, 9);
    expect(lightImportance(10, 8, 5)).toBeCloseTo(10 / 10, 9);
  });

  it('treats an unbounded (distance 0) light as a point at its position and never goes negative', () => {
    expect(lightImportance(4, 2, 0)).toBeCloseTo(4 / 5, 9);
    expect(lightImportance(-3, 0, 0)).toBe(0);
  });
});

describe('light budget selection', () => {
  it('keeps the most important lights up to the budget and switches the rest off', () => {
    const selected = selectLights([1, 5, 3, 4, 2], 2);
    expect(selected).toEqual([false, true, false, true, false]);
  });

  it('keeps everything under budget and nothing at budget 0', () => {
    expect(selectLights([1, 2, 3], 8)).toEqual([true, true, true]);
    expect(selectLights([1, 2, 3], 0)).toEqual([false, false, false]);
    expect(selectLights([], 4)).toEqual([]);
  });

  it('breaks ties toward the lower index, deterministically', () => {
    expect(selectLights([2, 2, 2, 2], 2)).toEqual([true, true, false, false]);
    expect(selectLights([2, 2, 2, 2], 2)).toEqual(selectLights([2, 2, 2, 2], 2));
  });

  it('hysteresis keeps an active light against a marginally better challenger', () => {
    const active = [true, false];
    expect(selectLights([1.0, 1.1], 1, active, 1.25)).toEqual([true, false]);
    expect(selectLights([1.0, 1.1], 1, active, 1)).toEqual([false, true]);
    // A clearly better challenger still swaps in.
    expect(selectLights([1.0, 2.0], 1, active, 1.25)).toEqual([false, true]);
  });
});

describe('effective light budget', () => {
  it('caps at the clustered capacity on WebGPU and at the compat cap on WebGL2', () => {
    expect(effectiveLightBudget(64, true)).toBe(64);
    expect(effectiveLightBudget(1024, true)).toBe(CLUSTERED_LIGHT_CAPACITY);
    expect(effectiveLightBudget(64, false)).toBe(COMPAT_LIGHT_CAP);
    expect(effectiveLightBudget(3, false)).toBe(3);
    expect(effectiveLightBudget(-2, true)).toBe(0);
    expect(effectiveLightBudget(7.9, true)).toBe(7);
  });
});

describe('cluster grid', () => {
  it('sizes the high preset like three\'s default 32 px tiles at 1080p', () => {
    const grid = clusterGridForPreset('high');
    expect(grid).toEqual({ tilesX: 60, tilesY: 34, zSlices: 24, maxLightsPerCluster: 32 });
    expect(clusterCount(grid)).toBe(60 * 34 * 24);
    expect(clusterStorageBytes(grid)).toBe(60 * 34 * 24 * 8 * 16);
  });

  it('gets coarser on lower presets and finer on higher ones', () => {
    const cells = QUALITY_PRESETS.map((p) => clusterCount(clusterGridForPreset(p)));
    for (let i = 1; i < cells.length; i++) expect(cells[i]).toBeGreaterThanOrEqual(cells[i - 1] as number);
    expect(CLUSTER_PRESETS.low.maxLightsPerCluster).toBeLessThanOrEqual(CLUSTER_PRESETS.ultra.maxLightsPerCluster);
  });

  it('never produces an empty grid, whatever the reference size', () => {
    const grid = clusterGridForPreset('low', { width: 1, height: 1 });
    expect(grid.tilesX).toBe(1);
    expect(grid.tilesY).toBe(1);
    expect(clusterCount(grid)).toBe(grid.zSlices);
  });

  it('keeps the per-cluster storage of every preset at or under 16 MB', () => {
    for (const p of QUALITY_PRESETS) expect(clusterStorageBytes(clusterGridForPreset(p))).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(clusterStorageBytes(clusterGridForPreset('high'))).toBe(6_266_880);
  });
});

describe('clusterable lights', () => {
  it('takes unshadowed point and spot lights and leaves everything else on the material path', () => {
    expect(isClusterableLight(new THREE.PointLight())).toBe(true);
    expect(isClusterableLight(new THREE.SpotLight())).toBe(true);
    const shadowed = new THREE.PointLight();
    shadowed.castShadow = true;
    expect(isClusterableLight(shadowed)).toBe(false);
    const projected = new THREE.SpotLight();
    projected.map = new THREE.Texture();
    expect(isClusterableLight(projected)).toBe(false);
    expect(isClusterableLight(new THREE.DirectionalLight())).toBe(false);
    expect(isClusterableLight(new THREE.HemisphereLight())).toBe(false);
    expect(isClusterableLight(new THREE.AmbientLight())).toBe(false);
  });
});
