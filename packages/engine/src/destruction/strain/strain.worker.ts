import { StrainRunner, type StrainReply, type StrainRequest } from './StrainRunner';

// The strain solve, off the main thread (ADR-011). Requests are handled in
// order; `init` and `step` answer, `remove` and `load` do not. This file and
// what it imports (StrainRunner, destruction/core) may not import three,
// Rapier or the engine barrel: a lint rule holds that, so the worker bundle
// stays the solver and nothing else.

/** The slice of a dedicated worker's global scope used here (the engine compiles against DOM, not WebWorker). */
interface WorkerScope {
  onmessage: ((e: MessageEvent<StrainRequest>) => void) | null;
  postMessage(message: StrainReply, transfer: Transferable[]): void;
}

const runner = new StrainRunner();
const scope = self as unknown as WorkerScope;
/**
 * Once a cascade has been over for a second, the factor is rebuilt from
 * scratch so downdate rounding never piles up. Any request cancels it first:
 * a refactor takes 30-200 ms, and a blast shouldn't wait behind one. (The
 * inline host never does this: it would stall the main thread.)
 */
const IDLE_MS = 1000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

scope.onmessage = (e) => {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const reply = runner.handle(e.data);
  if (!reply) return;
  const transfer = reply.type === 'step' && reply.step.heat ? [reply.step.heat.buffer as ArrayBuffer] : [];
  scope.postMessage(reply, transfer);
  if (reply.type === 'step' && reply.step.stable) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      runner.idle();
    }, IDLE_MS);
  }
};
