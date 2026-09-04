/**
 * Cold-start shader compile bookkeeping (docs/performance/cold-start.md).
 *
 * Every material × pass variant becomes one GPU pipeline, and on Dawn/D3D
 * compiling a large TSL fragment shader takes 0.2–0.8 s each. The renderer's
 * warm-up creates them all with the asynchronous pipeline API (parallel, off
 * the GPU process's main thread) before the first real frame; this module is
 * the pure part: classifying what was compiled and tracking progress.
 */

/** Which pass a compiled render pipeline belongs to. */
export type WarmUpPass = 'shadow' | 'prepass' | 'scene' | 'post';

export const WARM_UP_PASSES: readonly WarmUpPass[] = ['shadow', 'prepass', 'scene', 'post'];

/** Scene-graph names the render pipeline gives its passes (three sets `scene.name` to the pass name while it renders). */
export const SCENE_PASS_NAME = 'Scene';
export const PREPASS_NAME = 'Prepass';

export type WarmUpCounts = Record<WarmUpPass, number>;

export interface WarmUpResult {
  /** Render pipelines the warm-up created. */
  readonly pipelines: number;
  readonly byPass: WarmUpCounts;
  /** Wall time from the first graph pass to every pipeline being ready and the GPU queue idle. */
  readonly ms: number;
}

/** The fields of a three `RenderObject` the classifier reads. */
export interface RenderObjectLike {
  readonly scene: { readonly name: string };
  readonly material: { readonly isShadowPassMaterial?: boolean };
}

export function createWarmUpCounts(): WarmUpCounts {
  return { shadow: 0, prepass: 0, scene: 0, post: 0 };
}

/** Which pass a render object's pipeline serves: shadow-map depth, the AO prepass, the scene pass, or a post quad. */
export function classifyRenderObject(renderObject: RenderObjectLike): WarmUpPass {
  if (renderObject.material.isShadowPassMaterial === true) return 'shadow';
  switch (renderObject.scene.name) {
    case PREPASS_NAME:
      return 'prepass';
    case SCENE_PASS_NAME:
      return 'scene';
    default:
      return 'post';
  }
}

export function totalWarmUpCount(counts: WarmUpCounts): number {
  let total = 0;
  for (const pass of WARM_UP_PASSES) total += counts[pass];
  return total;
}

/**
 * Wait for every compile, reporting `(done, total)` monotonically: once at
 * `0 / total`, then once per settled promise. A rejected compile still counts
 * as done (three has already logged the shader error; the object simply never
 * draws), so a broken material cannot hang the loading state.
 */
export async function trackCompilation(promises: readonly Promise<unknown>[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const total = promises.length;
  let done = 0;
  onProgress?.(0, total);
  const settle = (): void => {
    done++;
    onProgress?.(done, total);
  };
  await Promise.all(promises.map((p) => p.then(settle, settle)));
}

export function formatWarmUp(result: WarmUpResult): string {
  const parts = WARM_UP_PASSES.filter((pass) => result.byPass[pass] > 0).map((pass) => `${pass} ${result.byPass[pass]}`);
  return `warm-up: ${result.pipelines} pipelines (${parts.join(', ') || 'none'}) in ${(result.ms / 1000).toFixed(2)} s`;
}
