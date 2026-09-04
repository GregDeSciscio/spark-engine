import { describe, expect, it } from 'vitest';
import { LoadingProgress, type LoadingSnapshot } from '../src/assets/LoadingProgress';

describe('LoadingProgress', () => {
  it('starts idle with ratio 1', () => {
    const p = new LoadingProgress();
    expect(p.snapshot()).toMatchObject({ itemsTotal: 0, itemsLoaded: 0, ratio: 1, active: false, bytesKnown: true });
  });

  it('counts items and emits complete when the last one settles', () => {
    const p = new LoadingProgress();
    const events: string[] = [];
    let complete: LoadingSnapshot | null = null;
    p.events.on('progress', (s) => events.push(`${s.itemsLoaded}/${s.itemsTotal}`));
    p.events.on('complete', (s) => (complete = s));

    p.begin('a');
    p.begin('b');
    expect(p.isActive).toBe(true);
    expect(p.snapshot()).toMatchObject({ itemsTotal: 2, itemsLoaded: 0, ratio: 0, active: true });
    p.finish('a');
    expect(complete).toBeNull();
    expect(p.snapshot()).toMatchObject({ itemsLoaded: 1, ratio: 0.5, active: true });
    p.finish('b');
    expect(complete).not.toBeNull();
    expect(complete!).toMatchObject({ itemsLoaded: 2, itemsTotal: 2, ratio: 1, active: false });
    expect(events).toEqual(['0/1', '0/2', '1/2', '2/2']);
  });

  it('blends byte progress into the ratio when totals are known', () => {
    const p = new LoadingProgress();
    p.begin('a');
    p.begin('b');
    p.update('a', 500, 1000);
    expect(p.snapshot()).toMatchObject({ bytesLoaded: 500, bytesTotal: 1000, bytesKnown: false, ratio: 0.25 });
    p.update('b', 100, 400);
    const s = p.snapshot();
    expect(s.bytesKnown).toBe(true);
    expect(s.bytesLoaded).toBe(600);
    expect(s.bytesTotal).toBe(1400);
    expect(s.ratio).toBeCloseTo((0.5 + 0.25) / 2);
    p.finish('a');
    p.finish('b');
    expect(p.snapshot()).toMatchObject({ bytesLoaded: 1400, bytesTotal: 1400, ratio: 1 });
  });

  it('ignores unknown urls and duplicate begins', () => {
    const p = new LoadingProgress();
    p.update('ghost', 10, 20);
    p.finish('ghost');
    p.fail('ghost', new Error('x'));
    expect(p.snapshot().itemsTotal).toBe(0);
    p.begin('a');
    p.begin('a');
    expect(p.snapshot().itemsTotal).toBe(1);
  });

  it('reports failures through error and still completes', () => {
    const p = new LoadingProgress();
    const errors: string[] = [];
    let completed = 0;
    p.events.on('error', (e) => errors.push(`${e.url}:${(e.error as Error).message}`));
    p.events.on('complete', () => completed++);
    p.begin('a');
    p.begin('b');
    p.fail('a', new Error('404'));
    expect(errors).toEqual(['a:404']);
    expect(completed).toBe(0);
    p.finish('b');
    expect(completed).toBe(1);
    expect(p.snapshot()).toMatchObject({ itemsLoaded: 1, itemsFailed: 1, itemsTotal: 2, ratio: 1, active: false });
  });

  it('starts a fresh batch after completion', () => {
    const p = new LoadingProgress();
    p.begin('a');
    p.update('a', 10, 10);
    p.finish('a');
    expect(p.snapshot()).toMatchObject({ itemsLoaded: 1, itemsTotal: 1, bytesTotal: 10 });
    p.begin('b');
    expect(p.snapshot()).toMatchObject({ itemsLoaded: 0, itemsTotal: 1, bytesTotal: 0, active: true });
  });

  it('dispose clears listeners and state', () => {
    const p = new LoadingProgress();
    let fired = 0;
    p.events.on('progress', () => fired++);
    p.begin('a');
    p.dispose();
    p.begin('b');
    expect(fired).toBe(1);
    expect(p.snapshot().itemsTotal).toBe(1);
  });
});
