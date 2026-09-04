import { describe, expect, it } from 'vitest';
import { DynamicResolutionController } from '../src/rendering/DynamicResolution';

function run(ctrl: DynamicResolutionController, frames: number, gpuMs: number | null, cpuMs = 5, dt = 1 / 60): number {
  let scale = ctrl.renderScale;
  for (let i = 0; i < frames; i++) scale = ctrl.update(dt, gpuMs, cpuMs);
  return scale;
}

describe('DynamicResolutionController', () => {
  it('starts at the ceiling and holds when under budget', () => {
    const ctrl = new DynamicResolutionController({ targetMs: 16.67, floor: 0.6 });
    expect(ctrl.renderScale).toBe(1);
    expect(run(ctrl, 120, 10)).toBe(1);
  });

  it('steps down when over budget and never below the floor', () => {
    const ctrl = new DynamicResolutionController({ targetMs: 16.67, floor: 0.6, step: 0.05, settleSeconds: 0.25 });
    const scale = run(ctrl, 600, 30);
    expect(scale).toBeCloseTo(0.6, 5);
    expect(scale).toBeGreaterThanOrEqual(0.6);
  });

  it('respects the settle time between moves', () => {
    const ctrl = new DynamicResolutionController({ targetMs: 16.67, step: 0.1, settleSeconds: 0.5, smoothing: 1 });
    // First move is allowed immediately (no prior move).
    expect(ctrl.update(1 / 60, 40, 5)).toBeCloseTo(0.9, 5);
    // Within the settle window nothing changes even though still over budget.
    for (let i = 0; i < 20; i++) expect(ctrl.update(1 / 60, 40, 5)).toBeCloseTo(0.9, 5);
    // After the settle window it moves again.
    let scale = 0.9;
    for (let i = 0; i < 20; i++) scale = ctrl.update(1 / 60, 40, 5);
    expect(scale).toBeCloseTo(0.8, 5);
  });

  it('does not oscillate at the boundary (hysteresis)', () => {
    const ctrl = new DynamicResolutionController({ targetMs: 16.67, step: 0.05, settleSeconds: 0.2, smoothing: 1 });
    run(ctrl, 60, 20); // drop a notch or two
    const afterDrop = ctrl.renderScale;
    expect(afterDrop).toBeLessThan(1);
    // Slightly under budget but not enough headroom to raise: must hold.
    const held = run(ctrl, 240, 16);
    expect(held).toBe(afterDrop);
  });

  it('raises again when there is headroom', () => {
    const ctrl = new DynamicResolutionController({ targetMs: 16.67, step: 0.05, settleSeconds: 0.1, smoothing: 1 });
    run(ctrl, 120, 30);
    expect(ctrl.renderScale).toBeLessThan(1);
    const scale = run(ctrl, 600, 6);
    expect(scale).toBe(1);
  });

  it('falls back to CPU time when GPU time is unavailable', () => {
    const ctrl = new DynamicResolutionController({ targetMs: 16.67, settleSeconds: 0.1, smoothing: 1 });
    run(ctrl, 60, null, 30);
    expect(ctrl.source).toBe('cpu');
    expect(ctrl.renderScale).toBeLessThan(1);
  });

  it('does nothing when disabled', () => {
    const ctrl = new DynamicResolutionController();
    ctrl.enabled = false;
    expect(run(ctrl, 200, 50)).toBe(1);
  });

  it('setScale forces a value inside the bounds', () => {
    const ctrl = new DynamicResolutionController({ floor: 0.6 });
    ctrl.setScale(0.3);
    expect(ctrl.renderScale).toBe(0.6);
    ctrl.setScale(2);
    expect(ctrl.renderScale).toBe(1);
  });
});
