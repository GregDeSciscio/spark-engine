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
import { COMPAT_LIGHT_CAP, LIGHT_PROXY_NAME, LightingSystem, effectiveLightBudget, lightImportance, selectLights } from '../src/rendering/LightingSystem';
import { getQualitySettings } from '../src/rendering/QualityPresets';
import { EntityWorld } from '../src/ecs/EntityWorld';
import type { SparkRenderer } from '../src/rendering/Renderer';
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

describe('light budget on the unrolled tier', () => {
  /** A WebGL2-tier lighting system (nothing clustered), budget 4, over a row of ten unshadowed point lights 10 m apart along x. */
  function row(cameraX: number) {
    const renderer = { capabilities: { backend: 'webgl', timestampQuery: false } } as unknown as SparkRenderer;
    const lighting = new LightingSystem(new EntityWorld({ capacity: 16 }), renderer, { ...getQualitySettings('low'), maxDynamicLights: 4 });
    const scene = new THREE.Scene();
    const lights = Array.from({ length: 10 }, (_, i) => {
      const light = new THREE.PointLight(0xffffff, 10, 6);
      light.position.set(i * 10, 3, 0);
      scene.add(light);
      return light;
    });
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(cameraX, 2, 0);
    return { lighting, scene, lights, camera, world: new EntityWorld({ capacity: 16 }) };
  }
  /** Point lights the renderer would draw: visible and on a layer the default camera sees. What a program's light count is made of. */
  const rendered = (scene: THREE.Scene) => {
    const out: THREE.PointLight[] = [];
    scene.traverse((o) => {
      const l = o as THREE.PointLight;
      if (l.isPointLight && l.visible && (l.layers.mask & 1) !== 0) out.push(l);
    });
    return out;
  };
  /** Which real lights (by index) the proxies are copying, from their positions. */
  const copied = (scene: THREE.Scene) =>
    rendered(scene)
      .filter((l) => l.intensity > 0)
      .map((l) => Math.round(l.position.x / 10))
      .sort((a, b) => a - b);

  it('draws a fixed pool of proxies instead of the real lights, picked near the camera before anything has rendered', () => {
    const { lighting, scene, lights, camera } = row(90);
    // No render has updated a world matrix. Read stale, every light and the
    // camera sit at the origin and the tie-break picks 0 to 3.
    lighting.attach(scene, camera);
    const drawn = rendered(scene);
    expect(drawn).toHaveLength(4);
    expect(drawn.every((l) => l.name === LIGHT_PROXY_NAME)).toBe(true);
    expect(copied(scene)).toEqual([6, 7, 8, 9]);
    // The real lights are off by layer, not by `visible`, which stays the scene's switch.
    expect(lights.every((l) => l.visible)).toBe(true);
    expect(lighting.getStats()).toMatchObject({ active: 4, culled: 6, unrolled: 4, clusteredPath: false });
  });

  it('moves the selection through uniforms: the renderer sees the same four lights wherever the camera goes', () => {
    const { lighting, scene, camera, world } = row(0);
    lighting.attach(scene, camera);
    const proxies = rendered(scene);
    expect(copied(scene)).toEqual([0, 1, 2, 3]);
    for (const x of [30, 60, 90]) {
      camera.position.x = x;
      camera.updateMatrixWorld();
      lighting.run(world);
      // Same objects, same count: no program changes, only their values.
      expect(rendered(scene)).toEqual(proxies);
    }
    expect(copied(scene)).toEqual([6, 7, 8, 9]);
  });

  it('lets a flash take a slot for as long as it is lit, then gives it back', () => {
    const { lighting, scene, lights, camera, world } = row(0);
    lighting.attach(scene, camera);
    const far = lights[9] as THREE.PointLight;
    far.intensity = 50_000;
    lighting.run(world);
    expect(copied(scene)).toContain(9);
    expect(rendered(scene)).toHaveLength(4);
    far.intensity = 0;
    lighting.run(world);
    expect(copied(scene)).toEqual([0, 1, 2, 3]);
  });

  it('is not undone by another system turning the real lights back on every frame', () => {
    const { lighting, scene, lights, camera, world } = row(0);
    lighting.attach(scene, camera);
    for (let frame = 0; frame < 3; frame++) {
      // What RenderSync does to entity-attached lights before this system runs.
      for (const l of lights) l.visible = true;
      lighting.run(world);
      expect(rendered(scene)).toHaveLength(4);
    }
  });

  it('still counts every real light, drawn or not, for the gameplay light query', () => {
    const { lighting, scene, camera } = row(0);
    lighting.attach(scene, camera);
    // Light 9 is far from the camera and not in the pool; standing under it is still standing in its light.
    expect(lighting.illuminanceAt(new THREE.Vector3(90, 1, 0))).toBeGreaterThan(0);
    expect(lighting.illuminanceAt(new THREE.Vector3(45, 1, 40))).toBe(0);
  });

  it('gives the lights back on detach', () => {
    const { lighting, scene, lights, camera } = row(0);
    lighting.attach(scene, camera);
    lighting.detach();
    expect(rendered(scene)).toEqual(lights);
  });
});
