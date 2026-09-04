import type { Clock } from './Clock';

export interface LoopCallbacks {
  /** Once per frame, before simulation. Poll input here. */
  input?: (dt: number) => void;
  /** Zero or more times per frame at exactly `fixedStep` seconds. Physics and gameplay. */
  fixedUpdate?: (fixedDt: number) => void;
  /** Once per frame. `alpha` is the interpolation factor between the last two fixed steps. */
  update?: (dt: number, alpha: number) => void;
  /** Once per frame after update. Cameras, UI, anything that reads final transforms. */
  lateUpdate?: (dt: number) => void;
  /** Once per frame. */
  render?: (dt: number) => void;
}

export interface LoopOptions {
  fixedStepHz: number;
  maxSubSteps: number;
  clock: Clock;
  /** Injectable for tests. Defaults to `requestAnimationFrame`. */
  schedule?: (cb: (time: number) => void) => number;
  cancel?: (handle: number) => void;
}

/**
 * The frame loop:
 *
 *   input → fixedUpdate ×N → update → lateUpdate → render
 *
 * Fixed steps use an accumulator so simulation rate is independent of display
 * refresh. `maxSubSteps` caps catch-up so a stalled tab cannot spiral; the
 * dropped time is discarded, which is the "spiral of death" guard.
 */
export class GameLoop {
  readonly fixedStep: number;
  readonly maxSubSteps: number;

  private readonly clock: Clock;
  private readonly schedule: (cb: (time: number) => void) => number;
  private readonly cancel: (handle: number) => void;
  private callbacks: LoopCallbacks = {};
  private accumulator = 0;
  private handle: number | null = null;
  private running = false;
  private fixedStepsThisFrame = 0;
  private totalFixedSteps = 0;

  constructor(options: LoopOptions) {
    this.fixedStep = 1 / options.fixedStepHz;
    this.maxSubSteps = options.maxSubSteps;
    this.clock = options.clock;
    this.schedule = options.schedule ?? ((cb) => requestAnimationFrame(cb));
    this.cancel = options.cancel ?? ((h) => cancelAnimationFrame(h));
  }

  setCallbacks(callbacks: LoopCallbacks): void {
    this.callbacks = callbacks;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Fixed steps executed during the most recent frame. Debug stat. */
  get lastFixedSteps(): number {
    return this.fixedStepsThisFrame;
  }

  get fixedStepCount(): number {
    return this.totalFixedSteps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.handle = this.schedule(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.handle !== null) {
      this.cancel(this.handle);
      this.handle = null;
    }
  }

  /**
   * Run exactly one frame now, outside the scheduler. Used by the capture tool
   * and tests. Safe to call whether or not the loop is running (it does not
   * reschedule).
   */
  step(timeMs: number): void {
    this.runFrame(timeMs);
  }

  private readonly frame = (timeMs: number): void => {
    if (!this.running) return;
    this.runFrame(timeMs);
    if (this.running) this.handle = this.schedule(this.frame);
  };

  private runFrame(timeMs: number): void {
    const dt = this.clock.tick(timeMs);
    const cb = this.callbacks;

    cb.input?.(dt);

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      cb.fixedUpdate?.(this.fixedStep);
      this.accumulator -= this.fixedStep;
      steps += 1;
    }
    if (steps === this.maxSubSteps && this.accumulator >= this.fixedStep) {
      // Discard the backlog rather than spiral.
      this.accumulator = this.accumulator % this.fixedStep;
    }
    this.fixedStepsThisFrame = steps;
    this.totalFixedSteps += steps;

    const alpha = this.accumulator / this.fixedStep;
    cb.update?.(dt, alpha);
    cb.lateUpdate?.(dt);
    cb.render?.(dt);
  }
}
