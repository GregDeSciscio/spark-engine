/**
 * Frame clock. Converts wall-clock timestamps from requestAnimationFrame into
 * clamped, monotonic frame deltas. Supports a fixed-delta mode for deterministic
 * capture and tests, in which case wall time is ignored entirely.
 */
export class Clock {
  /** Largest delta a single frame may report (seconds). Tab switches produce huge gaps; clamp them. */
  maxDelta = 0.1;

  private lastTime: number | null = null;
  private deltaSeconds = 0;
  private elapsedSeconds = 0;
  private frameCount = 0;
  private fixedDelta: number | null;

  constructor(fixedDelta: number | null = null) {
    this.fixedDelta = fixedDelta;
  }

  /** Advance the clock. `timeMs` is the rAF timestamp; ignored in fixed mode. */
  tick(timeMs: number): number {
    if (this.fixedDelta !== null) {
      this.deltaSeconds = this.fixedDelta;
    } else if (this.lastTime === null) {
      this.deltaSeconds = 0;
    } else {
      const raw = (timeMs - this.lastTime) / 1000;
      this.deltaSeconds = raw < 0 ? 0 : Math.min(raw, this.maxDelta);
    }
    this.lastTime = timeMs;
    this.elapsedSeconds += this.deltaSeconds;
    this.frameCount += 1;
    return this.deltaSeconds;
  }

  /** Seconds since the previous tick, clamped. */
  get delta(): number {
    return this.deltaSeconds;
  }

  /** Accumulated clamped time in seconds. Not wall time. */
  get elapsed(): number {
    return this.elapsedSeconds;
  }

  get frame(): number {
    return this.frameCount;
  }

  get isFixed(): boolean {
    return this.fixedDelta !== null;
  }

  setFixedDelta(delta: number | null): void {
    this.fixedDelta = delta;
  }

  reset(): void {
    this.lastTime = null;
    this.deltaSeconds = 0;
    this.elapsedSeconds = 0;
    this.frameCount = 0;
  }
}
