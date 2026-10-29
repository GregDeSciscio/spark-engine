import { BlockCholesky, BlockMatrix, type FactorStats, type Ordering } from './sparse';
import type { StructureData } from './structure';

/**
 * Strain: THE FINALS' structural-integrity layer, rebuilt from the GDC 2024
 * talk. Every chunk is a rigid node with six degrees of freedom; every glued
 * contact is a stiff six-axis spring at its patch. Gravity loads the whole
 * structure, one sparse direct solve gives every node's (tiny) displacement,
 * and each contact's spring force is read back and split into
 * tension/compression, shear and bending. A contact breaks when that combined
 * load exceeds its *baseline* (the load it carried intact) by more than its
 * strength: designers never tune a building to stand, only how much extra it
 * takes before it gives.
 *
 * The factor of the stiffness matrix is kept between steps, as Embark's is:
 * a step that only changes loads re-solves with it, and a broken contact is
 * taken out of it by an exact rank-6 downdate instead of a refactor. A piece
 * that falls away keeps its internal contacts in the factor and stays hung
 * off the standing structure by exactly one contact (or none, if it still
 * touches the ground): a free body on a single contact adds no stiffness to
 * what it hangs from, so the standing structure's solve is exact, and the
 * fallen piece never leaves a near-zero pivot behind.
 *
 * The solver is engine-agnostic: plain typed arrays in, broken contacts and
 * detached islands out. It runs in a Web Worker in the sandbox, and in Node
 * for the tests and benchmarks.
 */

export interface Strengths {
  /** Extra stress (Pa) a contact takes beyond its baseline, per mode. Gameplay values, not building codes. */
  tension: number;
  compression: number;
  shear: number;
  bending: number;
}

export interface StrainOptions {
  gravity: number;
  /** Young's modulus of the glue (Pa). Only stiffness *ratios* change the answer. */
  youngs: number;
  /** Shear modulus as a fraction of Young's. */
  shearRatio: number;
  strengths: Strengths;
  /** Break when utilization > baseline + breakOffset (utilization is stress / strength, summed over modes). */
  breakOffset: number;
  /**
   * Structures with more live chunks than this re-solve only around the
   * damage (within `localRadius` metres, the rest held at its last
   * displacement), then confirm with one full solve once the cascade settles.
   * Off by default: the kept factor makes whole solves cheap. A fallback for
   * structures too big for that.
   */
  localThreshold: number;
  localRadius: number;
  /** A region bigger than this shrinks its radius (down to a third); one still over half the structure solves whole. */
  localMaxRegion: number;
  /**
   * Failure is sequential: each step breaks only connections within this
   * fraction of the worst overload (and over 1), then the load redistributes
   * before the next step decides. 0 breaks everything over 1 at once.
   */
  breakFraction: number;
  /**
   * At most this many connections break in one step (the worst first); the
   * rest of the overloaded ones are re-solved and break next step if still
   * over. Each break costs the next step one rank-6 downdate, so this bounds
   * the step time.
   */
  maxBreaksPerStep: number;
  /**
   * How the factor follows broken connections: `downdate` takes each one out
   * exactly (or refactors when that would cost more); `refactor` rebuilds the
   * factor whenever the matrix changed (the reference the downdates are
   * tested against).
   */
  factorUpdate: 'downdate' | 'refactor';
  /** Fill-reducing ordering of the block graph. */
  ordering: Ordering;
  /** Solve and downdate in the WebAssembly kernels where they run; false keeps everything in JS (the same numbers, slower). */
  kernels: boolean;
  /** A solve whose backward error (see `StepResult.backwardError`) is over this is refined once, then refactored. */
  residualTol: number;
}

export const DEFAULT_STRAIN: StrainOptions = {
  gravity: 9.81,
  youngs: 3e10,
  shearRatio: 0.4,
  strengths: { tension: 1e6, compression: 6e6, shear: 1.5e6, bending: 2.5e6 },
  breakOffset: 1,
  localThreshold: Infinity,
  localRadius: 8,
  localMaxRegion: 700,
  breakFraction: 0.6,
  maxBreaksPerStep: 16,
  factorUpdate: 'downdate',
  ordering: 'nested',
  kernels: true,
  residualTol: 1e-10,
};

export interface StepTiming {
  /** Building the matrix (refactors) and the load vector. */
  assembleMs: number;
  orderMs: number;
  /** Numeric factorization (0 when the kept factor was reused or downdated). */
  factorMs: number;
  /** Taking broken connections out of the kept factor. */
  downdateMs: number;
  solveMs: number;
  evaluateMs: number;
  /** Finding what no longer reaches the ground. */
  detachMs: number;
  totalMs: number;
}

export interface StepResult {
  /** Connections that broke this step. */
  broken: number[];
  /** Groups of nodes no longer held up by the ground: each falls as one body. */
  detached: number[][];
  /** Nothing broke and nothing came loose: the cascade is over. */
  stable: boolean;
  timing: StepTiming;
  /** Live nodes in the solve × 6. */
  dof: number;
  /** Largest (utilization − baseline) / breakOffset over the connections this step evaluated. */
  worst: number;
  factor: FactorStats | null;
  /** `global`: the whole structure; `local`: a region around the damage; `idle`: nothing to solve. */
  mode: 'global' | 'local' | 'idle';
  /** Nodes in this step's solve. */
  region: number;
  /** What the kept factor went through: rebuilt, downdated, reused as is, or not touched (local and idle steps). */
  update: 'refactor' | 'downdate' | 'reuse' | 'none';
  /** Connections downdated out of the factor this step. */
  downdated: number;
  /** Over the cap this step: overloaded connections left to the next one. */
  spared: number;
  /** Relative residual ‖f − K u‖ / ‖f‖ of a global solve (0 otherwise). */
  residual: number;
  /** Normwise backward error of a global solve, ‖f − K u‖ / (‖Σ|K_c u|‖ + ‖f‖): what decides refinement. */
  backwardError: number;
}

/** A force on a chunk's centre (N), for blasts or anything hanging off the structure. */
export interface NodeLoad {
  node: number;
  fx: number;
  fy: number;
  fz: number;
}

const BB = 36;
/**
 * A downdate's counted multiply-adds against a factor's, for the same wall
 * time (measured by `pnpm bench`): with the WebAssembly kernels a downdate's
 * rotations run faster per count than the factor's JS updates, without them
 * slower.
 */
const DOWNDATE_WEIGHT = { kernels: 0.7, js: 1.7 };

function cellKey(x: number, y: number, z: number): string {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

/** 6×6 row-major multiply helpers for element assembly. */
function mul6(a: Float64Array, b: Float64Array, out: Float64Array): Float64Array {
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += a[i * 6 + k]! * b[k * 6 + j]!;
      out[i * 6 + j] = s;
    }
  return out;
}

function mulT6(a: Float64Array, b: Float64Array, out: Float64Array): Float64Array {
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += a[k * 6 + i]! * b[k * 6 + j]!;
      out[i * 6 + j] = s;
    }
  return out;
}

const emptyTiming = (): StepTiming => ({ assembleMs: 0, orderMs: 0, factorMs: 0, downdateMs: 0, solveMs: 0, evaluateMs: 0, detachMs: 0, totalMs: 0 });

export class StrainSolver {
  readonly data: StructureData;
  readonly options: StrainOptions;
  /** 1 while the node is part of the standing structure. */
  readonly nodeAlive: Uint8Array;
  /** 1 while the connection holds. */
  readonly connAlive: Uint8Array;
  /** Utilization of each connection in the intact structure. */
  readonly baseline: Float64Array;
  /** Utilization from the latest solve. */
  readonly utilization: Float64Array;
  /** Connections touching each node. */
  private readonly incident: Int32Array[];
  /** Per connection: K_aa, K_ab, K_bb (36 each) and the spring matrices K_lin, K_rot (9 each). */
  private readonly kaa: Float64Array;
  private readonly kab: Float64Array;
  private readonly kbb: Float64Array;
  private readonly klin: Float64Array;
  private readonly krot: Float64Array;
  /** Rank-6 factors of each element matrix, row-major 6×6: K_aa = W_a W_aᵀ, K_ab = W_a W_bᵀ, K_bb = W_b W_bᵀ. */
  private readonly wa: Float64Array;
  private readonly wb: Float64Array;
  /** Per connection: farthest patch vertex from its centroid (for torsion). */
  private readonly rmax: Float64Array;
  private readonly chol: BlockCholesky;
  /** Per connection: the block of L its K_ab lands in (−1 for the ground), and whether it lands transposed. */
  private readonly connSlot: Int32Array;
  private readonly connTrans: Uint8Array;
  /** 1 while the connection's stiffness is in the kept factor. */
  private readonly inFactor: Uint8Array;
  /** Connections that stopped holding since the factor last took them out. */
  private pending: number[] = [];
  /** The kept factor matches `inFactor` (false before the first solve and after a failed downdate). */
  private factorValid = false;
  /** Connections downdated since the last full factorization. */
  private downdatesSinceRefactor = 0;
  /**
   * Fallen pieces in the kept factor: dead nodes joined by the contacts the
   * factor still holds (union–find), each piece either grounded (an identity
   * row from the last refactor, or a ground contact still in) or hung off the
   * standing structure by exactly one contact, `link`.
   */
  private readonly deadParent: Int32Array;
  private readonly deadGrounded: Uint8Array;
  private readonly deadLink: Int32Array;
  /** Nodes that died since the factor last caught up. */
  private newlyDead: number[] = [];
  private displacement: Float64Array;
  private readonly rhs: Float64Array;
  /** The load vector `displacement` solves with the kept factor (when `solvedValid`). */
  private readonly solvedRhs: Float64Array;
  private solvedValid = false;
  /** The change to solve for this step, and the block rows it touches. */
  private readonly delta: Float64Array;
  private readonly deltaNodes: number[] = [];
  private readonly deltaMark: Uint8Array;
  private readonly residualVec: Float64Array;
  /** Per degree of freedom: Σ |K_c u| over the connections at it, for the backward error. */
  private readonly forceScale: Float64Array;
  /** Some connection was cut since islands were last looked for. */
  private topologyDirty = true;
  /** Nodes whose surroundings changed since they were last solved. */
  private readonly dirty = new Set<number>();
  /** A local cascade settled: one full solve is owed before the structure counts as stable. */
  private verifyPending = false;
  /** Standing loads (N) per node, xyz. */
  private readonly extra: Float64Array;
  /** Node centroids hashed by `localRadius` cells, for region queries. */
  private readonly grid = new Map<string, number[]>();
  private live: number;

  constructor(data: StructureData, options: Partial<StrainOptions> = {}) {
    this.data = data;
    this.options = { ...DEFAULT_STRAIN, ...options, strengths: { ...DEFAULT_STRAIN.strengths, ...options.strengths } };
    const n = data.nodeCount;
    const m = data.connCount;
    this.nodeAlive = new Uint8Array(n).fill(1);
    this.live = n;
    this.connAlive = new Uint8Array(m).fill(1);
    this.baseline = new Float64Array(m);
    this.utilization = new Float64Array(m);
    this.displacement = new Float64Array(n * 6);
    this.rhs = new Float64Array(n * 6);
    this.residualVec = new Float64Array(n * 6);
    this.delta = new Float64Array(n * 6);
    this.deltaMark = new Uint8Array(n);
    this.solvedRhs = new Float64Array(n * 6);
    this.forceScale = new Float64Array(n * 6);
    this.extra = new Float64Array(n * 3);
    const cell = this.options.localRadius;
    for (let v = 0; v < n; v++) {
      const key = cellKey(data.center[v * 3]! / cell, data.center[v * 3 + 1]! / cell, data.center[v * 3 + 2]! / cell);
      const list = this.grid.get(key);
      if (list) list.push(v);
      else this.grid.set(key, [v]);
    }

    const lists: number[][] = Array.from({ length: n }, () => []);
    for (let c = 0; c < m; c++) {
      lists[data.connA[c]!]!.push(c);
      const b = data.connB[c]!;
      if (b >= 0) lists[b]!.push(c);
    }
    this.incident = lists.map((l) => Int32Array.from(l));

    this.kaa = new Float64Array(m * BB);
    this.kab = new Float64Array(m * BB);
    this.kbb = new Float64Array(m * BB);
    this.klin = new Float64Array(m * 9);
    this.krot = new Float64Array(m * 9);
    this.wa = new Float64Array(m * BB);
    this.wb = new Float64Array(m * BB);
    this.rmax = new Float64Array(m);
    for (let c = 0; c < m; c++) this.buildElement(c);
    this.deadParent = new Int32Array(n).fill(-1);
    this.deadGrounded = new Uint8Array(n);
    this.deadLink = new Int32Array(n).fill(-1);

    // One ordering per structure; every later matrix is a subset of this pattern.
    const ei = new Int32Array(m);
    const ej = new Int32Array(m);
    for (let c = 0; c < m; c++) {
      ei[c] = data.connA[c]!;
      ej[c] = data.connB[c]!;
    }
    this.chol = BlockCholesky.analyzeGraph(n, ei, ej, { ordering: this.options.ordering, coords: data.center, kernels: this.options.kernels });
    this.connSlot = new Int32Array(m).fill(-1);
    this.connTrans = new Uint8Array(m);
    for (let c = 0; c < m; c++) {
      const a = data.connA[c]!;
      const b = data.connB[c]!;
      if (b < 0 || a === b) continue;
      this.connSlot[c] = this.chol.slot(a, b);
      // The slot holds L[later][earlier]: K_ba = K_abᵀ when a is eliminated first.
      this.connTrans[c] = this.chol.pos[a]! < this.chol.pos[b]! ? 1 : 0;
    }
    this.inFactor = new Uint8Array(m);
  }

  /** The spring at one contact and its 12×12 element matrix, as three 6×6 blocks and their rank-6 factors. */
  private buildElement(c: number): void {
    const d = this.data;
    const { youngs: E, shearRatio } = this.options;
    const G = E * shearRatio;
    const a = d.connA[c]!;
    const b = d.connB[c]!;
    const n = [d.normal[c * 3]!, d.normal[c * 3 + 1]!, d.normal[c * 3 + 2]!];
    const e1 = [d.e1[c * 3]!, d.e1[c * 3 + 1]!, d.e1[c * 3 + 2]!];
    const e2 = [d.e2[c * 3]!, d.e2[c * 3 + 1]!, d.e2[c * 3 + 2]!];
    const p = [d.point[c * 3]!, d.point[c * 3 + 1]!, d.point[c * 3 + 2]!];
    const ca = [d.center[a * 3]!, d.center[a * 3 + 1]!, d.center[a * 3 + 2]!];
    const A = d.area[c]!;
    const i1 = d.i1[c]!;
    const i2 = d.i2[c]!;

    // Spring length: centroid to centroid, or twice the depth below the centroid for the ground.
    let L: number;
    if (b >= 0) {
      L = Math.hypot(d.center[b * 3]! - ca[0]!, d.center[b * 3 + 1]! - ca[1]!, d.center[b * 3 + 2]! - ca[2]!);
    } else {
      L = 2 * Math.abs((p[0]! - ca[0]!) * n[0]! + (p[1]! - ca[1]!) * n[1]! + (p[2]! - ca[2]!) * n[2]!);
    }
    L = Math.max(L, 0.05);

    const kn = (E * A) / L;
    const ks = (G * A) / L;
    const kb1 = (E * i1) / L;
    const kb2 = (E * i2) / L;
    const kt = (G * (i1 + i2)) / L;
    const lin = this.klin.subarray(c * 9, c * 9 + 9);
    const rot = this.krot.subarray(c * 9, c * 9 + 9);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const nn = n[i]! * n[j]!;
        lin[i * 3 + j] = kn * nn + ks * ((i === j ? 1 : 0) - nn);
        rot[i * 3 + j] = kb1 * e1[i]! * e1[j]! + kb2 * e2[i]! * e2[j]! + kt * nn;
      }

    // D = diag(K_lin, K_rot); relative motion at the patch [δ, φ] = B_a q_a + B_b q_b.
    const D = new Float64Array(36);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        D[i * 6 + j] = lin[i * 3 + j]!;
        D[(i + 3) * 6 + j + 3] = rot[i * 3 + j]!;
      }
    const skew = (r: number[], out: Float64Array, row: number, col: number, s: number): void => {
      // s·[r]×, where [r]× θ = r × θ
      out[row * 6 + col + 1] = -r[2]! * s;
      out[row * 6 + col + 2] = r[1]! * s;
      out[(row + 1) * 6 + col] = r[2]! * s;
      out[(row + 1) * 6 + col + 2] = -r[0]! * s;
      out[(row + 2) * 6 + col] = -r[1]! * s;
      out[(row + 2) * 6 + col + 1] = r[0]! * s;
    };
    // δ = t_b − [r_b]× θ_b − t_a + [r_a]× θ_a ;  φ = θ_b − θ_a
    const Ba = new Float64Array(36);
    const ra = [p[0]! - ca[0]!, p[1]! - ca[1]!, p[2]! - ca[2]!];
    for (let i = 0; i < 3; i++) {
      Ba[i * 6 + i] = -1;
      Ba[(i + 3) * 6 + i + 3] = -1;
    }
    skew(ra, Ba, 0, 3, 1);
    // D = F Fᵀ with F's columns the spring's principal directions scaled by √stiffness:
    // K_lin = kn n nᵀ + ks (e1 e1ᵀ + e2 e2ᵀ), K_rot = kb1 e1 e1ᵀ + kb2 e2 e2ᵀ + kt n nᵀ.
    const F = new Float64Array(36);
    const cols = [
      [n, kn],
      [e1, ks],
      [e2, ks],
    ] as const;
    const rcols = [
      [e1, kb1],
      [e2, kb2],
      [n, kt],
    ] as const;
    for (let q = 0; q < 3; q++) {
      const [dl, kl] = cols[q]!;
      const [dr, kr] = rcols[q]!;
      const sl = Math.sqrt(Math.max(kl, 0));
      const sr = Math.sqrt(Math.max(kr, 0));
      for (let i = 0; i < 3; i++) {
        F[i * 6 + q] = dl[i]! * sl;
        F[(i + 3) * 6 + q + 3] = dr[i]! * sr;
      }
    }
    const tmp = new Float64Array(36);
    const DBa = mul6(D, Ba, new Float64Array(36));
    this.kaa.set(mulT6(Ba, DBa, tmp), c * BB);
    this.wa.set(mulT6(Ba, F, tmp), c * BB);
    if (b >= 0) {
      const Bb = new Float64Array(36);
      const rb = [p[0]! - d.center[b * 3]!, p[1]! - d.center[b * 3 + 1]!, p[2]! - d.center[b * 3 + 2]!];
      for (let i = 0; i < 3; i++) {
        Bb[i * 6 + i] = 1;
        Bb[(i + 3) * 6 + i + 3] = 1;
      }
      skew(rb, Bb, 0, 3, -1);
      const DBb = mul6(D, Bb, new Float64Array(36));
      this.kab.set(mulT6(Ba, DBb, tmp), c * BB);
      this.kbb.set(mulT6(Bb, DBb, tmp), c * BB);
      this.wb.set(mulT6(Bb, F, tmp), c * BB);
    }

    let rmax = 0;
    for (let k = d.polyStart[c]!; k < d.polyStart[c + 1]!; k++) rmax = Math.max(rmax, Math.hypot(d.polyXY[k * 2]!, d.polyXY[k * 2 + 1]!));
    this.rmax[c] = rmax;
  }

  /** Solve the intact structure and record every connection's baseline. */
  init(): StepResult {
    const result = this.solveGlobal(null);
    this.baseline.set(this.utilization);
    this.dirty.clear();
    return { ...result, broken: [], detached: [], stable: true, worst: 0 };
  }

  /** Destroy chunks outright (blown apart, shot away). Their connections go with them. */
  remove(nodes: Iterable<number>): void {
    for (const v of nodes) {
      if (!this.nodeAlive[v]) continue;
      this.nodeAlive[v] = 0;
      this.live--;
      this.newlyDead.push(v);
      this.dirty.delete(v);
      for (const c of this.incident[v]!) this.cut(c);
    }
  }

  /** Set (or clear, with zeros) a standing load on a node, e.g. the pull of something hanging off it. */
  setLoad(node: number, fx: number, fy: number, fz: number): void {
    const o = node * 3;
    if (this.extra[o] === fx && this.extra[o + 1] === fy && this.extra[o + 2] === fz) return;
    this.extra[o] = fx;
    this.extra[o + 1] = fy;
    this.extra[o + 2] = fz;
    if (this.nodeAlive[node]) this.dirty.add(node);
  }

  /** Connection `c` stops holding: the factor owes it a downdate, and both live ends need a fresh solve. */
  private cut(c: number): void {
    if (this.connAlive[c]) {
      this.connAlive[c] = 0;
      this.topologyDirty = true;
      if (this.inFactor[c]) this.pending.push(c);
    }
    this.touch(c);
  }

  /** Something changed at connection `c`: both live ends need a fresh solve. */
  private touch(c: number): void {
    const a = this.data.connA[c]!;
    const b = this.data.connB[c]!;
    if (this.nodeAlive[a]) this.dirty.add(a);
    if (b >= 0 && this.nodeAlive[b]) this.dirty.add(b);
  }

  /** Nothing left to solve: no pending damage and no full solve owed. */
  get settled(): boolean {
    return this.dirty.size === 0 && !this.verifyPending;
  }

  /** Connections downdated out of the kept factor since it was last built from scratch. */
  get downdatesPending(): number {
    return this.downdatesSinceRefactor;
  }

  /**
   * For a host with time on its hands (nothing queued): rebuild the kept
   * factor from scratch if downdates have been applied to it, so their
   * rounding never piles up, and so the factor no longer carries pieces that
   * have fallen away. Returns how long it took (0: nothing to do).
   */
  idle(): number {
    if (this.factorValid && this.downdatesSinceRefactor === 0) return 0;
    const t0 = performance.now();
    this.refactor(emptyTiming());
    return performance.now() - t0;
  }

  /**
   * One cascade step: drop anything no longer grounded, re-solve (the whole
   * structure, or the region around the damage on big ones), break the
   * overloaded connections (the worst first, up to `maxBreaksPerStep`), and
   * drop what that cut loose. Call again until `stable`; spacing the calls out
   * in time is what makes a collapse read as progressive. `transient` loads
   * (a blast) apply to this step's solve only.
   */
  step(transient: readonly NodeLoad[] = []): StepResult {
    const t0 = performance.now();
    for (const l of transient) if (this.nodeAlive[l.node]) this.dirty.add(l.node);
    const detached = this.detachIslands();
    const detachMs = performance.now() - t0;
    if (this.dirty.size === 0 && !this.verifyPending) {
      const timing = emptyTiming();
      timing.detachMs = detachMs;
      timing.totalMs = performance.now() - t0;
      return { broken: [], detached, stable: detached.length === 0, timing, dof: 0, worst: 0, factor: null, mode: 'idle', region: 0, update: 'none', downdated: 0, spared: 0, residual: 0, backwardError: 0 };
    }

    let region: Int32Array | null = null;
    const live = this.live;
    if (live > this.options.localThreshold && this.dirty.size > 0) {
      const { localRadius, localMaxRegion } = this.options;
      for (let R = localRadius; ; R *= 0.75) {
        region = this.regionAround(this.dirty, R);
        if (region.length <= localMaxRegion || R * 0.75 < localRadius / 3) break;
      }
      // Damage spread over most of the structure: a whole solve (with the stored ordering) is cheaper.
      if (region.length > live / 2) region = null;
    }
    this.dirty.clear();
    const result = region ? this.solveLocal(region, transient) : this.solveGlobal(transient);
    if (!region) this.verifyPending = false;
    result.timing.detachMs = detachMs;

    const tEval = performance.now();
    const { breakOffset } = this.options;
    const maxBreaksPerStep = Math.max(1, this.options.maxBreaksPerStep);
    let worst = -Infinity;
    const overC: number[] = [];
    const overX: number[] = [];
    const consider = (c: number): void => {
      if (!this.connAlive[c]) return;
      const excess = (this.utilization[c]! - this.baseline[c]!) / breakOffset;
      if (excess > worst) worst = excess;
      if (excess > 1) {
        overC.push(c);
        overX.push(excess);
      }
    };
    if (region) {
      const seen = new Set<number>();
      for (const v of region) {
        for (const c of this.incident[v]!) {
          if (seen.has(c)) continue;
          seen.add(c);
          consider(c);
        }
      }
    } else {
      for (let c = 0; c < this.data.connCount; c++) consider(c);
    }
    const cut = Math.max(1, worst * this.options.breakFraction);
    let broken: number[] = [];
    for (let i = 0; i < overC.length; i++) if (overX[i]! >= cut) broken.push(i);
    let spared = 0;
    if (broken.length > maxBreaksPerStep) {
      // The worst first (ties by index, so the result is deterministic).
      broken.sort((i, j) => overX[j]! - overX[i]! || overC[i]! - overC[j]!);
      spared = broken.length - maxBreaksPerStep;
      broken.length = Math.max(0, maxBreaksPerStep);
      broken.sort((i, j) => overC[i]! - overC[j]!);
    }
    broken = broken.map((i) => overC[i]!);
    // Whatever is over 1 but spared this step is re-solved next step.
    for (const c of overC) this.touch(c);
    for (const c of broken) this.cut(c);
    const t1 = performance.now();
    detached.push(...this.detachIslands());
    result.timing.detachMs += performance.now() - t1;
    // A quiet local step still owes one full solve before the cascade is over.
    if (region && broken.length === 0 && detached.length === 0) this.verifyPending = true;
    result.timing.evaluateMs += t1 - tEval;
    result.timing.totalMs = performance.now() - t0;
    const stable = broken.length === 0 && detached.length === 0 && this.settled;
    return { ...result, broken, detached, stable, spared, worst: Number.isFinite(worst) ? worst : 0 };
  }

  /** Live nodes within `R` (at most `localRadius`) of any of `seeds`, by rest centroid. */
  private regionAround(seeds: Iterable<number>, R: number): Int32Array {
    const d = this.data;
    const R2 = R * R;
    const cell = this.options.localRadius;
    const reach = Math.ceil(R / cell);
    const inRegion = new Uint8Array(d.nodeCount);
    const out: number[] = [];
    for (const s of seeds) {
      const sx = d.center[s * 3]!;
      const sy = d.center[s * 3 + 1]!;
      const sz = d.center[s * 3 + 2]!;
      const cx = Math.floor(sx / cell);
      const cy = Math.floor(sy / cell);
      const cz = Math.floor(sz / cell);
      for (let x = cx - reach; x <= cx + reach; x++)
        for (let y = cy - reach; y <= cy + reach; y++)
          for (let z = cz - reach; z <= cz + reach; z++) {
            const list = this.grid.get(`${x},${y},${z}`);
            if (!list) continue;
            for (const v of list) {
              if (inRegion[v] || !this.nodeAlive[v]) continue;
              const dx = d.center[v * 3]! - sx;
              const dy = d.center[v * 3 + 1]! - sy;
              const dz = d.center[v * 3 + 2]! - sz;
              if (dx * dx + dy * dy + dz * dz > R2) continue;
              inRegion[v] = 1;
              out.push(v);
            }
          }
    }
    return Int32Array.from(out);
  }

  /** A full solve of the current structure, breaking nothing (benchmarks, heat refresh). */
  solveFull(): StepResult {
    return this.solveGlobal(null);
  }

  /** Per-node stress heat: the worst (utilization − baseline) / breakOffset over its live connections. */
  heat(out = new Float32Array(this.data.nodeCount)): Float32Array {
    out.fill(0);
    for (let c = 0; c < this.data.connCount; c++) {
      if (!this.connAlive[c]) continue;
      const h = Math.max(0, (this.utilization[c]! - this.baseline[c]!) / this.options.breakOffset);
      const a = this.data.connA[c]!;
      const b = this.data.connB[c]!;
      if (h > out[a]!) out[a] = h;
      if (b >= 0 && h > out[b]!) out[b] = h;
    }
    return out;
  }

  get liveNodes(): number {
    return this.live;
  }

  /** Live nodes not connected to the ground through live connections, grouped into islands. */
  private detachIslands(): number[][] {
    if (!this.topologyDirty) return [];
    this.topologyDirty = false;
    const d = this.data;
    const n = d.nodeCount;
    const grounded = new Uint8Array(n);
    const queue: number[] = [];
    for (let c = 0; c < d.connCount; c++) {
      if (!this.connAlive[c] || d.connB[c]! >= 0) continue;
      const a = d.connA[c]!;
      if (this.nodeAlive[a] && !grounded[a]) {
        grounded[a] = 1;
        queue.push(a);
      }
    }
    const flood = (mark: Uint8Array, q: number[], collect?: number[]): void => {
      while (q.length > 0) {
        const v = q.pop()!;
        collect?.push(v);
        for (const c of this.incident[v]!) {
          if (!this.connAlive[c]) continue;
          const a = d.connA[c]!;
          const b = d.connB[c]!;
          const w = a === v ? b : a;
          if (w < 0 || mark[w] || !this.nodeAlive[w]) continue;
          mark[w] = 1;
          q.push(w);
        }
      }
    };
    flood(grounded, queue);
    const islands: number[][] = [];
    for (let v = 0; v < n; v++) {
      if (!this.nodeAlive[v] || grounded[v]) continue;
      const island: number[] = [];
      grounded[v] = 1;
      flood(grounded, [v], island);
      islands.push(island.sort((x, y) => x - y));
    }
    for (const island of islands) {
      for (const v of island) {
        this.nodeAlive[v] = 0;
        this.live--;
        this.newlyDead.push(v);
        this.dirty.delete(v);
      }
      for (const v of island) for (const c of this.incident[v]!) this.cut(c);
    }
    return islands;
  }

  /** Gravity, standing loads and this step's transient loads on node `v`, into `rhs` at `o`. */
  private loadInto(rhs: Float64Array, o: number, v: number, transient: ReadonlyMap<number, NodeLoad> | null): void {
    rhs[o] = this.extra[v * 3]!;
    rhs[o + 1] = this.extra[v * 3 + 1]! - this.data.mass[v]! * this.options.gravity;
    rhs[o + 2] = this.extra[v * 3 + 2]!;
    rhs[o + 3] = 0;
    rhs[o + 4] = 0;
    rhs[o + 5] = 0;
    const t = transient?.get(v);
    if (t) {
      rhs[o]! += t.fx;
      rhs[o + 1]! += t.fy;
      rhs[o + 2]! += t.fz;
    }
  }

  private static byNode(loads: readonly NodeLoad[] | null): Map<number, NodeLoad> | null {
    if (!loads || loads.length === 0) return null;
    const m = new Map<number, NodeLoad>();
    for (const l of loads) {
      const prev = m.get(l.node);
      m.set(l.node, prev ? { node: l.node, fx: prev.fx + l.fx, fy: prev.fy + l.fy, fz: prev.fz + l.fz } : l);
    }
    return m;
  }

  /**
   * K for every live connection, straight into the factor's fixed pattern.
   * Dead nodes get identity rows: they sit out with zero displacement, each a
   * fallen piece of its own, grounded.
   */
  private assemble(): void {
    const d = this.data;
    const chol = this.chol;
    chol.clear();
    const D = chol.diag;
    const V = chol.vals;
    for (let v = 0; v < d.nodeCount; v++) {
      if (this.nodeAlive[v]) {
        this.deadParent[v] = -1;
        continue;
      }
      const o = v * BB;
      for (let i = 0; i < 6; i++) D[o + i * 7] = 1;
      this.deadParent[v] = v;
      this.deadGrounded[v] = 1;
      this.deadLink[v] = -1;
    }
    const { kaa, kab, kbb } = this;
    for (let c = 0; c < d.connCount; c++) {
      if (!this.connAlive[c]) {
        this.inFactor[c] = 0;
        continue;
      }
      this.inFactor[c] = 1;
      const a = d.connA[c]!;
      const b = d.connB[c]!;
      const so = c * BB;
      const ao = a * BB;
      for (let k = 0; k < BB; k++) D[ao + k]! += kaa[so + k]!;
      if (b < 0) continue;
      const bo = b * BB;
      for (let k = 0; k < BB; k++) D[bo + k]! += kbb[so + k]!;
      const to = this.connSlot[c]! * BB;
      if (this.connTrans[c]) {
        for (let r = 0; r < 6; r++) for (let q = 0; q < 6; q++) V[to + q * 6 + r]! += kab[so + r * 6 + q]!;
      } else {
        for (let k = 0; k < BB; k++) V[to + k]! += kab[so + k]!;
      }
    }
    this.pending.length = 0;
    this.newlyDead.length = 0;
  }

  /** Build the kept factor from scratch for the current structure. */
  private refactor(timing: StepTiming): void {
    const t0 = performance.now();
    this.assemble();
    timing.assembleMs += performance.now() - t0;
    const failed = this.chol.factorize();
    timing.factorMs += this.chol.stats.numericMs;
    if (failed >= 0) {
      this.factorValid = false;
      throw new Error(`StrainSolver: stiffness not positive definite at node ${failed} (an ungrounded node slipped through?)`);
    }
    this.factorValid = true;
    this.downdatesSinceRefactor = 0;
    this.solvedValid = false;
  }

  /**
   * Bring the kept factor up to date with the structure: downdate the
   * connections that stopped holding (if that is cheaper than a refactor), or
   * refactor. Fallen pieces keep their internal contacts and at most one link
   * to the standing structure (see `foldDead`).
   */
  private updateFactor(timing: StepTiming): { update: StepResult['update']; downdated: number } {
    if (!this.factorValid || this.options.factorUpdate === 'refactor') {
      if (this.factorValid && this.pending.length === 0 && this.newlyDead.length === 0) return { update: 'reuse', downdated: 0 };
      this.refactor(timing);
      return { update: 'refactor', downdated: 0 };
    }
    const d = this.data;
    const list: number[] = [];
    // Broken between two standing nodes (or a standing node and the ground): out.
    for (const c of this.pending) {
      if (!this.inFactor[c] || this.connAlive[c]) continue;
      const a = d.connA[c]!;
      const b = d.connB[c]!;
      if (this.nodeAlive[a] && (b < 0 || this.nodeAlive[b])) list.push(c);
    }
    this.pending.length = 0;
    this.foldDead(list);
    if (list.length === 0) return { update: 'reuse', downdated: 0 };
    let cost = 0;
    for (const c of list) {
      const a = d.connA[c]!;
      const b = d.connB[c]!;
      cost += 6 * this.chol.downdateCost(b < 0 || this.chol.pos[a]! < this.chol.pos[b]! ? a : b);
    }
    if (cost * (this.chol.usesKernels ? DOWNDATE_WEIGHT.kernels : DOWNDATE_WEIGHT.js) > this.chol.stats.flops) {
      this.refactor(timing);
      return { update: 'refactor', downdated: 0 };
    }
    const t0 = performance.now();
    const k = list.length;
    const node0 = new Int32Array(k);
    const node1 = new Int32Array(k);
    const w = new Float64Array(k * 72);
    for (let i = 0; i < k; i++) {
      const c = list[i]!;
      node0[i] = d.connA[c]!;
      node1[i] = d.connB[c]!;
      w.set(this.wa.subarray(c * BB, c * BB + BB), i * 72);
      if (node1[i]! >= 0) w.set(this.wb.subarray(c * BB, c * BB + BB), i * 72 + 36);
    }
    // With K u = f before, (K − W Wᵀ)(u + δ) = f' needs δ = (K − W Wᵀ)⁻¹ (f' − f + W Wᵀ u):
    // W (Wᵀ u) is the force each removed spring was carrying, now carried by the rest.
    if (this.solvedValid) {
      const u = this.displacement;
      for (let i = 0; i < k; i++) {
        const o = i * 72;
        const a = node0[i]! * 6;
        const b = node1[i]!;
        for (let q = 0; q < 6; q++) {
          let z = 0;
          for (let r = 0; r < 6; r++) z += w[o + r * 6 + q]! * u[a + r]!;
          if (b >= 0) for (let r = 0; r < 6; r++) z += w[o + 36 + r * 6 + q]! * u[b * 6 + r]!;
          for (let r = 0; r < 6; r++) this.delta[a + r]! += w[o + r * 6 + q]! * z;
          if (b >= 0) for (let r = 0; r < 6; r++) this.delta[b * 6 + r]! += w[o + 36 + r * 6 + q]! * z;
        }
        this.markDelta(node0[i]!);
        if (b >= 0) this.markDelta(b);
      }
    }
    const ok = this.chol.downdate(k, node0, node1, w);
    timing.downdateMs += performance.now() - t0;
    if (!ok) {
      // A pivot went (numerically) non-positive: start again from the structure.
      this.refactor(timing);
      return { update: 'refactor', downdated: 0 };
    }
    for (const c of list) this.inFactor[c] = 0;
    this.downdatesSinceRefactor += k;
    return { update: 'downdate', downdated: k };
  }

  /** The fallen piece `v` belongs to (union-find root, with path halving). */
  private deadRoot(v: number): number {
    const P = this.deadParent;
    while (P[v] !== v) {
      P[v] = P[P[v]!]!;
      v = P[v]!;
    }
    return v;
  }

  /**
   * Fold the nodes that died since the last update into the fallen pieces the
   * factor holds, and pick which of their contacts with the standing
   * structure come out (pushed onto `list`). A piece that touches the ground
   * through a contact still in the factor, or has an identity row, loses all
   * of them. Any other piece keeps exactly one, its link: hanging off a single
   * contact, a free body adds no stiffness to the node it hangs from, so the
   * standing structure solves exactly as if the piece were gone, and the
   * piece's own pivots stay as healthy as a cantilever's. (Taking every link
   * out would leave a floating piece singular; ghost springs on every node fix
   * that only by perturbing everything and amplifying rounding at the tiny
   * pivots they leave.)
   */
  private foldDead(list: number[]): void {
    const dead = this.newlyDead;
    if (dead.length === 0) return;
    const d = this.data;
    const P = this.deadParent;
    const G = this.deadGrounded;
    const Lk = this.deadLink;
    for (const v of dead) {
      P[v] = v;
      G[v] = 0;
      Lk[v] = -1;
    }
    const links: number[] = [];
    for (const v of dead) {
      for (const c of this.incident[v]!) {
        if (!this.inFactor[c]) continue;
        const a = d.connA[c]!;
        const b = d.connB[c]!;
        const w = a === v ? b : a;
        if (w < 0) {
          G[this.deadRoot(v)] = 1;
        } else if (this.nodeAlive[w]) {
          links.push(c);
        } else {
          // Both ends dead: the contact holds a piece together. If it was a piece's link, it no longer is.
          const rx = this.deadRoot(v);
          const ry = this.deadRoot(w);
          if (Lk[rx] === c) Lk[rx] = -1;
          if (Lk[ry] === c) Lk[ry] = -1;
          if (rx === ry) continue;
          const lx = Lk[rx]!;
          const ly = Lk[ry]!;
          if (lx >= 0 && ly >= 0) list.push(ly);
          P[ry] = rx;
          G[rx] = G[rx]! | G[ry]!;
          Lk[rx] = lx >= 0 ? lx : ly;
        }
      }
    }
    for (const c of links) {
      const a = d.connA[c]!;
      const r = this.deadRoot(this.nodeAlive[a] ? d.connB[c]! : a);
      if (G[r] || Lk[r]! >= 0) list.push(c);
      else Lk[r] = c;
    }
    for (const v of dead) {
      const r = this.deadRoot(v);
      if (G[r] && Lk[r]! >= 0) {
        list.push(Lk[r]!);
        Lk[r] = -1;
      }
    }
    dead.length = 0;
  }

  /** Note that block row `v` of this step's change is nonzero. */
  private markDelta(v: number): void {
    if (this.deltaMark[v]) return;
    this.deltaMark[v] = 1;
    this.deltaNodes.push(v);
  }

  /**
   * Bring the factor up to date, solve the whole live structure, and evaluate
   * every live connection. The solve is incremental when it can be: with the
   * last displacement solving the last loads on the same (or downdated)
   * factor, only the change is solved for, and a change at a few nodes only
   * costs the factor's backward pass.
   */
  private solveGlobal(transient: readonly NodeLoad[] | null): StepResult {
    const d = this.data;
    const n = d.nodeCount;
    const timing = emptyTiming();
    const t0 = performance.now();
    const delta = this.delta;
    delta.fill(0);
    for (const v of this.deltaNodes) this.deltaMark[v] = 0;
    this.deltaNodes.length = 0;
    const { update, downdated } = this.updateFactor(timing);

    const t1 = performance.now();
    const loads = StrainSolver.byNode(transient);
    const rhs = this.rhs;
    rhs.fill(0);
    for (let v = 0; v < n; v++) if (this.nodeAlive[v]) this.loadInto(rhs, v * 6, v, loads);
    const t2 = performance.now();
    timing.assembleMs += t2 - t1;
    const u = this.displacement;
    if (this.solvedValid) {
      const prev = this.solvedRhs;
      for (let v = 0; v < n; v++) {
        const o = v * 6;
        for (let i = 0; i < 6; i++) {
          const f = rhs[o + i]! - prev[o + i]!;
          if (f !== 0) {
            delta[o + i]! += f;
            this.markDelta(v);
          }
        }
      }
      if (this.deltaNodes.length > 0) {
        this.chol.solveSparse(delta, this.deltaNodes, this.deltaNodes.length);
        for (let i = 0; i < u.length; i++) u[i]! += delta[i]!;
      }
    } else {
      this.chol.solve(rhs, u);
    }
    this.solvedRhs.set(rhs);
    this.solvedValid = true;
    const t3 = performance.now();
    timing.solveMs += t3 - t2;
    let check = this.evaluateAll();
    timing.evaluateMs += performance.now() - t3;

    let mode = update;
    if (check.backward > this.options.residualTol) {
      // One step of iterative refinement with the same factor: u += K⁻¹ (f − K u).
      const t4 = performance.now();
      this.chol.solve(this.residualVec, delta);
      for (let i = 0; i < u.length; i++) u[i]! += delta[i]!;
      const t5 = performance.now();
      timing.solveMs += t5 - t4;
      check = this.evaluateAll();
      timing.evaluateMs += performance.now() - t5;
      if (check.backward > this.options.residualTol) {
        // Still off: the factor has drifted. Rebuild it.
        this.refactor(timing);
        mode = 'refactor';
        const t6 = performance.now();
        this.chol.solve(rhs, u);
        this.solvedValid = true;
        const t7 = performance.now();
        timing.solveMs += t7 - t6;
        check = this.evaluateAll();
        timing.evaluateMs += performance.now() - t7;
      }
    }
    timing.totalMs = performance.now() - t0;
    const factor = { ...this.chol.stats, numericMs: timing.factorMs };
    return {
      broken: [],
      detached: [],
      stable: true,
      timing,
      dof: this.live * 6,
      worst: 0,
      factor,
      mode: 'global',
      region: this.live,
      update: mode,
      downdated,
      spared: 0,
      residual: check.relative,
      backwardError: check.backward,
    };
  }

  /**
   * Re-solve only `region`, holding every live node outside it at its last
   * displacement: K_RR u_R = f_R − K_RB u_B. Loads redistribute mostly
   * nearby, and the full solve that ends every cascade catches the rest.
   */
  private solveLocal(region: Int32Array, transient: readonly NodeLoad[] | null): StepResult {
    const d = this.data;
    const timing = emptyTiming();
    const t0 = performance.now();
    const r = region.length;
    const local = new Map<number, number>();
    region.forEach((v, i) => local.set(v, i));
    const K = new BlockMatrix(r);
    const rhs = new Float64Array(r * 6);
    const loads = StrainSolver.byNode(transient);
    region.forEach((v, i) => this.loadInto(rhs, i * 6, v, loads));
    const u = this.displacement;
    const seen = new Set<number>();
    for (const v of region) {
      for (const c of this.incident[v]!) {
        if (!this.connAlive[c] || seen.has(c)) continue;
        seen.add(c);
        const a = d.connA[c]!;
        const b = d.connB[c]!;
        const la = local.get(a);
        const lb = b >= 0 ? local.get(b) : undefined;
        const kab = this.kab.subarray(c * BB, c * BB + BB);
        if (la !== undefined) K.addDiag(la, this.kaa.subarray(c * BB, c * BB + BB));
        if (lb !== undefined) K.addDiag(lb, this.kbb.subarray(c * BB, c * BB + BB));
        if (la !== undefined && lb !== undefined) {
          K.addOff(la, lb, kab);
        } else if (la !== undefined && b >= 0) {
          // b is held: f_a −= K_ab u_b
          for (let i = 0; i < 6; i++) {
            let s2 = 0;
            for (let k = 0; k < 6; k++) s2 += kab[i * 6 + k]! * u[b * 6 + k]!;
            rhs[la * 6 + i]! -= s2;
          }
        } else if (lb !== undefined) {
          // a is held: f_b −= K_abᵀ u_a
          for (let i = 0; i < 6; i++) {
            let s2 = 0;
            for (let k = 0; k < 6; k++) s2 += kab[k * 6 + i]! * u[a * 6 + k]!;
            rhs[lb * 6 + i]! -= s2;
          }
        }
      }
    }
    timing.assembleMs = performance.now() - t0;
    const chol = BlockCholesky.analyze(K);
    timing.orderMs = chol.stats.orderMs;
    const failed = chol.factor(K);
    timing.factorMs = chol.stats.numericMs;
    if (failed >= 0) throw new Error(`StrainSolver: local stiffness not positive definite at node ${region[failed]}`);
    const t1 = performance.now();
    const x = chol.solve(rhs);
    region.forEach((v, i) => u.set(x.subarray(i * 6, i * 6 + 6), v * 6));
    this.solvedValid = false;
    timing.solveMs = performance.now() - t1;
    const t2 = performance.now();
    for (const c of seen) this.utilization[c] = this.evaluate(c);
    timing.evaluateMs = performance.now() - t2;
    timing.totalMs = performance.now() - t0;
    return { broken: [], detached: [], stable: true, timing, dof: r * 6, worst: 0, factor: { ...chol.stats }, mode: 'local', region: r, update: 'none', downdated: 0, spared: 0, residual: 0, backwardError: 0 };
  }

  /**
   * Utilization of every live connection from the latest displacement, and
   * the solve's residual on the way: each connection's spring force is also
   * what it puts on its two nodes, so f − K u falls out of the same loop
   * (left in `residualVec`). Returns the relative residual ‖f − K u‖ / ‖f‖
   * and the normwise backward error ‖f − K u‖ / (‖ Σ|K_c u| ‖ + ‖f‖), which
   * does not grow with how badly conditioned the structure is.
   */
  private evaluateAll(): { relative: number; backward: number } {
    const d = this.data;
    const u = this.displacement;
    const res = this.residualVec;
    const rhs = this.rhs;
    const sc = this.forceScale;
    const n = d.nodeCount;
    let fNorm = 0;
    sc.fill(0);
    for (let v = 0; v < n; v++) {
      const o = v * 6;
      if (!this.nodeAlive[v]) {
        for (let i = 0; i < 6; i++) res[o + i] = 0;
        continue;
      }
      for (let i = 0; i < 6; i++) {
        fNorm += rhs[o + i]! * rhs[o + i]!;
        res[o + i] = rhs[o + i]!;
      }
    }
    const { center, point, normal, e1, e2, area, i1: I1, i2: I2, polyStart, polyXY, connA, connB } = d;
    const s = this.options.strengths;
    const L = this.klin;
    const R = this.krot;
    for (let c = 0; c < d.connCount; c++) {
      if (!this.connAlive[c]) continue;
      const a = connA[c]!;
      const b = connB[c]!;
      const px = point[c * 3]!;
      const py = point[c * 3 + 1]!;
      const pz = point[c * 3 + 2]!;
      // Relative motion of b against a at the patch: δ = (t + θ × r)_b − (t + θ × r)_a, φ = θ_b − θ_a.
      const oa = a * 6;
      const rax = px - center[a * 3]!;
      const ray = py - center[a * 3 + 1]!;
      const raz = pz - center[a * 3 + 2]!;
      let tx = u[oa + 3]!;
      let ty = u[oa + 4]!;
      let tz = u[oa + 5]!;
      let dx = -(u[oa]! + ty * raz - tz * ray);
      let dy = -(u[oa + 1]! + tz * rax - tx * raz);
      let dz = -(u[oa + 2]! + tx * ray - ty * rax);
      let fx = -tx;
      let fy = -ty;
      let fz = -tz;
      let rbx = 0;
      let rby = 0;
      let rbz = 0;
      if (b >= 0) {
        const ob = b * 6;
        rbx = px - center[b * 3]!;
        rby = py - center[b * 3 + 1]!;
        rbz = pz - center[b * 3 + 2]!;
        tx = u[ob + 3]!;
        ty = u[ob + 4]!;
        tz = u[ob + 5]!;
        dx += u[ob]! + ty * rbz - tz * rby;
        dy += u[ob + 1]! + tz * rbx - tx * rbz;
        dz += u[ob + 2]! + tx * rby - ty * rbx;
        fx += tx;
        fy += ty;
        fz += tz;
      }
      const o9 = c * 9;
      const Fx = L[o9]! * dx + L[o9 + 1]! * dy + L[o9 + 2]! * dz;
      const Fy = L[o9 + 3]! * dx + L[o9 + 4]! * dy + L[o9 + 5]! * dz;
      const Fz = L[o9 + 6]! * dx + L[o9 + 7]! * dy + L[o9 + 8]! * dz;
      const Mx = R[o9]! * fx + R[o9 + 1]! * fy + R[o9 + 2]! * fz;
      const My = R[o9 + 3]! * fx + R[o9 + 4]! * fy + R[o9 + 5]! * fz;
      const Mz = R[o9 + 6]! * fx + R[o9 + 7]! * fy + R[o9 + 8]! * fz;

      // K u, connection by connection: the spring pulls a by (F, r_a × F + M) and b by the opposite.
      const ax = Math.abs(Fx);
      const ay = Math.abs(Fy);
      const az = Math.abs(Fz);
      const qa3 = ray * Fz - raz * Fy + Mx;
      const qa4 = raz * Fx - rax * Fz + My;
      const qa5 = rax * Fy - ray * Fx + Mz;
      res[oa]! += Fx;
      res[oa + 1]! += Fy;
      res[oa + 2]! += Fz;
      res[oa + 3]! += qa3;
      res[oa + 4]! += qa4;
      res[oa + 5]! += qa5;
      sc[oa]! += ax;
      sc[oa + 1]! += ay;
      sc[oa + 2]! += az;
      sc[oa + 3]! += Math.abs(qa3);
      sc[oa + 4]! += Math.abs(qa4);
      sc[oa + 5]! += Math.abs(qa5);
      if (b >= 0) {
        const ob = b * 6;
        const qb3 = rby * Fz - rbz * Fy + Mx;
        const qb4 = rbz * Fx - rbx * Fz + My;
        const qb5 = rbx * Fy - rby * Fx + Mz;
        res[ob]! -= Fx;
        res[ob + 1]! -= Fy;
        res[ob + 2]! -= Fz;
        res[ob + 3]! -= qb3;
        res[ob + 4]! -= qb4;
        res[ob + 5]! -= qb5;
        sc[ob]! += ax;
        sc[ob + 1]! += ay;
        sc[ob + 2]! += az;
        sc[ob + 3]! += Math.abs(qb3);
        sc[ob + 4]! += Math.abs(qb4);
        sc[ob + 5]! += Math.abs(qb5);
      }

      const c3 = c * 3;
      const nx = normal[c3]!;
      const ny = normal[c3 + 1]!;
      const nz = normal[c3 + 2]!;
      const axial = Fx * nx + Fy * ny + Fz * nz; // > 0: b pulls away from a (tension)
      const sx = Fx - axial * nx;
      const sy = Fy - axial * ny;
      const sz = Fz - axial * nz;
      const shear = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const torsion = Mx * nx + My * ny + Mz * nz;
      const m1 = Mx * e1[c3]! + My * e1[c3 + 1]! + Mz * e1[c3 + 2]!;
      const m2 = Mx * e2[c3]! + My * e2[c3 + 1]! + Mz * e2[c3 + 2]!;
      const i1 = Math.max(I1[c]!, 1e-9);
      const i2 = Math.max(I2[c]!, 1e-9);
      const k1 = m1 / i1;
      const k2 = m2 / i2;
      let bend = 0;
      for (let k = polyStart[c]!; k < polyStart[c + 1]!; k++) {
        const x = Math.abs(k1 * polyXY[k * 2 + 1]! - k2 * polyXY[k * 2]!);
        if (x > bend) bend = x;
      }
      const A = area[c]!;
      const axialTerm = axial > 0 ? axial / (A * s.tension) : -axial / (A * s.compression);
      const torsionStress = (Math.abs(torsion) * this.rmax[c]!) / (i1 + i2);
      this.utilization[c] = axialTerm + shear / (A * s.shear) + torsionStress / s.shear + bend / s.bending;
    }
    let rNorm = 0;
    let kNorm = 0;
    for (let i = 0; i < res.length; i++) {
      rNorm += res[i]! * res[i]!;
      kNorm += sc[i]! * sc[i]!;
    }
    rNorm = Math.sqrt(rNorm);
    fNorm = Math.sqrt(fNorm);
    return { relative: fNorm > 0 ? rNorm / fNorm : rNorm, backward: rNorm / (Math.sqrt(kNorm) + fNorm || 1) };
  }

  /** Combined utilization of one connection: Σ (stress / strength) over tension-or-compression, shear + torsion, and bending. */
  private evaluate(c: number): number {
    const l = this.loads(c, this.scratch);
    const A = this.data.area[c]!;
    const s = this.options.strengths;
    const axialTerm = l.axial > 0 ? l.axial / (A * s.tension) : -l.axial / (A * s.compression);
    const shearTerm = l.shear / (A * s.shear) + l.torsionStress / s.shear;
    return axialTerm + shearTerm + l.bendingStress / s.bending;
  }

  private readonly scratch: ConnectionLoads = { axial: 0, shear: 0, torsion: 0, bending: 0, bendingStress: 0, torsionStress: 0 };

  /** Forces and moments the latest solve put through connection `c`. */
  loads(c: number, out: ConnectionLoads = { axial: 0, shear: 0, torsion: 0, bending: 0, bendingStress: 0, torsionStress: 0 }): ConnectionLoads {
    const d = this.data;
    const u = this.displacement;
    const a = d.connA[c]!;
    const b = d.connB[c]!;
    const px = d.point[c * 3]!;
    const py = d.point[c * 3 + 1]!;
    const pz = d.point[c * 3 + 2]!;
    // Relative motion of b against a at the patch: δ = (t + θ × r)_b − (t + θ × r)_a, φ = θ_b − θ_a.
    let dx = 0;
    let dy = 0;
    let dz = 0;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    const side = (node: number, sign: number): void => {
      const o = node * 6;
      const rx = px - d.center[node * 3]!;
      const ry = py - d.center[node * 3 + 1]!;
      const rz = pz - d.center[node * 3 + 2]!;
      const tx = u[o + 3]!;
      const ty = u[o + 4]!;
      const tz = u[o + 5]!;
      dx += sign * (u[o]! + ty * rz - tz * ry);
      dy += sign * (u[o + 1]! + tz * rx - tx * rz);
      dz += sign * (u[o + 2]! + tx * ry - ty * rx);
      fx += sign * tx;
      fy += sign * ty;
      fz += sign * tz;
    };
    side(a, -1);
    if (b >= 0) side(b, 1);

    const L = this.klin;
    const R = this.krot;
    const o9 = c * 9;
    const Fx = L[o9]! * dx + L[o9 + 1]! * dy + L[o9 + 2]! * dz;
    const Fy = L[o9 + 3]! * dx + L[o9 + 4]! * dy + L[o9 + 5]! * dz;
    const Fz = L[o9 + 6]! * dx + L[o9 + 7]! * dy + L[o9 + 8]! * dz;
    const Mx = R[o9]! * fx + R[o9 + 1]! * fy + R[o9 + 2]! * fz;
    const My = R[o9 + 3]! * fx + R[o9 + 4]! * fy + R[o9 + 5]! * fz;
    const Mz = R[o9 + 6]! * fx + R[o9 + 7]! * fy + R[o9 + 8]! * fz;

    const nx = d.normal[c * 3]!;
    const ny = d.normal[c * 3 + 1]!;
    const nz = d.normal[c * 3 + 2]!;
    const axial = Fx * nx + Fy * ny + Fz * nz; // > 0: b pulls away from a (tension)
    const shear = Math.hypot(Fx - axial * nx, Fy - axial * ny, Fz - axial * nz);
    const torsion = Mx * nx + My * ny + Mz * nz;
    const m1 = Mx * d.e1[c * 3]! + My * d.e1[c * 3 + 1]! + Mz * d.e1[c * 3 + 2]!;
    const m2 = Mx * d.e2[c * 3]! + My * d.e2[c * 3 + 1]! + Mz * d.e2[c * 3 + 2]!;

    // Peak bending stress over the patch outline (principal axes, so no product term).
    const i1 = Math.max(d.i1[c]!, 1e-9);
    const i2 = Math.max(d.i2[c]!, 1e-9);
    let bend = 0;
    for (let k = d.polyStart[c]!; k < d.polyStart[c + 1]!; k++) {
      const x = d.polyXY[k * 2]!;
      const y = d.polyXY[k * 2 + 1]!;
      bend = Math.max(bend, Math.abs((m1 * y) / i1 - (m2 * x) / i2));
    }
    out.axial = axial;
    out.shear = shear;
    out.torsion = torsion;
    out.bending = Math.hypot(m1, m2);
    out.bendingStress = bend;
    out.torsionStress = (Math.abs(torsion) * this.rmax[c]!) / (i1 + i2);
    return out;
  }

  /** Element matrices and rank factors of connection `c`, for tests: K_aa, K_ab, K_bb, W_a, W_b (row-major 6×6). */
  element(c: number): { kaa: Float64Array; kab: Float64Array; kbb: Float64Array; wa: Float64Array; wb: Float64Array } {
    const r = (x: Float64Array): Float64Array => x.slice(c * BB, c * BB + BB);
    return { kaa: r(this.kaa), kab: r(this.kab), kbb: r(this.kbb), wa: r(this.wa), wb: r(this.wb) };
  }
}

/** One connection's loads. Axial is positive in tension; the rest are magnitudes. */
export interface ConnectionLoads {
  axial: number;
  shear: number;
  torsion: number;
  /** In-plane moment (N·m). */
  bending: number;
  /** Peak bending stress over the patch (Pa). */
  bendingStress: number;
  /** Peak torsional shear stress (Pa). */
  torsionStress: number;
}
