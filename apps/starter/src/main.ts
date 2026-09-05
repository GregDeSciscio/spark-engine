import { Engine, configFromSearch, exposeForCapture } from '@spark/engine';
import { starterScene } from './scene';

/**
 * Boot the engine into the starter scene. `configFromSearch` reads the URL
 * options every Spark app shares (preset, backend, seed, fixedclock, overlay):
 * `?preset=low` for a slow machine, `?overlay=0` to hide the stats readout.
 */
async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('#app container missing');
  const engine = new Engine({ container, ...configFromSearch(location.search) });
  // window.__spark: the engine, stepFrames(n) and stats for the console and the capture tools.
  const api = exposeForCapture(engine, starterScene.name);
  try {
    await engine.initialize();
    api.backend = engine.renderer.capabilities.backend;
    await engine.loadScene(starterScene);
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
