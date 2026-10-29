import type { NodeLoad } from '../core/strain';
import type { StructureData } from '../core/structure';
import { StrainRunner, type StrainInit, type StrainReply, type StrainRequest, type StrainStep } from './StrainRunner';

export type { StrainInit, StrainStep } from './StrainRunner';

/**
 * Where the strain solve runs (ADR-011). `worker`: off the main thread, the
 * default in a browser, since a cascade step costs milliseconds to tens of
 * them. `inline`: synchronously, in Node, under `?fixedclock` and when asked
 * for, where results must land on the frame that asked for them. Callbacks
 * rather than promises for the same reason: a synchronous `stepFrames(n)`
 * never yields to the microtask queue.
 */
export interface StrainHost {
  /** Where the solve runs now. A worker host that lost its worker answers `inline` from then on. */
  readonly mode: 'worker' | 'inline';
  init(data: StructureData, done: (info: StrainInit) => void): void;
  remove(nodes: readonly number[]): void;
  /** Standing loads (zero clears one). */
  load(loads: readonly NodeLoad[]): void;
  /** One cascade step; `transient` loads (a blast) count for this step only. */
  step(withHeat: boolean, transient: readonly NodeLoad[], done: (step: StrainStep) => void): void;
  dispose(): void;
}

export class InlineStrainHost implements StrainHost {
  readonly mode = 'inline' as const;
  private readonly runner = new StrainRunner();

  init(data: StructureData, done: (info: StrainInit) => void): void {
    done(this.runner.init(data));
  }

  remove(nodes: readonly number[]): void {
    this.runner.remove(nodes);
  }

  load(loads: readonly NodeLoad[]): void {
    this.runner.load(loads);
  }

  step(withHeat: boolean, transient: readonly NodeLoad[], done: (step: StrainStep) => void): void {
    done(this.runner.step(withHeat, transient));
  }

  dispose(): void {}
}

/**
 * The solve in a module worker, made on first use. If the worker cannot be
 * made, fails to load, throws, or sends something that cannot be read, the
 * host falls back to solving inline: it replays every request so far into a
 * main-thread runner (the solver is deterministic, so it reaches the same
 * state) and answers whatever was still waiting. A caller that keeps one step
 * in flight never waits forever.
 */
export class WorkerStrainHost implements StrainHost {
  private worker: Worker | null = null;
  /** The main-thread runner, once the worker has failed. */
  private fallback: StrainRunner | null = null;
  /** Every request sent to the worker, in order, for a replay if it fails. */
  private readonly sent: StrainRequest[] = [];
  /** Callbacks for requests still waiting for an answer, oldest first. */
  private readonly waiting: Array<(reply: StrainReply) => void> = [];
  /** Answers the worker has delivered. */
  private delivered = 0;
  private disposed = false;
  /** Called once if the worker fails and the solve moves to the main thread. */
  onFallback: ((reason: string) => void) | null = null;

  get mode(): 'worker' | 'inline' {
    return this.fallback ? 'inline' : 'worker';
  }

  init(data: StructureData, done: (info: StrainInit) => void): void {
    this.send({ type: 'init', data }, (r) => {
      if (r.type === 'init') done(r.info);
    });
  }

  remove(nodes: readonly number[]): void {
    this.send({ type: 'remove', nodes: [...nodes] });
  }

  load(loads: readonly NodeLoad[]): void {
    this.send({ type: 'load', loads: [...loads] });
  }

  step(withHeat: boolean, transient: readonly NodeLoad[], done: (step: StrainStep) => void): void {
    this.send({ type: 'step', heat: withHeat, transient: [...transient] }, (r) => {
      if (r.type === 'step') done(r.step);
    });
  }

  private send(msg: StrainRequest, reply?: (r: StrainReply) => void): void {
    if (this.disposed) return;
    if (this.fallback) {
      const r = this.fallback.handle(msg);
      if (r && reply) reply(r);
      return;
    }
    this.sent.push(msg);
    if (reply) this.waiting.push(reply);
    try {
      this.worker ??= this.spawn();
      this.worker.postMessage(msg);
    } catch (error) {
      this.fallBack(`the strain worker could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private spawn(): Worker {
    // The literal `new Worker(new URL(..., import.meta.url))` form is what bundlers recognise and emit as a worker chunk.
    const worker = new Worker(new URL('./strain.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<StrainReply>) => {
      this.delivered++;
      this.waiting.shift()?.(e.data);
    };
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.fallBack(`the strain worker failed: ${e.message || 'it did not load'}`);
    };
    worker.onmessageerror = () => this.fallBack('the strain worker sent a message that could not be read');
    return worker;
  }

  /** Move the solve to the main thread: replay what the worker was told, answer what it never did. */
  private fallBack(reason: string): void {
    if (this.fallback || this.disposed) return;
    this.worker?.terminate();
    this.worker = null;
    const runner = new StrainRunner();
    this.fallback = runner;
    let answers = 0;
    for (const msg of this.sent) {
      const r = runner.handle(msg);
      // Answers the worker already gave were acted on; the rest go to whoever is still waiting.
      if (r && answers++ >= this.delivered) this.waiting.shift()?.(r);
    }
    this.sent.length = 0;
    this.waiting.length = 0;
    this.onFallback?.(reason);
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.sent.length = 0;
    this.waiting.length = 0;
  }
}
