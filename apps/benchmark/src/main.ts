import { Engine, configFromSearch, exposeForCapture } from '@spark/engine';
import { ENGINE_HINTS, getScene, SCENE_NAMES } from './scenes/registry';

function parseSize(value: string | null): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(value);
  if (!m) return undefined;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function showError(message: string): void {
  const el = document.getElementById('error');
  if (!el) return;
  el.style.display = 'grid';
  el.textContent = message;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const sceneName = params.get('scene') ?? 'bootstrap';
  const paused = params.get('paused') === '1';
  const fixedSize = parseSize(params.get('size'));
  const container = document.getElementById('app');
  if (!container) throw new Error('#app container missing');

  const engine = new Engine({ container, ...ENGINE_HINTS[sceneName], ...configFromSearch(location.search) });
  const api = exposeForCapture(engine, sceneName);

  try {
    const definition = getScene(sceneName);
    if (!definition) throw new Error(`Unknown scene "${sceneName}". Available: ${SCENE_NAMES.join(', ')}`);
    await engine.initialize({ fixedSize });
    api.backend = engine.renderer.capabilities.backend;
    await engine.loadScene(definition);
    if (paused) {
      engine.step();
    } else {
      engine.start();
    }
    api.ready = true;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    api.error = message;
    showError(message);
    throw error;
  }
}

void main();
