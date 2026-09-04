import { EventEmitter } from '../core/Events';

export interface LoadingSnapshot {
  /** Items that finished successfully in the current batch. */
  itemsLoaded: number;
  /** Items that failed in the current batch. */
  itemsFailed: number;
  /** Items begun in the current batch (loaded + failed + in flight). */
  itemsTotal: number;
  /** Bytes received so far across every item whose size is known or reported. */
  bytesLoaded: number;
  /** Sum of known total sizes. Only meaningful when `bytesKnown` is true. */
  bytesTotal: number;
  /** True when every item in the batch has reported its total size. */
  bytesKnown: boolean;
  /** 0..1 overall completion, blending per-item byte fractions where known. */
  ratio: number;
  /** True while at least one item is in flight. */
  active: boolean;
}

export interface LoadingProgressEvents extends Record<string, unknown> {
  progress: LoadingSnapshot;
  /** Fires when the last in-flight item settles (loaded or failed). */
  complete: LoadingSnapshot;
  error: { url: string; error: unknown; snapshot: LoadingSnapshot };
}

interface Item {
  loaded: number;
  total: number | null;
}

/**
 * Aggregates progress across concurrent loads into one line of truth.
 *
 * A "batch" starts with the first `begin()` after idle and ends when the last
 * item settles; counters reset when the next batch begins, so a loading bar
 * can show "3 / 7" for the current wave rather than a lifetime total.
 */
export class LoadingProgress {
  readonly events = new EventEmitter<LoadingProgressEvents>();

  private readonly inFlight = new Map<string, Item>();
  private itemsLoaded = 0;
  private itemsFailed = 0;
  private itemsTotal = 0;
  private settledBytes = 0;
  private batchDone = false;

  begin(url: string): void {
    if (this.batchDone) this.reset();
    if (this.inFlight.has(url)) return;
    this.inFlight.set(url, { loaded: 0, total: null });
    this.itemsTotal++;
    this.events.emit('progress', this.snapshot());
  }

  /** Report bytes for an in-flight item. `total` may be omitted when the server did not say. */
  update(url: string, loaded: number, total?: number): void {
    const item = this.inFlight.get(url);
    if (!item) return;
    item.loaded = Math.max(0, loaded);
    if (total !== undefined && total > 0) item.total = total;
    this.events.emit('progress', this.snapshot());
  }

  finish(url: string): void {
    const item = this.inFlight.get(url);
    if (!item) return;
    this.inFlight.delete(url);
    this.itemsLoaded++;
    this.settledBytes += item.total ?? item.loaded;
    this.settle();
  }

  fail(url: string, error: unknown): void {
    const item = this.inFlight.get(url);
    if (!item) return;
    this.inFlight.delete(url);
    this.itemsFailed++;
    this.settledBytes += item.loaded;
    this.events.emit('error', { url, error, snapshot: this.snapshot() });
    this.settle();
  }

  snapshot(): LoadingSnapshot {
    let bytesLoaded = this.settledBytes;
    let bytesTotal = this.settledBytes;
    let bytesKnown = true;
    let fraction = this.itemsLoaded + this.itemsFailed;
    for (const item of this.inFlight.values()) {
      bytesLoaded += item.loaded;
      if (item.total === null) {
        bytesKnown = false;
      } else {
        bytesTotal += item.total;
        fraction += Math.min(1, item.loaded / item.total);
      }
    }
    const ratio = this.itemsTotal === 0 ? 1 : Math.min(1, fraction / this.itemsTotal);
    return {
      itemsLoaded: this.itemsLoaded,
      itemsFailed: this.itemsFailed,
      itemsTotal: this.itemsTotal,
      bytesLoaded,
      bytesTotal,
      bytesKnown,
      ratio,
      active: this.inFlight.size > 0,
    };
  }

  get isActive(): boolean {
    return this.inFlight.size > 0;
  }

  /** Forget everything, including listeners. */
  dispose(): void {
    this.inFlight.clear();
    this.reset();
    this.events.clear();
  }

  private settle(): void {
    const snapshot = this.snapshot();
    this.events.emit('progress', snapshot);
    if (this.inFlight.size === 0) {
      this.batchDone = true;
      this.events.emit('complete', snapshot);
    }
  }

  private reset(): void {
    this.itemsLoaded = 0;
    this.itemsFailed = 0;
    this.itemsTotal = 0;
    this.settledBytes = 0;
    this.batchDone = false;
  }
}
