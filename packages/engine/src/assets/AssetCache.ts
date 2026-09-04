import type { Disposable } from '../core/Disposable';

/**
 * Anything the cache can hold. Assets report an estimate of the GPU memory
 * they own so `stats()` can answer "how much is resident?" without touching
 * the renderer.
 */
export interface CachedAsset extends Disposable {
  readonly url: string;
  /** Estimated bytes of texture data owned by this asset (0 if none). */
  readonly textureBytes: number;
  /** Estimated bytes of vertex/index data owned by this asset (0 if none). */
  readonly geometryBytes: number;
}

/** Produces the asset for a URL. The signal fires if every holder releases before the load lands. */
export type AssetLoader<T> = (signal: AbortSignal) => Promise<T>;

export interface AssetCacheStats {
  /** Fully loaded assets currently resident. */
  items: number;
  /** Loads started but not yet resolved. */
  inFlight: number;
  /** Sum of reference counts across all entries. */
  refs: number;
  textureBytes: number;
  geometryBytes: number;
  /** Requests served from cache (resident or by joining an in-flight load). */
  hits: number;
  /** Requests that started a new load. */
  misses: number;
}

/** Thrown to waiters when a load is released to zero (or the cache disposed) before it resolved. */
export class AssetLoadAbortedError extends Error {
  constructor(readonly url: string) {
    super(`Asset load aborted: ${url}`);
    this.name = 'AssetLoadAbortedError';
  }
}

interface Entry<T> {
  readonly url: string;
  refs: number;
  asset: T | null;
  pending: Promise<T> | null;
  controller: AbortController | null;
}

/**
 * Ref-counted asset cache. Pure logic: it never touches three or the DOM, and
 * is driven by a loader callback so it can be unit-tested with a mock.
 *
 * - `acquire(url, loader)` returns the resident asset, joins an in-flight
 *   load, or starts one. Each call adds one reference.
 * - `release(url)` drops one reference; the asset is disposed (or the load
 *   aborted) when the count reaches zero.
 */
export class AssetCache<T extends CachedAsset> implements Disposable {
  private readonly entries = new Map<string, Entry<T>>();
  private hits = 0;
  private misses = 0;
  private disposed = false;

  acquire(url: string, loader: AssetLoader<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('AssetCache: acquire() on a disposed cache'));

    const existing = this.entries.get(url);
    if (existing) {
      existing.refs++;
      this.hits++;
      if (existing.asset) return Promise.resolve(existing.asset);
      if (existing.pending) return existing.pending;
    }

    this.misses++;
    const controller = new AbortController();
    const entry: Entry<T> = { url, refs: 1, asset: null, pending: null, controller };
    this.entries.set(url, entry);

    const pending = loader(controller.signal).then(
      (asset) => {
        const cancelled = controller.signal.aborted || entry.refs <= 0 || this.disposed;
        if (cancelled) {
          if (this.entries.get(url) === entry) this.entries.delete(url);
          asset.dispose();
          throw new AssetLoadAbortedError(url);
        }
        entry.asset = asset;
        entry.pending = null;
        entry.controller = null;
        return asset;
      },
      (error: unknown) => {
        if (this.entries.get(url) === entry) this.entries.delete(url);
        if (controller.signal.aborted) throw new AssetLoadAbortedError(url);
        throw error;
      },
    );
    entry.pending = pending;
    return pending;
  }

  /** The resident asset for a URL, without touching its reference count. */
  get(url: string): T | undefined {
    return this.entries.get(url)?.asset ?? undefined;
  }

  /** True when the asset is resident (loaded). */
  has(url: string): boolean {
    const entry = this.entries.get(url);
    return entry !== undefined && entry.asset !== null;
  }

  isLoading(url: string): boolean {
    const entry = this.entries.get(url);
    return entry !== undefined && entry.pending !== null;
  }

  refCount(url: string): number {
    return this.entries.get(url)?.refs ?? 0;
  }

  /**
   * Drop one reference. Returns true if this call disposed the asset (or
   * aborted its load). Releasing an unknown URL is a no-op that returns false.
   */
  release(url: string): boolean {
    const entry = this.entries.get(url);
    if (!entry) return false;
    entry.refs--;
    if (entry.refs > 0) return false;
    this.evict(entry);
    return true;
  }

  /** Dispose every resident asset and abort every in-flight load, regardless of reference counts. */
  releaseAll(): void {
    for (const entry of Array.from(this.entries.values())) {
      entry.refs = 0;
      this.evict(entry);
    }
  }

  stats(): AssetCacheStats {
    let items = 0;
    let inFlight = 0;
    let refs = 0;
    let textureBytes = 0;
    let geometryBytes = 0;
    for (const entry of this.entries.values()) {
      refs += entry.refs;
      if (entry.asset) {
        items++;
        textureBytes += entry.asset.textureBytes;
        geometryBytes += entry.asset.geometryBytes;
      } else {
        inFlight++;
      }
    }
    return { items, inFlight, refs, textureBytes, geometryBytes, hits: this.hits, misses: this.misses };
  }

  /** URLs of every entry, resident or in flight. */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseAll();
    this.disposed = true;
  }

  private evict(entry: Entry<T>): void {
    if (this.entries.get(entry.url) === entry) this.entries.delete(entry.url);
    if (entry.asset) {
      entry.asset.dispose();
      entry.asset = null;
    } else if (entry.controller) {
      entry.controller.abort();
      entry.controller = null;
    }
  }
}
