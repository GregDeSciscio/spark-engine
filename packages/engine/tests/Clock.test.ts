import { describe, expect, it } from 'vitest';
import { Clock } from '../src/core/Clock';

describe('Clock', () => {
  it('reports zero delta on the first tick', () => {
    const clock = new Clock();
    expect(clock.tick(1000)).toBe(0);
    expect(clock.frame).toBe(1);
  });

  it('converts millisecond gaps to seconds', () => {
    const clock = new Clock();
    clock.tick(1000);
    expect(clock.tick(1016.6667)).toBeCloseTo(0.0166667, 5);
    expect(clock.elapsed).toBeCloseTo(0.0166667, 5);
  });

  it('clamps large gaps to maxDelta', () => {
    const clock = new Clock();
    clock.maxDelta = 0.1;
    clock.tick(0);
    expect(clock.tick(5000)).toBe(0.1);
  });

  it('never reports negative deltas', () => {
    const clock = new Clock();
    clock.tick(100);
    expect(clock.tick(50)).toBe(0);
  });

  it('ignores wall time in fixed mode', () => {
    const clock = new Clock(1 / 60);
    expect(clock.tick(0)).toBeCloseTo(1 / 60);
    expect(clock.tick(99999)).toBeCloseTo(1 / 60);
    expect(clock.isFixed).toBe(true);
    expect(clock.elapsed).toBeCloseTo(2 / 60);
  });

  it('resets', () => {
    const clock = new Clock();
    clock.tick(0);
    clock.tick(16);
    clock.reset();
    expect(clock.frame).toBe(0);
    expect(clock.elapsed).toBe(0);
    expect(clock.tick(500)).toBe(0);
  });

  it('resync forgets the last timestamp without losing elapsed time', () => {
    const c = new Clock();
    c.tick(1000);
    c.tick(1016);
    const elapsed = c.elapsed;
    expect(c.lastTimeMs).toBe(1016);
    c.resync();
    expect(c.lastTimeMs).toBeNull();
    // A tick far in the past (as if synthetic stepping had run ahead) measures nothing instead of freezing.
    expect(c.tick(500)).toBe(0);
    expect(c.elapsed).toBe(elapsed);
    expect(c.tick(516)).toBeCloseTo(0.016);
  });
});
