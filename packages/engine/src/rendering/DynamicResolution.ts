/**
 * Dynamic resolution controller (kickoff §19). Pure numbers in, a render scale
 * out, so it is unit-testable in node without three.
 *
 * Policy:
 * - Measures the frame cost from GPU ms when available, else CPU ms.
 * - Smooths the measurement with an exponential moving average.
 * - Steps the scale down when the smoothed cost exceeds the budget, and up
 *   only when there is clear headroom (`raiseRatio` of the budget). The gap
 *   between the two thresholds is the hysteresis.
 * - After any change the controller waits `settleSeconds` before it will move
 *   again, so a resize's own cost spike cannot trigger a second move.
 * - Scales are quantised to `step` so render targets are not resized every frame.
 */
export interface DynamicResolutionOptions {
  /** Frame budget in milliseconds. 16.67 for 60 Hz. */
  readonly targetMs: number;
  /** Lowest render scale. Kickoff suggests 0.6. */
  readonly floor: number;
  /** Highest render scale, normally 1. */
  readonly ceiling: number;
  /** Scale increment per move. */
  readonly step: number;
  /** Seconds to wait after a move before considering another. */
  readonly settleSeconds: number;
  /** Move down when smoothed cost > targetMs * lowerRatio. */
  readonly lowerRatio: number;
  /** Move up only when smoothed cost < targetMs * raiseRatio. Must be < lowerRatio. */
  readonly raiseRatio: number;
  /** EMA weight for a new sample, 0..1. Lower = smoother, slower. */
  readonly smoothing: number;
  /**
   * Samples to ignore after enable/reset. The first frames of a scene are
   * dominated by pipeline compilation and say nothing about steady-state cost.
   */
  readonly warmupFrames: number;
  /**
   * A sample above this many milliseconds is a hitch (shader compile, tab
   * stall, GC), not load: it is dropped instead of dragging the scale down.
   */
  readonly hitchMs: number;
}

export const DEFAULT_DYNAMIC_RESOLUTION: DynamicResolutionOptions = {
  targetMs: 1000 / 60,
  floor: 0.6,
  ceiling: 1,
  step: 0.05,
  settleSeconds: 0.5,
  lowerRatio: 1.0,
  raiseRatio: 0.72,
  smoothing: 0.15,
  warmupFrames: 45,
  hitchMs: 100,
};

export class DynamicResolutionController {
  enabled = true;

  private options: DynamicResolutionOptions;
  private scale: number;
  private smoothedMs: number | null = null;
  private sinceMove = Number.POSITIVE_INFINITY;
  private lastSource: 'gpu' | 'cpu' | null = null;
  private warmupLeft: number;
  private hitches = 0;

  constructor(options: Partial<DynamicResolutionOptions> = {}, initialScale?: number) {
    this.options = { ...DEFAULT_DYNAMIC_RESOLUTION, ...options };
    this.scale = this.clamp(initialScale ?? this.options.ceiling);
    this.warmupLeft = this.options.warmupFrames;
  }

  /** Samples rejected as hitches so far (diagnostics). */
  get hitchCount(): number {
    return this.hitches;
  }

  get renderScale(): number {
    return this.scale;
  }

  /** The smoothed frame cost the controller is reacting to, or null before the first sample. */
  get measuredMs(): number | null {
    return this.smoothedMs;
  }

  /** Which timer fed the last sample. */
  get source(): 'gpu' | 'cpu' | null {
    return this.lastSource;
  }

  configure(options: Partial<DynamicResolutionOptions>): void {
    this.options = { ...this.options, ...options };
    this.scale = this.clamp(this.scale);
  }

  /** Force a scale (e.g. preset change). Resets the settle timer. */
  setScale(scale: number): void {
    this.scale = this.clamp(scale);
    this.sinceMove = 0;
  }

  reset(scale: number = this.options.ceiling): void {
    this.scale = this.clamp(scale);
    this.smoothedMs = null;
    this.sinceMove = Number.POSITIVE_INFINITY;
    this.lastSource = null;
    this.warmupLeft = this.options.warmupFrames;
  }

  /**
   * Feed one frame. Returns the render scale to use for the next frame.
   * `gpuMs` may be null (WebGL2 backend, or timers not resolved yet), in which
   * case `cpuMs` is used.
   */
  update(dt: number, gpuMs: number | null, cpuMs: number): number {
    if (!this.enabled) return this.scale;
    const sample = gpuMs !== null && Number.isFinite(gpuMs) && gpuMs > 0 ? gpuMs : cpuMs;
    this.lastSource = gpuMs !== null && Number.isFinite(gpuMs) && gpuMs > 0 ? 'gpu' : 'cpu';
    if (!Number.isFinite(sample) || sample < 0) return this.scale;
    this.sinceMove += Math.max(0, dt);
    if (this.warmupLeft > 0) {
      this.warmupLeft--;
      return this.scale;
    }
    if (sample > this.options.hitchMs) {
      this.hitches++;
      return this.scale;
    }

    this.smoothedMs = this.smoothedMs === null ? sample : this.smoothedMs + (sample - this.smoothedMs) * this.options.smoothing;
    if (this.sinceMove < this.options.settleSeconds) return this.scale;

    const { targetMs, lowerRatio, raiseRatio, step } = this.options;
    let next = this.scale;
    if (this.smoothedMs > targetMs * lowerRatio) {
      next = this.scale - step;
    } else if (this.smoothedMs < targetMs * raiseRatio) {
      next = this.scale + step;
    }
    next = this.clamp(quantise(next, step));
    if (next !== this.scale) {
      this.scale = next;
      this.sinceMove = 0;
      // A change in pixel count invalidates the history: bias the EMA toward the
      // expected new cost so the next decision is not made on stale numbers.
      this.smoothedMs = null;
    }
    return this.scale;
  }

  private clamp(scale: number): number {
    return Math.min(this.options.ceiling, Math.max(this.options.floor, scale));
  }
}

function quantise(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}
