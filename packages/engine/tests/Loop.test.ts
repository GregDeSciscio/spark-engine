import { describe, expect, it } from 'vitest';
import { Clock } from '../src/core/Clock';
import { GameLoop } from '../src/core/Loop';

function makeLoop(fixedStepHz = 60, maxSubSteps = 5) {
  const clock = new Clock();
  const scheduled: Array<(t: number) => void> = [];
  const loop = new GameLoop({
    fixedStepHz,
    maxSubSteps,
    clock,
    schedule: (cb) => {
      scheduled.push(cb);
      return scheduled.length;
    },
    cancel: () => undefined,
  });
  return { loop, clock, scheduled };
}

describe('GameLoop', () => {
  it('runs phases in order once per frame', () => {
    const { loop } = makeLoop();
    const order: string[] = [];
    loop.setCallbacks({
      input: () => order.push('input'),
      fixedUpdate: () => order.push('fixed'),
      update: () => order.push('update'),
      lateUpdate: () => order.push('late'),
      render: () => order.push('render'),
    });
    loop.step(0);
    loop.step(1000 / 60);
    expect(order).toEqual(['input', 'update', 'late', 'render', 'input', 'fixed', 'update', 'late', 'render']);
  });

  it('accumulates fixed steps independent of frame rate', () => {
    const { loop } = makeLoop(60);
    let fixed = 0;
    loop.setCallbacks({ fixedUpdate: () => fixed++ });
    loop.step(0);
    // 30 fps frames: each should produce 2 fixed steps.
    loop.step(33.3334);
    expect(fixed).toBe(2);
    loop.step(66.6667);
    expect(fixed).toBe(4);
  });

  it('caps catch-up at maxSubSteps and discards the backlog', () => {
    const { loop, clock } = makeLoop(60, 3);
    clock.maxDelta = 10; // let the gap through so the loop's own guard is what we test
    let fixed = 0;
    loop.setCallbacks({ fixedUpdate: () => fixed++ });
    loop.step(0);
    loop.step(1000); // one second stall = 60 steps owed
    expect(fixed).toBe(3);
    expect(loop.lastFixedSteps).toBe(3);
    loop.step(1000 + 1000 / 60);
    expect(fixed).toBe(4); // backlog was dropped, only the new frame's step runs
  });

  it('reports alpha as the fraction of a fixed step left over', () => {
    const { loop } = makeLoop(60);
    let alpha = -1;
    loop.setCallbacks({ update: (_dt, a) => (alpha = a) });
    loop.step(0);
    loop.step(1000 / 60 / 2); // half a step
    expect(alpha).toBeCloseTo(0.5, 3);
  });

  it('schedules itself while running and stops cleanly', () => {
    const { loop, scheduled } = makeLoop();
    loop.start();
    expect(loop.isRunning).toBe(true);
    expect(scheduled.length).toBe(1);
    scheduled[0]?.(0);
    expect(scheduled.length).toBe(2);
    loop.stop();
    scheduled[1]?.(16);
    expect(scheduled.length).toBe(2);
    expect(loop.isRunning).toBe(false);
  });
});
