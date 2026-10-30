import { StrainRunner, type StrainAnswer, type StrainEnvelope } from './StrainRunner';

// The strain solve, off the main thread (ADR-011). One worker carries every
// structure of a physics world, each its own solver by id; requests are
// handled in order; `init` and `step` answer, `remove` and `load` do not.
// This file and what it imports (StrainRunner, destruction/core) may not
// import three, Rapier or the engine barrel: a lint rule holds that, so the
// worker bundle stays the solver and nothing else.

/** The slice of a dedicated worker's global scope used here (the engine compiles against DOM, not WebWorker). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<StrainEnvelope>) => void) | null;
  postMessage(message: StrainAnswer, transfer: Transferable[]): void;
}

const runners = new Map<number, StrainRunner>();
const scope = self as unknown as WorkerScope;
/**
 * Once a structure's cascade has been over for a second with nothing asked
 * of the worker, its factor is rebuilt from scratch so downdate rounding
 * never piles up: one structure at a time, so a request waits behind at most
 * one rebuild. Any request cancels the wait first: a refactor takes 30-200 ms,
 * and a blast shouldn't wait behind one. (The inline host never does this:
 * it would stall the main thread.)
 */
const IDLE_MS = 1000;
/** Structures whose last step came back stable and that have not been rebuilt since. */
const due = new Set<number>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function idleOne(): void {
  idleTimer = null;
  const id = due.values().next().value;
  if (id === undefined) return;
  due.delete(id);
  runners.get(id)?.idle();
  // The next one after a turn of the event loop, so a request that came meanwhile goes first.
  if (due.size > 0) idleTimer = setTimeout(idleOne, 0);
}

scope.onmessage = (e) => {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const env = e.data;
  if ('drop' in env) {
    runners.delete(env.id);
    due.delete(env.id);
  } else {
    let runner = runners.get(env.id);
    if (env.msg.type === 'init') runners.set(env.id, (runner = new StrainRunner()));
    // Asked anything, the structure is busy again: it rebuilds after its next stable step.
    due.delete(env.id);
    const reply = runner?.handle(env.msg) ?? null;
    if (reply) {
      const transfer = reply.type === 'step' && reply.step.heat ? [reply.step.heat.buffer as ArrayBuffer] : [];
      scope.postMessage({ id: env.id, reply }, transfer);
      if (reply.type === 'step' && reply.step.stable) due.add(env.id);
    }
  }
  if (due.size > 0) idleTimer = setTimeout(idleOne, IDLE_MS);
};
