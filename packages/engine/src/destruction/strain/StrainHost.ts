import type { NodeLoad } from '../core/strain';
import type { StructureData } from '../core/structure';
import { StrainRunner, type StrainAnswer, type StrainEnvelope, type StrainInit, type StrainReply, type StrainRequest, type StrainStep } from './StrainRunner';

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
 * The worker every structure of one physics world shares (ADR-011): made when
 * the first structure asks, terminated when the last one goes. Each structure
 * keeps its own solver in it, by id. If the worker cannot be made, fails to
 * load, throws, or sends something that cannot be read, every structure on it
 * falls back to solving inline (one warning for all), and structures that
 * join later solve inline from the start.
 */
export class StrainWorkerPool {
  private static readonly pools = new WeakMap<object, StrainWorkerPool>();
  private worker: Worker | null = null;
  private readonly channels = new Map<number, WorkerStrainHost>();
  private nextId = 1;
  /** Why the worker failed, once it has: everything solves inline from then on. */
  failed: string | null = null;

  /** The pool for `world` (a `PhysicsWorld`): made on first use. */
  static of(world: object): StrainWorkerPool {
    let pool = StrainWorkerPool.pools.get(world);
    if (!pool) {
      pool = new StrainWorkerPool();
      StrainWorkerPool.pools.set(world, pool);
    }
    return pool;
  }

  /** Structures on the worker now. */
  get size(): number {
    return this.channels.size;
  }

  /** Is there a worker running? */
  get running(): boolean {
    return this.worker !== null;
  }

  /** @internal A host joins; its id names its solver in the worker. */
  join(host: WorkerStrainHost): number {
    const id = this.nextId++;
    this.channels.set(id, host);
    return id;
  }

  /** @internal A host leaves: its solver is freed, and the worker with the last one. */
  leave(id: number): void {
    if (!this.channels.delete(id)) return;
    if (this.channels.size === 0) {
      this.worker?.terminate();
      this.worker = null;
    } else this.worker?.postMessage({ id, drop: true } satisfies StrainEnvelope);
  }

  /** @internal Send a request for `id`'s solver; false if there is no worker to send it to (the host solves inline). */
  post(id: number, msg: StrainRequest): boolean {
    if (this.failed) return false;
    try {
      this.worker ??= this.spawn();
      this.worker.postMessage({ id, msg } satisfies StrainEnvelope);
      return true;
    } catch (error) {
      this.fail(`the strain worker could not start: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private spawn(): Worker {
    // The literal `new Worker(new URL(..., import.meta.url))` form is what bundlers recognise and emit as a worker chunk.
    const worker = new Worker(new URL('./strain.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<StrainAnswer>) => this.channels.get(e.data.id)?.deliver(e.data.reply);
    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.fail(`the strain worker failed: ${e.message || 'it did not load'}`);
    };
    worker.onmessageerror = () => this.fail('the strain worker sent a message that could not be read');
    return worker;
  }

  /** The worker is lost: every structure on it moves its solve to the main thread. */
  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = reason;
    this.worker?.terminate();
    this.worker = null;
    let first = true;
    for (const host of [...this.channels.values()]) {
      host.fallBack(reason, first);
      first = false;
    }
  }
}

/**
 * A structure's solve on its physics world's shared worker (`StrainWorkerPool`).
 * If the worker fails, the host falls back to solving inline: it replays
 * every request so far into a main-thread runner (the solver is
 * deterministic, so it reaches the same state) and answers whatever was still
 * waiting. A caller that keeps one step in flight never waits forever.
 */
export class WorkerStrainHost implements StrainHost {
  private readonly pool: StrainWorkerPool;
  private readonly id: number;
  /** The main-thread runner, once the worker has failed. */
  private fallback: StrainRunner | null = null;
  /** Every request sent to the worker, in order, for a replay if it fails. */
  private readonly sent: StrainRequest[] = [];
  /** Callbacks for requests still waiting for an answer, oldest first. */
  private readonly waiting: Array<(reply: StrainReply) => void> = [];
  /** Answers the worker has delivered. */
  private delivered = 0;
  private disposed = false;
  /** Called once if the worker fails and the solve moves to the main thread (for one of the structures sharing it). */
  onFallback: ((reason: string) => void) | null = null;

  /** On `pool` (one physics world's shared worker), or on a worker of its own. */
  constructor(pool: StrainWorkerPool = new StrainWorkerPool()) {
    this.pool = pool;
    this.id = pool.join(this);
  }

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
    // No worker to take it (it failed, now or before this structure joined): this request is replayed with the rest.
    if (!this.pool.post(this.id, msg)) this.fallBack(this.pool.failed ?? 'the strain worker is unavailable', this.pool.size === 1);
  }

  /** @internal An answer from the worker, for the oldest request still waiting. */
  deliver(reply: StrainReply): void {
    if (this.disposed || this.fallback) return;
    this.delivered++;
    this.waiting.shift()?.(reply);
  }

  /** @internal Move the solve to the main thread: replay what the worker was told, answer what it never did. */
  fallBack(reason: string, announce = true): void {
    if (this.fallback || this.disposed) return;
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
    if (announce) this.onFallback?.(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool.leave(this.id);
    this.sent.length = 0;
    this.waiting.length = 0;
  }
}
