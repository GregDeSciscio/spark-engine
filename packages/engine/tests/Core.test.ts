import { describe, expect, it } from 'vitest';
import { DisposeBag } from '../src/core/Disposable';
import { EventEmitter } from '../src/core/Events';
import { Random } from '../src/core/Random';

describe('EventEmitter', () => {
  it('delivers payloads to listeners and supports unsubscribe', () => {
    const e = new EventEmitter<{ hit: { damage: number } }>();
    const seen: number[] = [];
    const off = e.on('hit', (p) => seen.push(p.damage));
    e.emit('hit', { damage: 3 });
    off();
    e.emit('hit', { damage: 4 });
    expect(seen).toEqual([3]);
  });

  it('once fires a single time', () => {
    const e = new EventEmitter<{ tick: number }>();
    let count = 0;
    e.once('tick', () => count++);
    e.emit('tick', 1);
    e.emit('tick', 2);
    expect(count).toBe(1);
  });

  it('tolerates listeners removing themselves during emit', () => {
    const e = new EventEmitter<{ x: undefined }>();
    const calls: string[] = [];
    const offA = e.on('x', () => {
      calls.push('a');
      offA();
      offB();
    });
    const offB = e.on('x', () => calls.push('b'));
    e.emit('x', undefined);
    expect(calls).toEqual(['a', 'b']);
    e.emit('x', undefined);
    expect(calls).toEqual(['a', 'b']);
  });
});

describe('Random', () => {
  it('is deterministic for a seed', () => {
    const a = new Random(1234);
    const b = new Random(1234);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('differs across seeds', () => {
    expect(new Random(1).next()).not.toBe(new Random(2).next());
  });

  it('stays within ranges', () => {
    const r = new Random(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 5);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(5);
      const f = r.range(-1, 1);
      expect(f).toBeGreaterThanOrEqual(-1);
      expect(f).toBeLessThan(1);
    }
  });

  it('forks independent streams deterministically', () => {
    const a = new Random(9).fork();
    const b = new Random(9).fork();
    expect(a.next()).toBe(b.next());
  });
});

describe('DisposeBag', () => {
  it('disposes in reverse order exactly once', () => {
    const order: string[] = [];
    const bag = new DisposeBag();
    bag.add(() => order.push('first'));
    bag.add({ dispose: () => order.push('second') });
    bag.dispose();
    bag.dispose();
    expect(order).toEqual(['second', 'first']);
    expect(bag.isDisposed).toBe(true);
    expect(() => bag.add(() => undefined)).toThrow();
  });
});
