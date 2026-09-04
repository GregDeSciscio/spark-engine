import * as THREE from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { Disposable } from '../core/Disposable';
import type { SparkRenderer } from './Renderer';

/**
 * Image-based lighting helpers. Both return a disposable that releases the
 * PMREM target and clears `scene.environment` if it still points at it.
 */

function install(scene: THREE.Scene, target: THREE.RenderTarget, intensity: number, pmrem: THREE.PMREMGenerator, extra?: () => void): Disposable {
  scene.environment = target.texture;
  scene.environmentIntensity = intensity;
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (scene.environment === target.texture) scene.environment = null;
      target.dispose();
      pmrem.dispose();
      extra?.();
    },
  };
}

/** Neutral studio environment (three's RoomEnvironment) prefiltered for PBR. */
export function applyRoomEnvironment(renderer: SparkRenderer, scene: THREE.Scene, intensity = 1): Disposable {
  const pmrem = new THREE.PMREMGenerator(renderer.three);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  return install(scene, target, intensity, pmrem);
}

/**
 * Prefilter an arbitrary scene (e.g. a dark room with a few emissive panels)
 * into an environment map. Cheap way to get scene-specific reflections before
 * real HDRIs or reflection probes exist. The source scene is not disposed.
 */
export function applySceneEnvironment(renderer: SparkRenderer, scene: THREE.Scene, source: THREE.Scene, intensity = 1): Disposable {
  const pmrem = new THREE.PMREMGenerator(renderer.three);
  const target = pmrem.fromScene(source, 0.04);
  return install(scene, target, intensity, pmrem);
}

/** Load an equirectangular .hdr and use it as the scene environment (and optionally background). */
export async function loadHDREnvironment(
  renderer: SparkRenderer,
  scene: THREE.Scene,
  url: string,
  options: { intensity?: number; background?: boolean } = {},
): Promise<Disposable> {
  const loader = new HDRLoader();
  const equirect = await loader.loadAsync(url);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer.three);
  const target = pmrem.fromEquirectangular(equirect);
  if (options.background) scene.background = equirect;
  const disposable = install(scene, target, options.intensity ?? 1, pmrem, () => {
    if (scene.background === equirect) scene.background = null;
    equirect.dispose();
  });
  if (!options.background) equirect.dispose();
  return disposable;
}
