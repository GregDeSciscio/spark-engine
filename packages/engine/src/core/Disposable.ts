/**
 * Every resource-owning object in the engine implements this.
 * Disposal must be idempotent: calling it twice is a no-op, never an error.
 */
export interface Disposable {
  dispose(): void;
}

/** Runs each disposer once, in reverse registration order. */
export class DisposeBag implements Disposable {
  private readonly items: Array<() => void> = [];
  private disposed = false;

  add(item: Disposable | (() => void)): void {
    if (this.disposed) {
      throw new Error('DisposeBag: cannot add to a disposed bag');
    }
    this.items.push(typeof item === 'function' ? item : () => item.dispose());
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.items.length - 1; i >= 0; i--) {
      this.items[i]?.();
    }
    this.items.length = 0;
  }
}
