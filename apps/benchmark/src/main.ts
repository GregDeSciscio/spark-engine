import { Engine, configFromSearch, exposeForCapture } from '@spark/engine';
import { renderMenu } from './menu';
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

/**
 * A corner link back to the launcher. Only when the debug overlay is on, so
 * `overlay=0` runs (capture, perf, visual) stay free of extra DOM.
 */
function addMenuLink(container: HTMLElement): void {
  const link = document.createElement('a');
  link.href = location.pathname;
  link.textContent = '← menu';
  Object.assign(link.style, {
    position: 'absolute',
    top: '8px',
    right: '10px',
    padding: '4px 10px',
    font: '12px/1.4 ui-monospace, Consolas, monospace',
    color: '#9aa4bd',
    background: 'rgba(8, 10, 16, 0.75)',
    border: '1px solid #1c2233',
    borderRadius: '4px',
    textDecoration: 'none',
    zIndex: '20',
  } satisfies Partial<CSSStyleDeclaration>);
  container.appendChild(link);
}

/** The `#loading` overlay: shown from boot until the first frame has presented, text from the engine's `loading` events. */
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

  // No scene asked for: show the launcher instead of booting a renderer. Every
  // tool (capture, perf, visual) passes `scene=` explicitly, so none reach this.
  if (!params.has('scene')) {
    setLoading(null);
    renderMenu(container);
    return;
  }

  const sceneName = params.get('scene') ?? 'bootstrap';
  const paused = params.get('paused') === '1';
  const fixedSize = parseSize(params.get('size'));

  const engine = new Engine({ container, ...ENGINE_HINTS[sceneName], ...configFromSearch(location.search) });
  const api = exposeForCapture(engine, sceneName);
  setLoading('Starting renderer…');
  engine.events.on('loading', ({ phase, done, total }) => {
    if (phase === 'scene') setLoading(`Loading ${sceneName}…`);
    else setLoading(total > 0 ? `Compiling shaders ${done} / ${total}` : 'Compiling shaders…');
  });

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
    // Ready means a real frame is on screen, not that the loop was started.
    await engine.whenPresented();
    setLoading(null);
    if (configFromSearch(location.search).debugOverlay ?? true) addMenuLink(container);
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
