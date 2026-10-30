import { StrainSolver, type NodeLoad, type StepResult } from '../core/strain';
import type { StructureData } from '../core/structure';

/**
 * One strain solver turned into plain messages, shared by both hosts. It is
 * also the only thing the worker imports (with `destruction/core`): no three,
 * no Rapier, no engine barrel, which a lint rule holds (ADR-011).
 */

/** What one strain step tells the runtime. */
export interface StrainStep extends Omit<StepResult, 'factor'> {
  liveNodes: number;
  /** Per-node stress over baseline, when asked for. */
  heat: Float32Array | null;
  lBlocks: number;
}

export interface StrainInit {
  timing: StepResult['timing'];
  lBlocks: number;
  dof: number;
}

export type StrainRequest =
  | { type: 'init'; data: StructureData }
  | { type: 'remove'; nodes: number[] }
  | { type: 'load'; loads: NodeLoad[] }
  | { type: 'step'; heat: boolean; transient: NodeLoad[] };

export type StrainReply = { type: 'init'; info: StrainInit } | { type: 'step'; step: StrainStep };

/**
 * One worker carries every structure of a physics world (`StrainWorkerPool`): a request names the
 * structure's solver by `id`, and `drop` frees it. Answers come back with the same `id`, in order.
 */
export type StrainEnvelope = { id: number; msg: StrainRequest } | { id: number; drop: true };
export interface StrainAnswer {
  id: number;
  reply: StrainReply;
}

export class StrainRunner {
  private solver: StrainSolver | null = null;

  init(data: StructureData): StrainInit {
    this.solver = new StrainSolver(data);
    const r = this.solver.init();
    return { timing: r.timing, lBlocks: r.factor?.lBlocks ?? 0, dof: r.dof };
  }

  remove(nodes: readonly number[]): void {
    this.solver?.remove(nodes);
  }

  /** Standing loads (what hangs off the structure); a zero load clears one. */
  load(loads: readonly NodeLoad[]): void {
    for (const l of loads) this.solver?.setLoad(l.node, l.fx, l.fy, l.fz);
  }

  /** Between cascades: rebuild the factor from scratch if downdates have worn on it (ms taken, 0 if nothing to do). */
  idle(): number {
    return this.solver?.idle() ?? 0;
  }

  step(withHeat: boolean, transient: readonly NodeLoad[] = []): StrainStep {
    const solver = this.solver;
    if (!solver) throw new Error('StrainRunner.step before init');
    const { factor, ...r } = solver.step(transient);
    return { ...r, liveNodes: solver.liveNodes, heat: withHeat ? solver.heat() : null, lBlocks: factor?.lBlocks ?? 0 };
  }

  /** Answer one request (the worker's whole job); `remove` and `load` answer nothing. */
  handle(msg: StrainRequest): StrainReply | null {
    switch (msg.type) {
      case 'init':
        return { type: 'init', info: this.init(msg.data) };
      case 'remove':
        this.remove(msg.nodes);
        return null;
      case 'load':
        this.load(msg.loads);
        return null;
      case 'step':
        return { type: 'step', step: this.step(msg.heat, msg.transient) };
    }
  }
}
