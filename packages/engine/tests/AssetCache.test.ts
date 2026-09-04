import { describe, expect, it } from 'vitest';
import { AssetCache, AssetLoadAbortedError, type CachedAsset } from '../src/assets/AssetCache';

class FakeAsset implements CachedAsset {
  disposed = 0;
  constructor(
    readonly url: string,
    readonly textureBytes = 0,
    readonly geometryBytes = 0,
  ) {}
  dispose(): void {
    this.disposed++;
  }
}

/** A loader whose resolution the test controls. */
function deferredLoader(url: string, bytes = { tex: 0, geo: 0 }) {
  let resolve!: (a: FakeAsset) => void;
  let reject!: (e: unknown) => void;
  let calls = 0;
  let signal: AbortSignal | null = null;
  const loader = (s: AbortSignal): Promise<FakeAsset> => {
    calls++;
    signal = s;
    return new Promise<FakeAsset>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  return {
    loader,
    resolve: () => resolve(new FakeAsset(url, bytes.tex, bytes.geo)),
    reject: (e: unknown) => reject(e),
    get calls() {
      return calls;
    },
    get signal() {
      return signal;
    },
  };
}

const immediate =
  (url: string, tex = 0, geo = 0) =>
  async (): Promise<FakeAsset> =>
    new FakeAsset(url, tex, geo);

describe('AssetCache', () => {
  it('loads once and returns the same object for repeated acquires', async () => {
    const cache = new AssetCache<FakeAsset>();
    let calls = 0;
    const loader = async (): Promise<FakeAsset> => {
      calls++;
      return new FakeAsset('a.glb');
    };
    const a = await cache.acquire('a.glb', loader);
    const b = await cache.acquire('a.glb', loader);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(cache.refCount('a.glb')).toBe(2);
    expect(cache.stats()).toMatchObject({ items: 1, inFlight: 0, refs: 2, hits: 1, misses: 1 });
  });

  it('de-duplicates in-flight loads', async () => {
    const cache = new AssetCache<FakeAsset>();
    const d = deferredLoader('a.glb');
    const p1 = cache.acquire('a.glb', d.loader);
    const p2 = cache.acquire('a.glb', d.loader);
    expect(d.calls).toBe(1);
    expect(cache.isLoading('a.glb')).toBe(true);
    expect(cache.has('a.glb')).toBe(false);
    expect(cache.stats().inFlight).toBe(1);
    d.resolve();
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(cache.has('a.glb')).toBe(true);
    expect(cache.stats()).toMatchObject({ items: 1, inFlight: 0, refs: 2, hits: 1, misses: 1 });
  });

  it('disposes when the reference count reaches zero, and not before', async () => {
    const cache = new AssetCache<FakeAsset>();
    const a = await cache.acquire('a.glb', immediate('a.glb'));
    await cache.acquire('a.glb', immediate('a.glb'));
    expect(cache.release('a.glb')).toBe(false);
    expect(a.disposed).toBe(0);
    expect(cache.release('a.glb')).toBe(true);
    expect(a.disposed).toBe(1);
    expect(cache.get('a.glb')).toBeUndefined();
    expect(cache.release('a.glb')).toBe(false);
    expect(cache.stats().items).toBe(0);
  });

  it('reloads after eviction instead of handing back a disposed asset', async () => {
    const cache = new AssetCache<FakeAsset>();
    const first = await cache.acquire('a.glb', immediate('a.glb'));
    cache.release('a.glb');
    const second = await cache.acquire('a.glb', immediate('a.glb'));
    expect(second).not.toBe(first);
    expect(first.disposed).toBe(1);
    expect(second.disposed).toBe(0);
    expect(cache.stats().misses).toBe(2);
  });

  it('aborts an in-flight load when released to zero and rejects waiters', async () => {
    const cache = new AssetCache<FakeAsset>();
    const d = deferredLoader('a.glb');
    const p = cache.acquire('a.glb', d.loader);
    expect(cache.release('a.glb')).toBe(true);
    expect(d.signal?.aborted).toBe(true);
    expect(cache.isLoading('a.glb')).toBe(false);
    d.resolve();
    await expect(p).rejects.toBeInstanceOf(AssetLoadAbortedError);
    expect(cache.stats()).toMatchObject({ items: 0, inFlight: 0 });
  });

  it('disposes a late-arriving asset whose holders all released', async () => {
    const cache = new AssetCache<FakeAsset>();
    const d = deferredLoader('a.glb');
    const p = cache.acquire('a.glb', d.loader);
    cache.release('a.glb');
    const asset = new FakeAsset('a.glb');
    // Resolve with a specific instance so we can check it was disposed.
    let resolved: FakeAsset | null = null;
    d.resolve();
    await p.catch(() => undefined);
    // A fresh acquire after abort starts a brand-new load.
    const p2 = cache.acquire('a.glb', async () => {
      resolved = asset;
      return asset;
    });
    await p2;
    expect(resolved).toBe(asset);
    expect(asset.disposed).toBe(0);
    expect(cache.has('a.glb')).toBe(true);
  });

  it('propagates loader errors and forgets the entry', async () => {
    const cache = new AssetCache<FakeAsset>();
    const d = deferredLoader('bad.glb');
    const p = cache.acquire('bad.glb', d.loader);
    d.reject(new Error('404'));
    await expect(p).rejects.toThrow('404');
    expect(cache.keys()).toEqual([]);
    expect(cache.refCount('bad.glb')).toBe(0);
    // Retry works.
    const ok = await cache.acquire('bad.glb', immediate('bad.glb'));
    expect(ok.url).toBe('bad.glb');
  });

  it('reports byte estimates and releaseAll disposes everything', async () => {
    const cache = new AssetCache<FakeAsset>();
    const a = await cache.acquire('a.glb', immediate('a.glb', 1000, 200));
    const b = await cache.acquire('b.glb', immediate('b.glb', 50, 25));
    await cache.acquire('b.glb', immediate('b.glb'));
    expect(cache.stats()).toMatchObject({ items: 2, refs: 3, textureBytes: 1050, geometryBytes: 225 });
    const d = deferredLoader('c.glb');
    const pending = cache.acquire('c.glb', d.loader);
    cache.releaseAll();
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(1);
    expect(d.signal?.aborted).toBe(true);
    d.resolve();
    await expect(pending).rejects.toBeInstanceOf(AssetLoadAbortedError);
    expect(cache.stats()).toMatchObject({ items: 0, inFlight: 0, refs: 0, textureBytes: 0, geometryBytes: 0 });
  });

  it('refuses acquires after dispose and disposal is idempotent', async () => {
    const cache = new AssetCache<FakeAsset>();
    const a = await cache.acquire('a.glb', immediate('a.glb'));
    cache.dispose();
    cache.dispose();
    expect(a.disposed).toBe(1);
    await expect(cache.acquire('a.glb', immediate('a.glb'))).rejects.toThrow(/disposed/);
  });
});
