import { describe, expect, it } from 'vitest';
import { DecalPool } from '../src/rendering/Decals';

describe('DecalPool', () => {
  it('hands out fresh slots until the capacity is reached', () => {
    const pool = new DecalPool(3);
    expect(pool.acquire()).toEqual({ index: 0, recycled: false });
    expect(pool.acquire()).toEqual({ index: 1, recycled: false });
    expect(pool.acquire()).toEqual({ index: 2, recycled: false });
    expect(pool.count).toBe(3);
    expect(pool.slots).toEqual([0, 1, 2]);
  });

  it('recycles the oldest slot first once full', () => {
    const pool = new DecalPool(3);
    for (let i = 0; i < 3; i++) pool.acquire();
    expect(pool.acquire()).toEqual({ index: 0, recycled: true });
    expect(pool.acquire()).toEqual({ index: 1, recycled: true });
    expect(pool.slots).toEqual([2, 0, 1]);
    expect(pool.oldest()).toBe(2);
    expect(pool.count).toBe(3);
  });

  it('reuses an explicitly released slot before recycling', () => {
    const pool = new DecalPool(2);
    pool.acquire();
    pool.acquire();
    expect(pool.release(0)).toBe(true);
    expect(pool.release(0)).toBe(false);
    expect(pool.count).toBe(1);
    expect(pool.acquire()).toEqual({ index: 0, recycled: false });
    expect(pool.acquire()).toEqual({ index: 1, recycled: true });
  });

  it('clear empties the pool and restarts numbering', () => {
    const pool = new DecalPool(2);
    pool.acquire();
    pool.acquire();
    pool.clear();
    expect(pool.count).toBe(0);
    expect(pool.oldest()).toBeNull();
    expect(pool.acquire()).toEqual({ index: 0, recycled: false });
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new DecalPool(0)).toThrow();
    expect(() => new DecalPool(1.5)).toThrow();
  });
});
