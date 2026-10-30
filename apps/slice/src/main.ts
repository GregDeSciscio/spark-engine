import { Engine, configFromSearch, exposeForCapture } from '@spark/engine';
import { sliceScene } from './scene';

/**
 * Boot Spark into the destruction slice. Spark's shared URL options apply
 * (`preset`, `backend`, `seed`, `fixedclock`, `overlay`): under `fixedclock`
 * the strain solves run inline and a run is deterministic.
 */
async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('#app container missing');
  // At most two physics steps a frame: a dear collapse step slows the sim a moment instead of the loop falling behind.
  const engine = new Engine({ container, maxSubSteps: 2, ...configFromSearch(location.search) });
  const api = exposeForCapture(engine, 'slice');
  try {
    await engine.initialize();
    api.backend = engine.renderer.capabilities.backend;
    await engine.loadScene(sliceScene((game) => (api.game = game)));
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
