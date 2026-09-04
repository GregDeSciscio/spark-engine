import type { Engine } from '../core/Engine';
import { Logger, type LogRecord } from '../core/Logger';
import type { DebugSnapshot } from './DebugStats';

export interface CaptureAPI {
  /** The live engine, for console debugging. Tools should prefer the typed methods below. */
  engine: Engine;
  ready: boolean;
  backend: string;
  scene: string | null;
  error: string | null;
  /** Renderer capabilities once initialised. */
  capabilities(): unknown;
  /** Advance N frames synchronously (fixed clock recommended). */
  stepFrames(n: number): void;
  snapshot(): DebugSnapshot | null;
  /** Logger records at warn or above plus uncaught errors. */
  logs(): LogRecord[];
  /** Force a resolve of pending GPU timestamps before reading a snapshot. */
  flushGpuTimers(): Promise<void>;
}

declare global {
  interface Window {
    __spark?: CaptureAPI;
  }
}

/**
 * Publishes a small, stable API on `window.__spark` for the capture tool and
 * for humans poking at the console. Nothing in the engine reads it.
 */
export function exposeForCapture(engine: Engine, sceneName: string | null): CaptureAPI {
  const uncaught: LogRecord[] = [];
  window.addEventListener('error', (e) => {
    uncaught.push({ level: 'error', scope: 'window', message: String(e.message), time: Date.now() });
  });
  window.addEventListener('unhandledrejection', (e) => {
    uncaught.push({ level: 'error', scope: 'window', message: `unhandledrejection: ${String(e.reason)}`, time: Date.now() });
  });

  const api: CaptureAPI = {
    engine,
    ready: false,
    backend: 'none',
    scene: sceneName,
    error: null,
    capabilities(): unknown {
      try {
        return engine.renderer.capabilities;
      } catch {
        return null;
      }
    },
    stepFrames(n: number): void {
      let t = performance.now();
      for (let i = 0; i < n; i++) {
        t += 1000 / 60;
        engine.step(t);
      }
    },
    snapshot(): DebugSnapshot | null {
      return engine.stats?.snapshot() ?? null;
    },
    logs(): LogRecord[] {
      return [...Logger.getRecords(), ...uncaught];
    },
    async flushGpuTimers(): Promise<void> {
      // Timestamp resolution is asynchronous (GPU work done + buffer map). Step a
      // couple of frames so a query is in flight, then wait for it to land, up
      // to a bound so a backend without timers does not hang the capture.
      if (!engine.renderer.capabilities.timestampQuery) return;
      api.stepFrames(2);
      // Do not step while waiting: each render submits more GPU work, and the
      // resolve waits for the queue to drain, so stepping would starve it.
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        if (engine.renderer.stats().gpuMs !== null) return;
      }
    },
  };
  window.__spark = api;
  return api;
}
