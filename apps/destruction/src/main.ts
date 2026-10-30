import { Engine, configFromSearch, exposeForCapture } from '@spark/engine';
import { sandboxScene } from './scene';

/**
 * Boot Spark into the destruction sandbox. Spark's shared URL options apply
 * (`preset`, `backend`, `fixedclock`, `overlay`, …). The strain solve runs in
 * a worker; `strain=inline` puts it on the main thread, and `fixedclock` does
 * so on its own, so fixed-clock captures are deterministic.
 */
async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('#app container missing');
  const params = new URLSearchParams(location.search);
  // At most two physics steps per frame: if a collapse makes a step dear, the sim slows for a moment
  // instead of the loop running ever more catch-up steps (and frames) behind.
  const engine = new Engine({ container, maxSubSteps: 2, ...configFromSearch(location.search) });
  const api = exposeForCapture(engine, 'destruction-sandbox');
  try {
    await engine.initialize();
    api.backend = engine.renderer.capabilities.backend;
    const strain = params.get('strain') === 'inline' ? 'inline' : 'worker';
    const statsShown = (): boolean => engine.stats?.isVisible ?? false;
    await engine.loadScene(sandboxScene({ strain, tower: params.get('tower') === '1', statsShown }, (game) => (api.game = game)));
    engine.start();
    api.ready = true;
  } catch (error) {
    api.error = error instanceof Error ? error.message : String(error);
    const el = document.getElementById('error');
    if (el) {
      el.style.display = 'grid';
      el.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    throw error;
  }
}

void main();
