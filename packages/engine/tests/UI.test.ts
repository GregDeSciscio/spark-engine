import { describe, expect, it } from 'vitest';
import { createProjectedPoint, distanceScale, multiplyMatrices, projectPoint } from '../src/ui/Projection';
import { LabelPool } from '../src/ui/LabelPool';
import { LAYER_NAMES, LAYER_SPECS, LayerPolicy, isLayerName } from '../src/ui/LayerPolicy';

/** three.js-style column-major perspective matrix (symmetric frustum). */
function perspective(fovDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = -(far + near) / (far - near);
  m[11] = -1;
  m[14] = (-2 * far * near) / (far - near);
  return m;
}

function translation(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

describe('projectPoint', () => {
  const W = 1280;
  const H = 720;
  const P = perspective(90, W / H, 0.1, 100);

  it('puts a point on the view axis at the viewport centre with its distance as depth', () => {
    const out = createProjectedPoint();
    projectPoint(P, W, H, 0, 0, -5, out);
    expect(out.visible).toBe(true);
    expect(out.x).toBeCloseTo(W / 2);
    expect(out.y).toBeCloseTo(H / 2);
    expect(out.depth).toBeCloseTo(5);
  });

  it('hides points behind the camera and reports a non-positive depth', () => {
    const out = createProjectedPoint();
    projectPoint(P, W, H, 0, 0, 5, out);
    expect(out.visible).toBe(false);
    expect(out.depth).toBeLessThanOrEqual(0);
    projectPoint(P, W, H, 0, 0, 0, out);
    expect(out.visible).toBe(false);
  });

  it('maps the frustum edges to the viewport edges and marks outside as not visible', () => {
    const out = createProjectedPoint();
    // fov 90 vertical: at depth 5 the top edge is y = +5.
    projectPoint(P, W, H, 0, 5, -5, out);
    expect(out.visible).toBe(true);
    expect(out.y).toBeCloseTo(0);
    projectPoint(P, W, H, 0, -5, -5, out);
    expect(out.y).toBeCloseTo(H);
    // Horizontal half-extent at depth 5 is 5 × aspect.
    projectPoint(P, W, H, (5 * W) / H, 0, -5, out);
    expect(out.x).toBeCloseTo(W);
    projectPoint(P, W, H, 0, 6, -5, out);
    expect(out.visible).toBe(false);
    expect(out.y).toBeLessThan(0);
    // Beyond far.
    projectPoint(P, W, H, 0, 0, -150, out);
    expect(out.visible).toBe(false);
  });

  it('composes with a view matrix and reuses the out object without allocating', () => {
    const view = translation(0, 0, -10); // camera at z = +10 looking down -Z
    const vp = new Float32Array(16);
    multiplyMatrices(P, view, vp);
    const out = createProjectedPoint();
    const same = projectPoint(vp, W, H, 0, 0, 0, out);
    expect(same).toBe(out);
    expect(out.visible).toBe(true);
    expect(out.depth).toBeCloseTo(10);
    expect(out.x).toBeCloseTo(W / 2);
    projectPoint(vp, W, H, 0, 0, 12, out);
    expect(out.visible).toBe(false);
  });

  it('multiplies column-major matrices like three (identity and translation cases)', () => {
    const I = translation(0, 0, 0);
    const T = translation(1, 2, 3);
    const out = new Float32Array(16);
    multiplyMatrices(I, T, out);
    expect(Array.from(out)).toEqual(Array.from(T));
    multiplyMatrices(T, T, out);
    expect([out[12], out[13], out[14]]).toEqual([2, 4, 6]);
  });

  it('scales labels by distance with clamps', () => {
    expect(distanceScale(8, 8)).toBe(1);
    expect(distanceScale(16, 8)).toBe(0.5);
    expect(distanceScale(80, 8)).toBe(0.4);
    expect(distanceScale(1, 8)).toBe(1.5);
    expect(distanceScale(0, 8)).toBe(1.5);
  });
});

describe('LabelPool', () => {
  it('hands out indices up to the cap, then refuses', () => {
    const pool = new LabelPool(3);
    expect([pool.acquire(), pool.acquire(), pool.acquire()]).toEqual([0, 1, 2]);
    expect(pool.acquire()).toBe(-1);
    expect(pool.refused).toBe(1);
    expect(pool.active).toBe(3);
    expect(pool.highWater).toBe(3);
  });

  it('reuses released indices LIFO and never grows past the cap', () => {
    const pool = new LabelPool(4);
    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.release(a)).toBe(true);
    expect(pool.release(a)).toBe(false);
    expect(pool.acquire()).toBe(a);
    pool.release(b);
    pool.release(a);
    expect(pool.acquire()).toBe(a);
    expect(pool.acquire()).toBe(b);
    for (let i = 0; i < 100; i++) {
      const idx = pool.acquire();
      if (idx !== -1) pool.release(idx);
    }
    expect(pool.highWater).toBeLessThanOrEqual(4);
    expect([...pool.entries()].sort()).toEqual([a, b].sort());
    expect(pool.isLive(a)).toBe(true);
  });

  it('rejects a bad capacity and clears', () => {
    expect(() => new LabelPool(0)).toThrow(/capacity/);
    expect(() => new LabelPool(1.5)).toThrow(/capacity/);
    const pool = new LabelPool(2);
    pool.acquire();
    pool.clear();
    expect(pool.active).toBe(0);
    expect(pool.acquire()).toBe(0);
  });
});

describe('LayerPolicy', () => {
  it('starts with world + hud visible and nothing capturing', () => {
    const p = new LayerPolicy();
    expect(LAYER_NAMES).toEqual(['world', 'hud', 'menu', 'modal']);
    expect(p.isVisible('world')).toBe(true);
    expect(p.isVisible('hud')).toBe(true);
    expect(p.isVisible('menu')).toBe(false);
    expect(p.isVisible('modal')).toBe(false);
    expect(p.captured).toBe(false);
    expect(p.topCapturing()).toBeNull();
    expect(LAYER_SPECS.menu.capture && LAYER_SPECS.modal.capture).toBe(true);
    expect(LAYER_SPECS.world.capture || LAYER_SPECS.hud.capture).toBe(false);
    expect(isLayerName('hud')).toBe(true);
    expect(isLayerName('toast')).toBe(false);
  });

  it('captures while any capturing layer is visible and notifies on transitions only', () => {
    const p = new LayerPolicy();
    const events: boolean[] = [];
    p.onCaptureChange((c) => events.push(c));
    expect(p.show('hud')).toBe(false); // already visible
    expect(events).toEqual([]);
    p.show('menu');
    expect(p.captured).toBe(true);
    expect(events).toEqual([true]);
    p.show('modal');
    expect(events).toEqual([true]); // still captured, no second notification
    expect(p.topCapturing()).toBe('modal');
    p.hide('modal');
    expect(p.captured).toBe(true);
    expect(p.topCapturing()).toBe('menu');
    p.hide('menu');
    expect(p.captured).toBe(false);
    expect(events).toEqual([true, false]);
    p.hide('hud');
    expect(p.captured).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it('toggle returns the new visibility and unknown layers throw', () => {
    const p = new LayerPolicy();
    expect(p.toggle('menu')).toBe(true);
    expect(p.toggle('menu')).toBe(false);
    expect(() => p.show('toast' as never)).toThrow(/unknown layer/);
  });
});
