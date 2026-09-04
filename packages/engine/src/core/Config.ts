import type { LogLevel } from './Logger';

/** Which three.js WebGPURenderer backend to use. `auto` prefers WebGPU. */
export type BackendPreference = 'auto' | 'webgpu' | 'webgl';

/** Quality tiers. Each maps to a concrete set of renderer settings in `rendering/QualityPresets`. */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'cinematic';

export const QUALITY_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra', 'cinematic'];

export interface EngineConfig {
  /** Element the canvas is appended to. The engine creates the canvas. */
  container: HTMLElement;
  backend: BackendPreference;
  preset: QualityPreset;
  /** Simulation ticks per second. Integer. Physics and gameplay run at this rate. */
  fixedStepHz: number;
  /** Cap on fixed steps per frame, so a stalled tab does not spiral. */
  maxSubSteps: number;
  /** Cap on the device pixel ratio the swap chain is sized to. */
  maxPixelRatio: number;
  /** Internal render scale relative to the swap chain, 0.5–1.0. Dynamic resolution moves this. */
  renderScale: number;
  /** Show the DebugStats overlay. */
  debugOverlay: boolean;
  /** Maximum simultaneous entities; component arrays are sized to this. */
  entityCapacity: number;
  /** Seed for every engine-owned RNG. Same seed + same inputs = same simulation. */
  seed: number;
  /**
   * Fixed-delta clock for deterministic capture/testing. When set, every frame
   * advances by exactly this many seconds regardless of wall time.
   */
  fixedFrameDelta: number | null;
  logLevel: LogLevel;
}

export type PartialEngineConfig = Partial<Omit<EngineConfig, 'container'>> & Pick<EngineConfig, 'container'>;

export const DEFAULT_CONFIG: Omit<EngineConfig, 'container'> = {
  backend: 'auto',
  preset: 'high',
  fixedStepHz: 60,
  maxSubSteps: 5,
  maxPixelRatio: 2,
  renderScale: 1,
  debugOverlay: true,
  entityCapacity: 10_000,
  seed: 1,
  fixedFrameDelta: null,
  logLevel: 'info',
};

/**
 * Parse the subset of config that may be overridden from the URL.
 * Recognised: `backend`, `preset`, `scale`, `dpr`, `seed`, `overlay`, `fixedclock`, `log`.
 * Unknown or malformed values are ignored, never thrown on.
 */
export function configFromSearch(search: string): Partial<Omit<EngineConfig, 'container'>> {
  const params = new URLSearchParams(search);
  const out: Partial<Omit<EngineConfig, 'container'>> = {};

  const backend = params.get('backend');
  if (backend === 'webgpu' || backend === 'webgl' || backend === 'auto') out.backend = backend;

  const preset = params.get('preset')?.toLowerCase();
  if (preset && (QUALITY_PRESETS as readonly string[]).includes(preset)) out.preset = preset as QualityPreset;

  const scale = parseFloat(params.get('scale') ?? '');
  if (Number.isFinite(scale) && scale >= 0.25 && scale <= 1) out.renderScale = scale;

  const dpr = parseFloat(params.get('dpr') ?? '');
  if (Number.isFinite(dpr) && dpr > 0 && dpr <= 4) out.maxPixelRatio = dpr;

  const seed = parseInt(params.get('seed') ?? '', 10);
  if (Number.isFinite(seed)) out.seed = seed;

  const overlay = params.get('overlay');
  if (overlay === '0' || overlay === 'false') out.debugOverlay = false;
  if (overlay === '1' || overlay === 'true') out.debugOverlay = true;

  const fixed = params.get('fixedclock');
  if (fixed !== null) {
    const hz = parseFloat(fixed);
    out.fixedFrameDelta = Number.isFinite(hz) && hz > 0 ? 1 / hz : 1 / 60;
  }

  const log = params.get('log');
  if (log === 'debug' || log === 'info' || log === 'warn' || log === 'error' || log === 'silent') out.logLevel = log;

  return out;
}

export function resolveConfig(partial: PartialEngineConfig): EngineConfig {
  const config: EngineConfig = { ...DEFAULT_CONFIG, ...partial };
  if (!Number.isInteger(config.fixedStepHz) || config.fixedStepHz <= 0) {
    throw new Error(`EngineConfig.fixedStepHz must be a positive integer, got ${config.fixedStepHz}`);
  }
  if (config.renderScale <= 0 || config.renderScale > 1) {
    throw new Error(`EngineConfig.renderScale must be in (0, 1], got ${config.renderScale}`);
  }
  return config;
}
