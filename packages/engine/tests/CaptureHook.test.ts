import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/core/Logger';
import { exposeForCapture } from '../src/debug/CaptureHook';
import type { Engine } from '../src/core/Engine';

/**
 * `window.__spark` is the contract `pnpm capture`, `pnpm visual`, `pnpm perf`
 * and `pnpm probe` are all written against. The parts worth pinning are the
 * ones a tool would be silently wrong about: stepping must pause a running
 * loop (a wall-clock frame interleaved with synthetic ones starves the fixed
 * step), and `logs()` must carry uncaught page errors alongside the engine's
 * own records, because "clean run" is decided from it.
 */

interface FakeEngine {
  state: 'idle' | 'running';
  clock: { lastTimeMs: number | null; resync: () => void };
  renderer: { capabilities: unknown; stats: () => { gpuMs: number | null } };
  stats?: { snapshot: () => unknown };
  steps: number[];
  started: number;
  stopped: number;
  resyncs: number;
  start: () => void;
  stop: () => void;
  step: (t: number) => void;
}

function fakeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
  const engine: FakeEngine = {
    state: 'idle',
    clock: {
      lastTimeMs: 1000,
      resync: () => {
        engine.resyncs++;
      },
    },
    renderer: { capabilities: { backend: 'webgpu', timestampQuery: false }, stats: () => ({ gpuMs: null }) },
    stats: { snapshot: () => ({ fps: 60 }) },
    steps: [],
    started: 0,
    stopped: 0,
    resyncs: 0,
    start: () => {
      engine.started++;
      engine.state = 'running';
    },
    stop: () => {
      engine.stopped++;
      engine.state = 'idle';
    },
    step: (t: number) => {
      engine.steps.push(t);
    },
    ...overrides,
  };
  return engine;
}

/** The listeners `exposeForCapture` installs, so a test can fire them. */
type Listeners = Record<string, ((event: unknown) => void)[]>;

function stubWindow(): Listeners {
  const listeners: Listeners = {};
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      (listeners[type] ??= []).push(fn);
    },
  };
  return listeners;
}

describe('exposeForCapture', () => {
  beforeEach(() => {
    Logger.clearRecords();
    Logger.setLevel('silent');
  });

  afterEach(() => {
    Logger.clearRecords();
    Logger.setLevel('info');
    delete (globalThis as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('publishes itself on the window with the fields a tool reads first', () => {
    stubWindow();
    const engine = fakeEngine();
    const api = exposeForCapture(engine as unknown as Engine, 'mission');
    expect((globalThis as { window: { __spark?: unknown } }).window.__spark).toBe(api);
    expect(api.ready).toBe(false);
    expect(api.error).toBeNull();
    expect(api.scene).toBe('mission');
    expect(api.backend).toBe('none');
    expect(api.engine).toBe(engine as unknown as Engine);
  });

  it('steps a fixed 60 Hz sequence and resyncs the clock', () => {
    stubWindow();
    const engine = fakeEngine();
    const api = exposeForCapture(engine as unknown as Engine, null);
    api.stepFrames(3);
    expect(engine.steps).toHaveLength(3);
    const deltas = engine.steps.slice(1).map((t, i) => t - (engine.steps[i] as number));
    for (const d of deltas) expect(d).toBeCloseTo(1000 / 60, 6);
    expect(engine.resyncs).toBe(1);
  });

  it('pauses a running loop for the duration of a step, then restarts it', () => {
    stubWindow();
    const engine = fakeEngine({ state: 'running' });
    const api = exposeForCapture(engine as unknown as Engine, null);
    api.stepFrames(2);
    expect(engine.stopped).toBe(1);
    expect(engine.started).toBe(1);
    expect(engine.state).toBe('running');
  });

  it('leaves a paused engine paused', () => {
    stubWindow();
    const engine = fakeEngine({ state: 'idle' });
    const api = exposeForCapture(engine as unknown as Engine, null);
    api.stepFrames(2);
    expect(engine.stopped).toBe(0);
    expect(engine.started).toBe(0);
    expect(engine.state).toBe('idle');
  });

  it('carries uncaught page errors alongside the engine records', () => {
    const listeners = stubWindow();
    const engine = fakeEngine();
    const api = exposeForCapture(engine as unknown as Engine, null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Logger('audio').warn('cue missing');
    expect(api.logs().map((l) => l.message)).toEqual(['cue missing']);
    for (const fn of listeners['error'] ?? []) fn({ message: 'boom' });
    for (const fn of listeners['unhandledrejection'] ?? []) fn({ reason: 'nope' });
    expect(api.logs().map((l) => l.message)).toEqual(['cue missing', 'boom', 'unhandledrejection: nope']);
    expect(api.logs().every((l) => l.level === 'warn' || l.level === 'error')).toBe(true);
  });

  it('survives an engine with no stats and a renderer that throws', () => {
    stubWindow();
    const engine = fakeEngine({ stats: undefined });
    Object.defineProperty(engine.renderer, 'capabilities', {
      get() {
        throw new Error('renderer not initialised');
      },
    });
    const api = exposeForCapture(engine as unknown as Engine, null);
    expect(api.snapshot()).toBeNull();
    expect(api.capabilities()).toBeNull();
  });

  it('does not wait on GPU timers a backend cannot resolve', async () => {
    stubWindow();
    const engine = fakeEngine();
    const api = exposeForCapture(engine as unknown as Engine, null);
    const started = Date.now();
    await api.flushGpuTimers();
    expect(Date.now() - started).toBeLessThan(500);
    expect(engine.steps).toHaveLength(0);
  });
});
