import { Engine, configFromSearch, exposeForCapture } from '@spark/engine';
import { missionScene } from './scenes/mission';

/**
 * The showcase boots straight into the mission: there is one game here, not a
 * menu of scenes. The same URL options as the benchmark apply (preset, backend,
 * seed, size, paused, fixedclock, overlay) so the capture and perf tools can
 * drive it the same way.
 */

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

function setLoading(text: string | null): void {
  const el = document.getElementById('loading');
  if (!el) return;
  el.hidden = text === null;
  if (text !== null) el.textContent = text;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const container = document.getElementById('app');
  if (!container) throw new Error('#app container missing');

  const paused = params.get('paused') === '1';
  const fixedSize = parseSize(params.get('size'));

  const engine = new Engine({ container, ...configFromSearch(location.search) });
  const api = exposeForCapture(engine, missionScene.name);
  setLoading('Starting renderer…');
  engine.events.on('loading', ({ phase, done, total }) => {
    if (phase === 'scene') setLoading('Loading mission…');
    else setLoading(total > 0 ? `Compiling shaders ${done} / ${total}` : 'Compiling shaders…');
  });

  try {
    await engine.initialize({ fixedSize });
    api.backend = engine.renderer.capabilities.backend;
    await engine.loadScene(missionScene);
    if (paused) engine.step();
    else engine.start();
    await engine.whenPresented();
    setLoading(null);
    api.ready = true;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    api.error = message;
    setLoading(null);
    showError(message);
    throw error;
  }
}

void main();
