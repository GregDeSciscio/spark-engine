/**
 * Fixed-capacity index pool. Indices are reused LIFO so a hot popup churn
 * keeps touching the same few DOM nodes. Pure; `WorldLabels` maps indices to
 * elements.
 */
export class LabelPool {
  private readonly free: number[] = [];
  private readonly live = new Set<number>();
  private allocated = 0;
  private refusals = 0;

  constructor(readonly capacity: number) {
    if (!(capacity > 0) || !Number.isInteger(capacity)) throw new Error('LabelPool: capacity must be a positive integer');
  }

  /** An index in [0, capacity), or -1 when the pool is exhausted. */
  acquire(): number {
    const reused = this.free.pop();
    if (reused !== undefined) {
      this.live.add(reused);
      return reused;
    }
    if (this.allocated >= this.capacity) {
      this.refusals += 1;
      return -1;
    }
    const index = this.allocated++;
    this.live.add(index);
    return index;
  }

  release(index: number): boolean {
    if (!this.live.delete(index)) return false;
    this.free.push(index);
    return true;
  }

  isLive(index: number): boolean {
    return this.live.has(index);
  }

  /** Live indices; do not mutate. */
  entries(): IterableIterator<number> {
    return this.live.values();
  }

  get active(): number {
    return this.live.size;
  }

  /** Indices ever handed out (DOM nodes that exist). */
  get highWater(): number {
    return this.allocated;
  }

  get refused(): number {
    return this.refusals;
  }

  clear(): void {
    this.free.length = 0;
    this.live.clear();
    this.allocated = 0;
  }
}
