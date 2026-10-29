/**
 * Sparse direct solver for symmetric positive-definite systems made of 6×6
 * blocks (one block row per chunk: 3 translations + 3 rotations).
 *
 * THE FINALS solves its structures with a sparse direct Cholesky solve
 * because iterative solvers converge badly on tall, stiff stacks (GDC 2024,
 * "Engineering Mayhem"), and updates the factor as connections break rather
 * than refactoring. This is the textbook version of both:
 * - an ordering of the block graph (minimum degree, or geometric nested
 *   dissection), and the symbolic factor read off its elimination tree;
 * - a right-looking numeric factorization with dense 6×6 kernels, into flat
 *   arrays a caller can assemble straight into;
 * - exact low-rank downdates (L Lᵀ − W Wᵀ) with mixed rotations along the
 *   elimination-tree paths, batched so each column is read once per batch.
 *
 * Blocks are row-major 6×6 (36 doubles). Column v of L holds its diagonal
 * block in `diag[36·v ..]` and its off-diagonal blocks L[w][v] in
 * `vals[36·t ..]` for t in `colStart[k] .. colStart[k + 1]`, k = `pos[v]`, with
 * `rowIdx[t] = w` in elimination order. Columns are stored in elimination
 * order, so both passes of a solve stream through memory front to back.
 */

const BS = 6;
const BB = BS * BS;

/** Symmetric block matrix: diagonal blocks plus the upper triangle keyed by `i·n + j` (i < j). */
export class BlockMatrix {
  readonly n: number;
  readonly diag: Float64Array;
  readonly off = new Map<number, Float64Array>();

  constructor(n: number) {
    this.n = n;
    this.diag = new Float64Array(n * BB);
  }

  addDiag(i: number, block: ArrayLike<number>): void {
    const o = i * BB;
    for (let k = 0; k < BB; k++) this.diag[o + k]! += block[k]!;
  }

  /** `A[i][j] += block` (and so `A[j][i] += blockᵀ`). */
  addOff(i: number, j: number, block: ArrayLike<number>): void {
    if (i === j) throw new Error('BlockMatrix.addOff: use addDiag for i === j');
    const transpose = i > j;
    const key = transpose ? j * this.n + i : i * this.n + j;
    let dst = this.off.get(key);
    if (!dst) {
      dst = new Float64Array(BB);
      this.off.set(key, dst);
    }
    if (transpose) {
      for (let r = 0; r < BS; r++) for (let c = 0; c < BS; c++) dst[c * BS + r]! += block[r * BS + c]!;
    } else {
      for (let k = 0; k < BB; k++) dst[k]! += block[k]!;
    }
  }

  /** `y = A x` (for residual checks). */
  multiply(x: Float64Array): Float64Array {
    const y = new Float64Array(this.n * BS);
    for (let i = 0; i < this.n; i++) gemvAdd(this.diag, i * BB, x, i * BS, y, i * BS, 1);
    for (const [key, blk] of this.off) {
      const i = Math.floor(key / this.n);
      const j = key - i * this.n;
      gemvAdd(blk, 0, x, j * BS, y, i * BS, 1);
      gemvTAdd(blk, 0, x, i * BS, y, j * BS, 1);
    }
    return y;
  }
}

// ---- dense 6×6 kernels ---------------------------------------------------------

/** In-place lower Cholesky of the block at `o`. False if not positive definite. */
function chol6(a: Float64Array, o: number): boolean {
  for (let j = 0; j < BS; j++) {
    let d = a[o + j * BS + j]!;
    for (let k = 0; k < j; k++) d -= a[o + j * BS + k]! ** 2;
    if (!(d > 0)) return false;
    const ljj = Math.sqrt(d);
    a[o + j * BS + j] = ljj;
    for (let i = j + 1; i < BS; i++) {
      let s = a[o + i * BS + j]!;
      for (let k = 0; k < j; k++) s -= a[o + i * BS + k]! * a[o + j * BS + k]!;
      a[o + i * BS + j] = s / ljj;
    }
    for (let k = j + 1; k < BS; k++) a[o + j * BS + k] = 0;
  }
  return true;
}

/** `X ← X · L⁻ᵀ` for the block X at `xo`, L lower at `lo`. True if X has any nonzero. */
function trsmRightLT(l: Float64Array, lo: number, x: Float64Array, xo: number): boolean {
  let any = false;
  for (let r = 0; r < BS; r++) {
    const row = xo + r * BS;
    for (let c = 0; c < BS; c++) {
      let s = x[row + c]!;
      for (let k = 0; k < c; k++) s -= x[row + k]! * l[lo + c * BS + k]!;
      s /= l[lo + c * BS + c]!;
      x[row + c] = s;
      if (s !== 0) any = true;
    }
  }
  return any;
}

/** `C −= A · Bᵀ` (the hot loop: one row of A held in registers against each row of B). */
function gemmNTSub(a: Float64Array, ao: number, b: Float64Array, bo: number, c: Float64Array, co: number): void {
  for (let i = 0; i < BS; i++) {
    const ai = ao + i * BS;
    const a0 = a[ai]!;
    const a1 = a[ai + 1]!;
    const a2 = a[ai + 2]!;
    const a3 = a[ai + 3]!;
    const a4 = a[ai + 4]!;
    const a5 = a[ai + 5]!;
    const ci = co + i * BS;
    for (let j = 0; j < BS; j++) {
      const bj = bo + j * BS;
      c[ci + j]! -= a0 * b[bj]! + a1 * b[bj + 1]! + a2 * b[bj + 2]! + a3 * b[bj + 3]! + a4 * b[bj + 4]! + a5 * b[bj + 5]!;
    }
  }
}

/**
 * The right-looking update from one block X1 = L[w1][v] of a column: every
 * later block X2 of the column takes X2·X1ᵀ off its target in column w1.
 * X1 is held in locals for the whole sweep (the factor's hot loop).
 */
function updateFromBlock(vals: Float64Array, o1: number, t1: number, cs: number, ce: number, targets: Int32Array, tk: number, nz: Uint8Array): void {
  const b00 = vals[o1 + 0]!;
  const b01 = vals[o1 + 1]!;
  const b02 = vals[o1 + 2]!;
  const b03 = vals[o1 + 3]!;
  const b04 = vals[o1 + 4]!;
  const b05 = vals[o1 + 5]!;
  const b10 = vals[o1 + 6]!;
  const b11 = vals[o1 + 7]!;
  const b12 = vals[o1 + 8]!;
  const b13 = vals[o1 + 9]!;
  const b14 = vals[o1 + 10]!;
  const b15 = vals[o1 + 11]!;
  const b20 = vals[o1 + 12]!;
  const b21 = vals[o1 + 13]!;
  const b22 = vals[o1 + 14]!;
  const b23 = vals[o1 + 15]!;
  const b24 = vals[o1 + 16]!;
  const b25 = vals[o1 + 17]!;
  const b30 = vals[o1 + 18]!;
  const b31 = vals[o1 + 19]!;
  const b32 = vals[o1 + 20]!;
  const b33 = vals[o1 + 21]!;
  const b34 = vals[o1 + 22]!;
  const b35 = vals[o1 + 23]!;
  const b40 = vals[o1 + 24]!;
  const b41 = vals[o1 + 25]!;
  const b42 = vals[o1 + 26]!;
  const b43 = vals[o1 + 27]!;
  const b44 = vals[o1 + 28]!;
  const b45 = vals[o1 + 29]!;
  const b50 = vals[o1 + 30]!;
  const b51 = vals[o1 + 31]!;
  const b52 = vals[o1 + 32]!;
  const b53 = vals[o1 + 33]!;
  const b54 = vals[o1 + 34]!;
  const b55 = vals[o1 + 35]!;
  for (let t2 = t1 + 1; t2 < ce; t2++) {
    const target = targets[tk++]!;
    if (!nz[t2 - cs]) continue;
    const ao = t2 * BB;
    const co = target * BB;
    for (let i = 0; i < BS; i++) {
      const ai = ao + i * BS;
      const a0 = vals[ai]!;
      const a1 = vals[ai + 1]!;
      const a2 = vals[ai + 2]!;
      const a3 = vals[ai + 3]!;
      const a4 = vals[ai + 4]!;
      const a5 = vals[ai + 5]!;
      const ci = co + i * BS;
      vals[ci]! -= a0 * b00 + a1 * b01 + a2 * b02 + a3 * b03 + a4 * b04 + a5 * b05;
      vals[ci + 1]! -= a0 * b10 + a1 * b11 + a2 * b12 + a3 * b13 + a4 * b14 + a5 * b15;
      vals[ci + 2]! -= a0 * b20 + a1 * b21 + a2 * b22 + a3 * b23 + a4 * b24 + a5 * b25;
      vals[ci + 3]! -= a0 * b30 + a1 * b31 + a2 * b32 + a3 * b33 + a4 * b34 + a5 * b35;
      vals[ci + 4]! -= a0 * b40 + a1 * b41 + a2 * b42 + a3 * b43 + a4 * b44 + a5 * b45;
      vals[ci + 5]! -= a0 * b50 + a1 * b51 + a2 * b52 + a3 * b53 + a4 * b54 + a5 * b55;
    }
  }
}

/** `y += s · A x` */
function gemvAdd(a: Float64Array, ao: number, x: Float64Array, xo: number, y: Float64Array, yo: number, s: number): void {
  for (let i = 0; i < BS; i++) {
    let t = 0;
    for (let k = 0; k < BS; k++) t += a[ao + i * BS + k]! * x[xo + k]!;
    y[yo + i]! += s * t;
  }
}

/** `y += s · Aᵀ x` */
function gemvTAdd(a: Float64Array, ao: number, x: Float64Array, xo: number, y: Float64Array, yo: number, s: number): void {
  for (let i = 0; i < BS; i++) {
    let t = 0;
    for (let k = 0; k < BS; k++) t += a[ao + k * BS + i]! * x[xo + k]!;
    y[yo + i]! += s * t;
  }
}

// ---- graphs and orderings --------------------------------------------------------

/** An undirected graph in compressed rows: node v's neighbours are `list[start[v] .. start[v + 1])`. */
interface Graph {
  n: number;
  start: Int32Array;
  list: Int32Array;
}

/** The graph of an edge list, without self-loops or duplicate edges. Negative ends are skipped. */
function graphOf(n: number, ei: ArrayLike<number>, ej: ArrayLike<number>): Graph {
  const m = ei.length;
  const deg = new Int32Array(n);
  for (let e = 0; e < m; e++) {
    const i = ei[e]!;
    const j = ej[e]!;
    if (i === j || i < 0 || j < 0) continue;
    deg[i]!++;
    deg[j]!++;
  }
  const raw = new Int32Array(n + 1);
  for (let v = 0; v < n; v++) raw[v + 1] = raw[v]! + deg[v]!;
  const fill = raw.slice(0, n);
  const rawList = new Int32Array(raw[n]!);
  for (let e = 0; e < m; e++) {
    const i = ei[e]!;
    const j = ej[e]!;
    if (i === j || i < 0 || j < 0) continue;
    rawList[fill[i]!++] = j;
    rawList[fill[j]!++] = i;
  }
  // Drop duplicates (two contacts between the same pair are one edge of the graph).
  const mark = new Int32Array(n).fill(-1);
  const start = new Int32Array(n + 1);
  const list = new Int32Array(raw[n]!);
  let k = 0;
  for (let v = 0; v < n; v++) {
    start[v] = k;
    for (let t = raw[v]!; t < raw[v + 1]!; t++) {
      const w = rawList[t]!;
      if (mark[w] === v) continue;
      mark[w] = v;
      list[k++] = w;
    }
  }
  start[n] = k;
  return { n, start, list: list.subarray(0, k) };
}

/** Binary min-heap of numbers. */
class MinHeap {
  private items: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(v: number): void {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]! <= v) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = v;
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= a.length) break;
        const r = l + 1;
        const c = r < a.length && a[r]! < a[l]! ? r : l;
        if (a[c]! >= last) break;
        a[i] = a[c]!;
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
}

/**
 * Minimum-degree ordering of the subgraph induced by `nodes` (all of `g` when
 * omitted), by explicit elimination: eliminating v joins its neighbours into
 * a clique. Returns the nodes in elimination order.
 */
function minimumDegree(g: Graph, nodes?: ArrayLike<number>): Int32Array {
  const all = nodes === undefined;
  const k = all ? g.n : nodes.length;
  const local = all ? null : new Map<number, number>();
  if (local) for (let i = 0; i < k; i++) local.set(nodes![i]!, i);
  const adj: Array<Set<number>> = Array.from({ length: k }, () => new Set<number>());
  for (let i = 0; i < k; i++) {
    const v = all ? i : nodes[i]!;
    for (let t = g.start[v]!; t < g.start[v + 1]!; t++) {
      const w = g.list[t]!;
      const j = all ? w : local!.get(w);
      if (j !== undefined) adj[i]!.add(j);
    }
  }
  const heap = new MinHeap();
  for (let v = 0; v < k; v++) heap.push(adj[v]!.size * k + v);
  const done = new Uint8Array(k);
  const order = new Int32Array(k);
  let at = 0;
  while (heap.size > 0) {
    const key = heap.pop();
    const v = key % k;
    const degree = (key - v) / k;
    if (done[v] || degree !== adj[v]!.size) continue; // stale entry
    done[v] = 1;
    order[at++] = all ? v : nodes[v]!;
    const nbrs = [...adj[v]!];
    for (const w of nbrs) adj[w]!.delete(v);
    for (let i = 0; i < nbrs.length; i++) {
      const wi = nbrs[i]!;
      const si = adj[wi]!;
      for (let j = i + 1; j < nbrs.length; j++) {
        const wj = nbrs[j]!;
        if (!si.has(wj)) {
          si.add(wj);
          adj[wj]!.add(wi);
        }
      }
    }
    for (const w of nbrs) heap.push(adj[w]!.size * k + w);
    adj[v]!.clear();
  }
  return order;
}

/**
 * Geometric nested dissection: split the nodes by a plane across one axis
 * (the axis and position, near the middle, that cut the fewest nodes), take
 * the nodes on the smaller side of the cut as the separator, order both
 * halves recursively and the separator last. Small parts are ordered by
 * minimum degree.
 */
function nestedDissection(g: Graph, coords: ArrayLike<number>, leaf = 64): Int32Array {
  const n = g.n;
  const order = new Int32Array(n);
  let at = 0;
  const setOf = new Int32Array(n).fill(-1);
  const side = new Uint8Array(n);
  const isSep = new Int32Array(n).fill(-1);
  let setId = 0;

  const part = (nodes: Int32Array): void => {
    if (nodes.length <= leaf) {
      order.set(minimumDegree(g, nodes), at);
      at += nodes.length;
      return;
    }
    const id = setId++;
    for (const v of nodes) setOf[v] = id;
    let best: { sep: number; axis: number; t: number; balance: number } | null = null;
    const keys = new Float64Array(nodes.length);
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < nodes.length; i++) keys[i] = coords[nodes[i]! * 3 + axis]!;
      const sorted = Float64Array.from(keys).sort();
      const span = sorted[sorted.length - 1]! - sorted[0]!;
      if (span <= 0) continue;
      for (let q = 0.3; q <= 0.701; q += 0.025) {
        const t = sorted[Math.floor(q * (sorted.length - 1))]!;
        let left = 0;
        for (let i = 0; i < nodes.length; i++) {
          const s = keys[i]! < t ? 0 : 1;
          side[nodes[i]!] = s;
          if (s === 0) left++;
        }
        const balance = Math.min(left, nodes.length - left) / nodes.length;
        if (balance < 0.2) continue;
        // Boundary nodes on each side of the cut; the smaller boundary is the separator.
        let b0 = 0;
        let b1 = 0;
        for (const v of nodes) {
          for (let e = g.start[v]!; e < g.start[v + 1]!; e++) {
            const w = g.list[e]!;
            if (setOf[w] === id && side[w] !== side[v]) {
              if (side[v] === 0) b0++;
              else b1++;
              break;
            }
          }
        }
        const sep = Math.min(b0, b1);
        if (!best || sep < best.sep || (sep === best.sep && balance > best.balance)) best = { sep, axis, t, balance };
      }
    }
    if (!best) {
      order.set(minimumDegree(g, nodes), at);
      at += nodes.length;
      return;
    }
    const { axis, t } = best;
    for (const v of nodes) side[v] = coords[v * 3 + axis]! < t ? 0 : 1;
    let b0 = 0;
    let b1 = 0;
    for (const v of nodes) {
      for (let e = g.start[v]!; e < g.start[v + 1]!; e++) {
        const w = g.list[e]!;
        if (setOf[w] === id && side[w] !== side[v]) {
          if (side[v] === 0) b0++;
          else b1++;
          break;
        }
      }
    }
    const sepSide = b0 <= b1 ? 0 : 1;
    const sep: number[] = [];
    const lo: number[] = [];
    const hi: number[] = [];
    for (const v of nodes) {
      let boundary = false;
      if (side[v] === sepSide) {
        for (let e = g.start[v]!; e < g.start[v + 1]!; e++) {
          const w = g.list[e]!;
          if (setOf[w] === id && side[w] !== side[v]) {
            boundary = true;
            break;
          }
        }
      }
      if (boundary) {
        sep.push(v);
        isSep[v] = id;
      } else if (side[v] === 0) lo.push(v);
      else hi.push(v);
    }
    part(Int32Array.from(lo));
    part(Int32Array.from(hi));
    // The separator is dense once its halves are eliminated; order it along the cut.
    sep.sort((x, y) => coords[x * 3 + (axis + 1) % 3]! - coords[y * 3 + (axis + 1) % 3]! || x - y);
    for (const v of sep) order[at++] = v;
  };
  const all = new Int32Array(n);
  for (let v = 0; v < n; v++) all[v] = v;
  part(all);
  if (at !== n) throw new Error(`nestedDissection: ordered ${at} of ${n}`);
  return order;
}

// ---- WebAssembly kernels -------------------------------------------------------------

/*
 * The two passes of a solve, as WebAssembly SIMD (f64x2), assembled here
 * from a few dozen instructions. V8 runs the same loops in JS at about 30 ns
 * a 6×6 block whatever the size (bounds checks and spills, not memory), and
 * a solve is a pass or two over every block of the factor. The module is
 * well under the 4 KB a browser compiles synchronously on its main thread.
 * Without WebAssembly, the JS loops run instead.
 */

const I32 = 0x7f;
const F64 = 0x7c;
const V128 = 0x7b;

function uleb(out: number[], n: number): void {
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
}

function sleb(out: number[], n: number): void {
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return;
    }
    out.push(b | 0x80);
  }
}

/** One function body, written as the stack machine runs it. */
class Body {
  readonly b: number[] = [];
  op(...codes: number[]): this {
    this.b.push(...codes);
    return this;
  }
  get(i: number): this {
    this.b.push(0x20);
    uleb(this.b, i);
    return this;
  }
  set(i: number): this {
    this.b.push(0x21);
    uleb(this.b, i);
    return this;
  }
  i32(n: number): this {
    this.b.push(0x41);
    sleb(this.b, n);
    return this;
  }
  private mem(code: readonly number[], align: number, offset: number): this {
    this.b.push(...code, align);
    uleb(this.b, offset);
    return this;
  }
  loadI32(offset = 0): this {
    return this.mem([0x28], 2, offset);
  }
  loadU8(offset = 0): this {
    return this.mem([0x2d], 0, offset);
  }
  loadF64(offset = 0): this {
    return this.mem([0x2b], 3, offset);
  }
  storeF64(offset = 0): this {
    return this.mem([0x39], 3, offset);
  }
  loadV(offset = 0): this {
    return this.mem([0xfd, 0x00], 4, offset);
  }
  storeV(offset = 0): this {
    return this.mem([0xfd, 0x0b], 4, offset);
  }
  /** `local = base + index · scale` */
  addr(local: number, base: number, index: number, scale: number): this {
    return this.get(base).get(index).i32(scale).op(I32_MUL, I32_ADD).set(local);
  }
}

const I32_ADD = 0x6a;
const I32_SUB = 0x6b;
const I32_MUL = 0x6c;
const I32_EQZ = 0x45;
const I32_LT_S = 0x48;
const I32_GE_S = 0x4e;
const F64_SUB = 0xa1;
const F64_MUL = 0xa2;
const F64_DIV = 0xa3;
const BLOCK = [0x02, 0x40];
const LOOP = [0x03, 0x40];
const IF = [0x04, 0x40];
const END = 0x0b;
const BR = 0x0c;
const BR_IF = 0x0d;
const SPLAT = [0xfd, 0x14];
const REPLACE_1 = [0xfd, 0x22, 1];
const EXTRACT_0 = [0xfd, 0x21, 0];
const EXTRACT_1 = [0xfd, 0x21, 1];
const VADD = [0xfd, 0xf0, 0x01];
const VSUB = [0xfd, 0xf1, 0x01];
const VMUL = [0xfd, 0xf2, 0x01];
const VZERO = [0xfd, 0x0c, ...new Array<number>(16).fill(0)];
/** [a.lo, b.lo] and [a.hi, b.hi] of two f64x2. */
const LOS = [0xfd, 0x0d, 0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23];
const HIS = [0xfd, 0x0d, 8, 9, 10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31];

/**
 * forward(order, colStart, rowIdx, vals, diag, out, reach, n): L y = out in
 * place, columns in elimination order, skipping columns not marked in
 * `reach` (a byte per node) when `reach` is not 0. Pointers are byte offsets.
 */
function forwardKernel(): { params: number; locals: Array<[number, number]>; body: number[] } {
  const [order, colStart, rowIdx, vals, diag, out, reach, n] = [0, 1, 2, 3, 4, 5, 6, 7];
  const [k, v, o, lo, t, ce, p, q] = [8, 9, 10, 11, 12, 13, 14, 15];
  const y = [16, 17, 18, 19, 20, 21];
  const [y01, y23, y45, da, db] = [22, 23, 24, 25, 26];
  const f = new Body();
  f.op(...BLOCK, ...LOOP);
  f.get(k).get(n).op(I32_GE_S, BR_IF, 1);
  f.get(order).get(k).i32(4).op(I32_MUL, I32_ADD).loadI32().set(v);
  f.op(...BLOCK);
  f.get(reach).op(...IF).get(reach).get(v).op(I32_ADD).loadU8().op(I32_EQZ, BR_IF, 1, END);
  f.addr(o, out, v, 48).addr(lo, diag, v, 288);
  // The diagonal block: y_i = (b_i − Σ_{j<i} L[i][j] y_j) / L[i][i].
  for (let i = 0; i < 6; i++) {
    f.get(o).loadF64(8 * i);
    for (let j = 0; j < i; j++) f.get(lo).loadF64(8 * (i * 6 + j)).get(y[j]!).op(F64_MUL, F64_SUB);
    f.get(lo).loadF64(8 * i * 7).op(F64_DIV).set(y[i]!);
    f.get(o).get(y[i]!).storeF64(8 * i);
  }
  f.get(y[0]!).op(...SPLAT).get(y[1]!).op(...REPLACE_1).set(y01);
  f.get(y[2]!).op(...SPLAT).get(y[3]!).op(...REPLACE_1).set(y23);
  f.get(y[4]!).op(...SPLAT).get(y[5]!).op(...REPLACE_1).set(y45);
  f.addr(q, colStart, k, 4).get(q).loadI32(0).set(t).get(q).loadI32(4).set(ce);
  f.addr(p, vals, t, 288);
  // The rest of the column: out[row] −= L[row][v] · y, two rows of a block at a time.
  f.op(...BLOCK, ...LOOP);
  f.get(t).get(ce).op(I32_GE_S, BR_IF, 1);
  f.get(rowIdx).get(t).i32(4).op(I32_MUL, I32_ADD).loadI32().i32(48).op(I32_MUL).get(out).op(I32_ADD).set(q);
  for (let r = 0; r < 6; r += 2) {
    for (const [acc, row] of [
      [da, r],
      [db, r + 1],
    ] as const) {
      f.get(p).loadV(48 * row).get(y01).op(...VMUL);
      f.get(p).loadV(48 * row + 16).get(y23).op(...VMUL, ...VADD);
      f.get(p).loadV(48 * row + 32).get(y45).op(...VMUL, ...VADD).set(acc);
    }
    f.get(da).get(db).op(...LOS).get(da).get(db).op(...HIS).op(...VADD).set(da);
    f.get(q).get(q).loadV(8 * r).get(da).op(...VSUB).storeV(8 * r);
  }
  f.get(t).i32(1).op(I32_ADD).set(t);
  f.get(p).i32(288).op(I32_ADD).set(p);
  f.op(BR, 0, END, END);
  f.op(END); // skip
  f.get(k).i32(1).op(I32_ADD).set(k);
  f.op(BR, 0, END, END);
  return {
    params: 8,
    locals: [
      [8, I32],
      [6, F64],
      [5, V128],
    ],
    body: f.b,
  };
}

/** backward(order, colStart, rowIdx, vals, diag, out, n): Lᵀ x = out in place, columns in reverse elimination order. */
function backwardKernel(): { params: number; locals: Array<[number, number]>; body: number[] } {
  const [order, colStart, rowIdx, vals, diag, out, n] = [0, 1, 2, 3, 4, 5, 6];
  const [k, v, o, lo, t, ce, p, q] = [7, 8, 9, 10, 11, 12, 13, 14];
  const s = [15, 16, 17, 18, 19, 20];
  const acc = [
    [21, 22, 23],
    [24, 25, 26],
  ];
  const x = 27;
  const f = new Body();
  f.get(n).i32(1).op(I32_SUB).set(k);
  f.op(...BLOCK, ...LOOP);
  f.get(k).i32(0).op(I32_LT_S, BR_IF, 1);
  f.get(order).get(k).i32(4).op(I32_MUL, I32_ADD).loadI32().set(v);
  f.addr(o, out, v, 48).addr(lo, diag, v, 288);
  for (const set of acc) for (const a of set) f.op(...VZERO).set(a);
  f.addr(q, colStart, k, 4).get(q).loadI32(0).set(t).get(q).loadI32(4).set(ce);
  f.addr(p, vals, t, 288);
  // Σ L[row][v]ᵀ x[row] over the column: each row of a block scales one row of L (two accumulator sets).
  f.op(...BLOCK, ...LOOP);
  f.get(t).get(ce).op(I32_GE_S, BR_IF, 1);
  f.get(rowIdx).get(t).i32(4).op(I32_MUL, I32_ADD).loadI32().i32(48).op(I32_MUL).get(out).op(I32_ADD).set(q);
  for (let r = 0; r < 6; r++) {
    const a = acc[r & 1]!;
    f.get(q).loadF64(8 * r).op(...SPLAT).set(x);
    for (let h = 0; h < 3; h++) f.get(a[h]!).get(p).loadV(48 * r + 16 * h).get(x).op(...VMUL, ...VADD).set(a[h]!);
  }
  f.get(t).i32(1).op(I32_ADD).set(t);
  f.get(p).i32(288).op(I32_ADD).set(p);
  f.op(BR, 0, END, END);
  for (let h = 0; h < 3; h++) f.get(o).get(o).loadV(16 * h).get(acc[0]![h]!).get(acc[1]![h]!).op(...VADD, ...VSUB).storeV(16 * h);
  // The diagonal block: x_i = (s_i − Σ_{j>i} L[j][i] x_j) / L[i][i].
  for (let i = 5; i >= 0; i--) {
    f.get(o).loadF64(8 * i);
    for (let j = i + 1; j < 6; j++) f.get(lo).loadF64(8 * (j * 6 + i)).get(s[j]!).op(F64_MUL, F64_SUB);
    f.get(lo).loadF64(8 * i * 7).op(F64_DIV).set(s[i]!);
    f.get(o).get(s[i]!).storeF64(8 * i);
  }
  f.get(k).i32(1).op(I32_SUB).set(k);
  f.op(BR, 0, END, END);
  return {
    params: 7,
    locals: [
      [8, I32],
      [6, F64],
      [7, V128],
    ],
    body: f.b,
  };
}

/**
 * rotate(vals, rowIdx, uIndex, ws, rot, act, t0, t1, stride, na): a
 * downdate's rotations, already worked out from a column's diagonal block,
 * applied to the column's blocks t0 .. t1. Two rows of a block share every
 * rotation, so they ride in the two lanes. `rot` holds each term's 36
 * rotations as (s, 1/c, c), each splatted to both lanes; `stride` is the
 * workspace's row stride in bytes. See `BlockCholesky.downdate`.
 */
function rotateKernel(): { params: number; locals: Array<[number, number]>; body: number[] } {
  const [vals, rowIdx, uIndex, ws, rot, act, t0, t1, stride, na] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const [t, wu, i, ra, a, rp, oa, ob, j] = [10, 11, 12, 13, 14, 15, 16, 17, 18];
  const W = [19, 20, 21, 22, 23, 24];
  const [L, sv] = [25, 26];
  const f = new Body();
  f.get(t0).set(t);
  f.op(...BLOCK, ...LOOP);
  f.get(t).get(t1).op(I32_GE_S, BR_IF, 1);
  // This block row's workspace: uIndex[rowIdx[t]] · 6 rows · stride.
  f.get(uIndex).get(rowIdx).get(t).i32(4).op(I32_MUL, I32_ADD).loadI32().i32(4).op(I32_MUL, I32_ADD).loadI32();
  f.i32(6).op(I32_MUL).get(stride).op(I32_MUL).get(ws).op(I32_ADD).set(wu);
  f.i32(0).set(i);
  f.op(...BLOCK, ...LOOP);
  f.get(i).i32(6).op(I32_GE_S, BR_IF, 1);
  f.get(vals).get(t).i32(288).op(I32_MUL, I32_ADD).get(i).i32(48).op(I32_MUL, I32_ADD).set(ra);
  f.i32(0).set(a);
  f.op(...BLOCK, ...LOOP);
  f.get(a).get(na).op(I32_GE_S, BR_IF, 1);
  // Term kk = act[a]: its rotations and its two rows of workspace.
  f.get(act).get(a).i32(4).op(I32_MUL, I32_ADD).loadI32().set(rp);
  f.get(wu).get(i).get(stride).op(I32_MUL, I32_ADD).get(rp).i32(48).op(I32_MUL, I32_ADD).set(oa);
  f.get(oa).get(stride).op(I32_ADD).set(ob);
  f.get(rp).i32(108 * 16).op(I32_MUL).get(rot).op(I32_ADD).set(rp);
  for (let q = 0; q < 6; q++) f.get(oa).loadF64(8 * q).op(...SPLAT).get(ob).loadF64(8 * q).op(...REPLACE_1).set(W[q]!);
  f.i32(0).set(j);
  f.op(...BLOCK, ...LOOP);
  f.get(j).i32(48).op(I32_GE_S, BR_IF, 1);
  f.get(ra).get(j).op(I32_ADD).loadF64(0).op(...SPLAT).get(ra).get(j).op(I32_ADD).loadF64(48).op(...REPLACE_1).set(L);
  for (let q = 0; q < 6; q++) {
    // L = (L − s·W) / c ; W = c·W − s·L
    f.get(rp).loadV(48 * q).set(sv);
    f.get(L).get(sv).get(W[q]!).op(...VMUL, ...VSUB).get(rp).loadV(48 * q + 16).op(...VMUL).set(L);
    f.get(rp).loadV(48 * q + 32).get(W[q]!).op(...VMUL).get(sv).get(L).op(...VMUL, ...VSUB).set(W[q]!);
  }
  f.get(ra).get(j).op(I32_ADD).get(L).op(...EXTRACT_0).storeF64(0);
  f.get(ra).get(j).op(I32_ADD).get(L).op(...EXTRACT_1).storeF64(48);
  f.get(rp).i32(18 * 16).op(I32_ADD).set(rp);
  f.get(j).i32(8).op(I32_ADD).set(j);
  f.op(BR, 0, END, END);
  for (let q = 0; q < 6; q++) {
    f.get(oa).get(W[q]!).op(...EXTRACT_0).storeF64(8 * q);
    f.get(ob).get(W[q]!).op(...EXTRACT_1).storeF64(8 * q);
  }
  f.get(a).i32(1).op(I32_ADD).set(a);
  f.op(BR, 0, END, END);
  f.get(i).i32(2).op(I32_ADD).set(i);
  f.op(BR, 0, END, END);
  f.get(t).i32(1).op(I32_ADD).set(t);
  f.op(BR, 0, END, END);
  return {
    params: 10,
    locals: [
      [9, I32],
      [8, V128],
    ],
    body: f.b,
  };
}

/** The module: memory imported as env.mem, the kernels exported. */
function kernelBytes(): Uint8Array<ArrayBuffer> {
  const funcs = [forwardKernel(), backwardKernel(), rotateKernel()];
  const names = ['forward', 'backward', 'rotate'];
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const section = (id: number, body: number[]): void => {
    out.push(id);
    uleb(out, body.length);
    out.push(...body);
  };
  const name = (b: number[], s: string): void => {
    uleb(b, s.length);
    for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
  };
  const types: number[] = [];
  uleb(types, funcs.length);
  for (const fn of funcs) {
    types.push(0x60);
    uleb(types, fn.params);
    for (let i = 0; i < fn.params; i++) types.push(I32);
    types.push(0);
  }
  section(1, types);
  const imports: number[] = [1];
  name(imports, 'env');
  name(imports, 'mem');
  imports.push(0x02, 0x00, 0x00);
  section(2, imports);
  const fnTypes: number[] = [];
  uleb(fnTypes, funcs.length);
  funcs.forEach((_, i) => uleb(fnTypes, i));
  section(3, fnTypes);
  const exports: number[] = [];
  uleb(exports, funcs.length);
  names.forEach((nm, i) => {
    name(exports, nm);
    exports.push(0x00);
    uleb(exports, i);
  });
  section(7, exports);
  const code: number[] = [];
  uleb(code, funcs.length);
  for (const fn of funcs) {
    const entry: number[] = [];
    uleb(entry, fn.locals.length);
    for (const [count, type] of fn.locals) {
      uleb(entry, count);
      entry.push(type);
    }
    entry.push(...fn.body, END);
    uleb(code, entry.length);
    code.push(...entry);
  }
  section(10, code);
  return Uint8Array.from(out);
}

/** Size of the kernels' module in bytes (it has to stay under the 4 KB a browser compiles synchronously on its main thread). */
export function kernelModuleSize(): number {
  return kernelBytes().length;
}

interface Kernels {
  forward(order: number, colStart: number, rowIdx: number, vals: number, diag: number, out: number, reach: number, n: number): void;
  backward(order: number, colStart: number, rowIdx: number, vals: number, diag: number, out: number, n: number): void;
  rotate(vals: number, rowIdx: number, uIndex: number, ws: number, rot: number, act: number, t0: number, t1: number, stride: number, na: number): void;
}

let kernelModule: WebAssembly.Module | null | undefined;

/** The compiled kernels (once per realm), or null where WebAssembly or its SIMD is missing. */
function compiledKernels(): WebAssembly.Module | null {
  if (kernelModule === undefined) {
    try {
      const bytes = kernelBytes();
      kernelModule = typeof WebAssembly !== 'undefined' && WebAssembly.validate(bytes) ? new WebAssembly.Module(bytes) : null;
    } catch {
      kernelModule = null;
    }
  }
  return kernelModule;
}

/** Where the factor keeps its arrays: one WebAssembly memory the kernels and the JS views share, or plain arrays. */
interface Arena {
  order: Int32Array;
  colStart: Int32Array;
  rowIdx: Int32Array;
  vals: Float64Array;
  diag: Float64Array;
  /** Solve scratch, n × 6. */
  x: Float64Array;
  reach: Uint8Array;
  /** Downdate scratch: each node's place on the batch's path, the workspace, the rotations (lane pairs) and the active terms. */
  uIndex: Int32Array;
  ws: Float64Array;
  rot: Float64Array;
  act: Int32Array;
  kernels: Kernels | null;
  /** Byte offsets of each array in the memory (kernels only). */
  at: Record<'order' | 'colStart' | 'rowIdx' | 'vals' | 'diag' | 'x' | 'reach' | 'uIndex' | 'ws' | 'rot' | 'act', number>;
}

function arena(n: number, blocks: number, useKernels: boolean): Arena {
  const wsLength = n * BS * DOWNDATE_BATCH * BS;
  const sizes = {
    order: n * 4,
    colStart: (n + 1) * 4,
    rowIdx: blocks * 4,
    reach: n,
    uIndex: n * 4,
    act: DOWNDATE_BATCH * 4,
    vals: blocks * BB * 8,
    diag: n * BB * 8,
    x: n * BS * 8,
    ws: wsLength * 8,
    rot: DOWNDATE_BATCH * 108 * 16,
  };
  const at = { order: 0, colStart: 0, rowIdx: 0, reach: 0, uIndex: 0, act: 0, vals: 0, diag: 0, x: 0, ws: 0, rot: 0 };
  let bytes = 0;
  for (const key of Object.keys(sizes) as Array<keyof typeof sizes>) {
    at[key] = bytes;
    bytes += Math.ceil(sizes[key] / 16) * 16;
  }
  const mod = useKernels ? compiledKernels() : null;
  if (mod) {
    try {
      const memory = new WebAssembly.Memory({ initial: Math.max(1, Math.ceil(bytes / 65536)) });
      const instance = new WebAssembly.Instance(mod, { env: { mem: memory } });
      const buf = memory.buffer;
      return {
        order: new Int32Array(buf, at.order, n),
        colStart: new Int32Array(buf, at.colStart, n + 1),
        rowIdx: new Int32Array(buf, at.rowIdx, blocks),
        vals: new Float64Array(buf, at.vals, blocks * BB),
        diag: new Float64Array(buf, at.diag, n * BB),
        x: new Float64Array(buf, at.x, n * BS),
        reach: new Uint8Array(buf, at.reach, n),
        uIndex: new Int32Array(buf, at.uIndex, n).fill(-1),
        ws: new Float64Array(buf, at.ws, wsLength),
        rot: new Float64Array(buf, at.rot, DOWNDATE_BATCH * 108 * 2),
        act: new Int32Array(buf, at.act, DOWNDATE_BATCH),
        kernels: instance.exports as unknown as Kernels,
        at,
      };
    } catch {
      // Out of memory for a wasm heap (or no SIMD after all): plain arrays.
    }
  }
  return {
    order: new Int32Array(n),
    colStart: new Int32Array(n + 1),
    rowIdx: new Int32Array(blocks),
    vals: new Float64Array(blocks * BB),
    diag: new Float64Array(n * BB),
    x: new Float64Array(n * BS),
    reach: new Uint8Array(n),
    uIndex: new Int32Array(n).fill(-1),
    ws: new Float64Array(wsLength),
    rot: new Float64Array(0),
    act: new Int32Array(DOWNDATE_BATCH),
    kernels: null,
    at,
  };
}

/**
 * A downdate's rotations at one column's diagonal block: for each active
 * term, column by column and vector by vector, the mixed rotation that takes
 * the vector's entry out of the pivot (kept in `R` as s, 1/c, c), applied to
 * the rest of the block. False if a pivot would turn (numerically)
 * non-positive. See `BlockCholesky.downdate`.
 */
function diagRotations(diag: Float64Array, dv: number, ws: Float64Array, wv: number, stride: number, act: Int32Array, na: number, R: Float64Array): boolean {
  for (let a = 0; a < na; a++) {
    const kk = act[a]!;
    const rp = kk * 108;
    const wk = wv + kk * BS;
    for (let j = 0; j < BS; j++) {
      for (let q = 0; q < BS; q++) {
        const ri = rp + j * 18 + q * 3;
        const x = ws[wk + j * stride + q]!;
        if (x === 0) {
          R[ri] = 0;
          R[ri + 1] = 1;
          R[ri + 2] = 1;
          continue;
        }
        const ljj = diag[dv + j * 7]!;
        const r2 = (ljj - x) * (ljj + x);
        if (!(r2 > 1e-13 * ljj * ljj)) return false;
        const r = Math.sqrt(r2);
        const c = r / ljj;
        const s = x / ljj;
        const ic = ljj / r;
        R[ri] = s;
        R[ri + 1] = ic;
        R[ri + 2] = c;
        diag[dv + j * 7] = r;
        for (let i = j + 1; i < BS; i++) {
          const li = dv + i * BS + j;
          const wi = wk + i * stride + q;
          const xi = ws[wi]!;
          const l2 = (diag[li]! - s * xi) * ic;
          diag[li] = l2;
          ws[wi] = c * xi - s * l2;
        }
      }
    }
  }
  return true;
}

/** A downdate's rotations down the rest of one column (blocks cs .. ce) in JS, two rows at a time; see `BlockCholesky.downdate`. */
function sweepRows(vals: Float64Array, rowIdx: Int32Array, uIndex: Int32Array, ws: Float64Array, stride: number, cs: number, ce: number, act: Int32Array, na: number, R: Float64Array): void {
  for (let t = cs; t < ce; t++) {
    const wu = uIndex[rowIdx[t]!]! * BS * stride;
    for (let i = 0; i < BS; i += 2) {
      const ra = t * BB + i * BS;
      const rb = ra + BS;
      for (let k = 0; k < na; k++) {
        const kk = act[k]!;
        const rp = kk * 108;
        const oa = wu + i * stride + kk * BS;
        const ob = oa + stride;
        let a0 = ws[oa + 0]!;
        let a1 = ws[oa + 1]!;
        let a2 = ws[oa + 2]!;
        let a3 = ws[oa + 3]!;
        let a4 = ws[oa + 4]!;
        let a5 = ws[oa + 5]!;
        let b0 = ws[ob + 0]!;
        let b1 = ws[ob + 1]!;
        let b2 = ws[ob + 2]!;
        let b3 = ws[ob + 3]!;
        let b4 = ws[ob + 4]!;
        let b5 = ws[ob + 5]!;
        let s: number;
        let ic: number;
        let c: number;
        let la = vals[ra]!;
        let lb = vals[rb]!;
        s = R[rp + 0]!;
        ic = R[rp + 1]!;
        c = R[rp + 2]!;
        la = (la - s * a0) * ic;
        a0 = c * a0 - s * la;
        lb = (lb - s * b0) * ic;
        b0 = c * b0 - s * lb;
        s = R[rp + 3]!;
        ic = R[rp + 4]!;
        c = R[rp + 5]!;
        la = (la - s * a1) * ic;
        a1 = c * a1 - s * la;
        lb = (lb - s * b1) * ic;
        b1 = c * b1 - s * lb;
        s = R[rp + 6]!;
        ic = R[rp + 7]!;
        c = R[rp + 8]!;
        la = (la - s * a2) * ic;
        a2 = c * a2 - s * la;
        lb = (lb - s * b2) * ic;
        b2 = c * b2 - s * lb;
        s = R[rp + 9]!;
        ic = R[rp + 10]!;
        c = R[rp + 11]!;
        la = (la - s * a3) * ic;
        a3 = c * a3 - s * la;
        lb = (lb - s * b3) * ic;
        b3 = c * b3 - s * lb;
        s = R[rp + 12]!;
        ic = R[rp + 13]!;
        c = R[rp + 14]!;
        la = (la - s * a4) * ic;
        a4 = c * a4 - s * la;
        lb = (lb - s * b4) * ic;
        b4 = c * b4 - s * lb;
        s = R[rp + 15]!;
        ic = R[rp + 16]!;
        c = R[rp + 17]!;
        la = (la - s * a5) * ic;
        a5 = c * a5 - s * la;
        lb = (lb - s * b5) * ic;
        b5 = c * b5 - s * lb;
        vals[ra] = la;
        vals[rb] = lb;
        la = vals[ra + 1]!;
        lb = vals[rb + 1]!;
        s = R[rp + 18]!;
        ic = R[rp + 19]!;
        c = R[rp + 20]!;
        la = (la - s * a0) * ic;
        a0 = c * a0 - s * la;
        lb = (lb - s * b0) * ic;
        b0 = c * b0 - s * lb;
        s = R[rp + 21]!;
        ic = R[rp + 22]!;
        c = R[rp + 23]!;
        la = (la - s * a1) * ic;
        a1 = c * a1 - s * la;
        lb = (lb - s * b1) * ic;
        b1 = c * b1 - s * lb;
        s = R[rp + 24]!;
        ic = R[rp + 25]!;
        c = R[rp + 26]!;
        la = (la - s * a2) * ic;
        a2 = c * a2 - s * la;
        lb = (lb - s * b2) * ic;
        b2 = c * b2 - s * lb;
        s = R[rp + 27]!;
        ic = R[rp + 28]!;
        c = R[rp + 29]!;
        la = (la - s * a3) * ic;
        a3 = c * a3 - s * la;
        lb = (lb - s * b3) * ic;
        b3 = c * b3 - s * lb;
        s = R[rp + 30]!;
        ic = R[rp + 31]!;
        c = R[rp + 32]!;
        la = (la - s * a4) * ic;
        a4 = c * a4 - s * la;
        lb = (lb - s * b4) * ic;
        b4 = c * b4 - s * lb;
        s = R[rp + 33]!;
        ic = R[rp + 34]!;
        c = R[rp + 35]!;
        la = (la - s * a5) * ic;
        a5 = c * a5 - s * la;
        lb = (lb - s * b5) * ic;
        b5 = c * b5 - s * lb;
        vals[ra + 1] = la;
        vals[rb + 1] = lb;
        la = vals[ra + 2]!;
        lb = vals[rb + 2]!;
        s = R[rp + 36]!;
        ic = R[rp + 37]!;
        c = R[rp + 38]!;
        la = (la - s * a0) * ic;
        a0 = c * a0 - s * la;
        lb = (lb - s * b0) * ic;
        b0 = c * b0 - s * lb;
        s = R[rp + 39]!;
        ic = R[rp + 40]!;
        c = R[rp + 41]!;
        la = (la - s * a1) * ic;
        a1 = c * a1 - s * la;
        lb = (lb - s * b1) * ic;
        b1 = c * b1 - s * lb;
        s = R[rp + 42]!;
        ic = R[rp + 43]!;
        c = R[rp + 44]!;
        la = (la - s * a2) * ic;
        a2 = c * a2 - s * la;
        lb = (lb - s * b2) * ic;
        b2 = c * b2 - s * lb;
        s = R[rp + 45]!;
        ic = R[rp + 46]!;
        c = R[rp + 47]!;
        la = (la - s * a3) * ic;
        a3 = c * a3 - s * la;
        lb = (lb - s * b3) * ic;
        b3 = c * b3 - s * lb;
        s = R[rp + 48]!;
        ic = R[rp + 49]!;
        c = R[rp + 50]!;
        la = (la - s * a4) * ic;
        a4 = c * a4 - s * la;
        lb = (lb - s * b4) * ic;
        b4 = c * b4 - s * lb;
        s = R[rp + 51]!;
        ic = R[rp + 52]!;
        c = R[rp + 53]!;
        la = (la - s * a5) * ic;
        a5 = c * a5 - s * la;
        lb = (lb - s * b5) * ic;
        b5 = c * b5 - s * lb;
        vals[ra + 2] = la;
        vals[rb + 2] = lb;
        la = vals[ra + 3]!;
        lb = vals[rb + 3]!;
        s = R[rp + 54]!;
        ic = R[rp + 55]!;
        c = R[rp + 56]!;
        la = (la - s * a0) * ic;
        a0 = c * a0 - s * la;
        lb = (lb - s * b0) * ic;
        b0 = c * b0 - s * lb;
        s = R[rp + 57]!;
        ic = R[rp + 58]!;
        c = R[rp + 59]!;
        la = (la - s * a1) * ic;
        a1 = c * a1 - s * la;
        lb = (lb - s * b1) * ic;
        b1 = c * b1 - s * lb;
        s = R[rp + 60]!;
        ic = R[rp + 61]!;
        c = R[rp + 62]!;
        la = (la - s * a2) * ic;
        a2 = c * a2 - s * la;
        lb = (lb - s * b2) * ic;
        b2 = c * b2 - s * lb;
        s = R[rp + 63]!;
        ic = R[rp + 64]!;
        c = R[rp + 65]!;
        la = (la - s * a3) * ic;
        a3 = c * a3 - s * la;
        lb = (lb - s * b3) * ic;
        b3 = c * b3 - s * lb;
        s = R[rp + 66]!;
        ic = R[rp + 67]!;
        c = R[rp + 68]!;
        la = (la - s * a4) * ic;
        a4 = c * a4 - s * la;
        lb = (lb - s * b4) * ic;
        b4 = c * b4 - s * lb;
        s = R[rp + 69]!;
        ic = R[rp + 70]!;
        c = R[rp + 71]!;
        la = (la - s * a5) * ic;
        a5 = c * a5 - s * la;
        lb = (lb - s * b5) * ic;
        b5 = c * b5 - s * lb;
        vals[ra + 3] = la;
        vals[rb + 3] = lb;
        la = vals[ra + 4]!;
        lb = vals[rb + 4]!;
        s = R[rp + 72]!;
        ic = R[rp + 73]!;
        c = R[rp + 74]!;
        la = (la - s * a0) * ic;
        a0 = c * a0 - s * la;
        lb = (lb - s * b0) * ic;
        b0 = c * b0 - s * lb;
        s = R[rp + 75]!;
        ic = R[rp + 76]!;
        c = R[rp + 77]!;
        la = (la - s * a1) * ic;
        a1 = c * a1 - s * la;
        lb = (lb - s * b1) * ic;
        b1 = c * b1 - s * lb;
        s = R[rp + 78]!;
        ic = R[rp + 79]!;
        c = R[rp + 80]!;
        la = (la - s * a2) * ic;
        a2 = c * a2 - s * la;
        lb = (lb - s * b2) * ic;
        b2 = c * b2 - s * lb;
        s = R[rp + 81]!;
        ic = R[rp + 82]!;
        c = R[rp + 83]!;
        la = (la - s * a3) * ic;
        a3 = c * a3 - s * la;
        lb = (lb - s * b3) * ic;
        b3 = c * b3 - s * lb;
        s = R[rp + 84]!;
        ic = R[rp + 85]!;
        c = R[rp + 86]!;
        la = (la - s * a4) * ic;
        a4 = c * a4 - s * la;
        lb = (lb - s * b4) * ic;
        b4 = c * b4 - s * lb;
        s = R[rp + 87]!;
        ic = R[rp + 88]!;
        c = R[rp + 89]!;
        la = (la - s * a5) * ic;
        a5 = c * a5 - s * la;
        lb = (lb - s * b5) * ic;
        b5 = c * b5 - s * lb;
        vals[ra + 4] = la;
        vals[rb + 4] = lb;
        la = vals[ra + 5]!;
        lb = vals[rb + 5]!;
        s = R[rp + 90]!;
        ic = R[rp + 91]!;
        c = R[rp + 92]!;
        la = (la - s * a0) * ic;
        a0 = c * a0 - s * la;
        lb = (lb - s * b0) * ic;
        b0 = c * b0 - s * lb;
        s = R[rp + 93]!;
        ic = R[rp + 94]!;
        c = R[rp + 95]!;
        la = (la - s * a1) * ic;
        a1 = c * a1 - s * la;
        lb = (lb - s * b1) * ic;
        b1 = c * b1 - s * lb;
        s = R[rp + 96]!;
        ic = R[rp + 97]!;
        c = R[rp + 98]!;
        la = (la - s * a2) * ic;
        a2 = c * a2 - s * la;
        lb = (lb - s * b2) * ic;
        b2 = c * b2 - s * lb;
        s = R[rp + 99]!;
        ic = R[rp + 100]!;
        c = R[rp + 101]!;
        la = (la - s * a3) * ic;
        a3 = c * a3 - s * la;
        lb = (lb - s * b3) * ic;
        b3 = c * b3 - s * lb;
        s = R[rp + 102]!;
        ic = R[rp + 103]!;
        c = R[rp + 104]!;
        la = (la - s * a4) * ic;
        a4 = c * a4 - s * la;
        lb = (lb - s * b4) * ic;
        b4 = c * b4 - s * lb;
        s = R[rp + 105]!;
        ic = R[rp + 106]!;
        c = R[rp + 107]!;
        la = (la - s * a5) * ic;
        a5 = c * a5 - s * la;
        lb = (lb - s * b5) * ic;
        b5 = c * b5 - s * lb;
        vals[ra + 5] = la;
        vals[rb + 5] = lb;
        ws[oa + 0] = a0;
        ws[oa + 1] = a1;
        ws[oa + 2] = a2;
        ws[oa + 3] = a3;
        ws[oa + 4] = a4;
        ws[oa + 5] = a5;
        ws[ob + 0] = b0;
        ws[ob + 1] = b1;
        ws[ob + 2] = b2;
        ws[ob + 3] = b3;
        ws[ob + 4] = b4;
        ws[ob + 5] = b5;
      }
    }
  }
}

// ---- the factor --------------------------------------------------------------------

export type Ordering = 'mindegree' | 'nested';

export interface AnalyzeOptions {
  /** Minimum degree (the default) or geometric nested dissection (needs `coords`). */
  ordering?: Ordering;
  /** xyz per node, for nested dissection. */
  coords?: ArrayLike<number>;
  /** Nested dissection hands parts this small to minimum degree. */
  leaf?: number;
  /** Solve with the WebAssembly kernels where they run (the default); false keeps everything in JS. */
  kernels?: boolean;
}

export interface FactorStats {
  n: number;
  /** Off-diagonal blocks in L (fill included). */
  lBlocks: number;
  /** Off-diagonal blocks in A. */
  aBlocks: number;
  /** Approximate multiply-adds in the numeric factorization. */
  flops: number;
  orderMs: number;
  numericMs: number;
}

/** Multiply-adds per entry of one rank-1 rotation (two products each way, plus the scaling). */
const ROTATION_COST = 3;
/** Rank-6 terms downdated together: each column on their paths is read once per batch. */
const DOWNDATE_BATCH = 8;

/**
 * The factor of one sparsity pattern. `analyze` once per structure, then
 * `factor` any matrix whose pattern is a subset (chunks removed, connections
 * broken) without re-ordering: the old fill still covers it. Or assemble
 * straight into `diag` and `vals` (after `clear`, with `slot` telling where
 * each off-diagonal block lives) and call `factorize`.
 */
export class BlockCholesky {
  readonly n: number;
  readonly order: Int32Array;
  readonly pos: Int32Array;
  /** Elimination-tree parent of each block column (−1 for a root): the first row of its column. */
  readonly parent: Int32Array;
  readonly colStart: Int32Array;
  readonly rowIdx: Int32Array;
  /** L's off-diagonal blocks (before `factorize`: the lower triangle of A). */
  readonly vals: Float64Array;
  /** L's diagonal blocks (before `factorize`: A's). */
  readonly diag: Float64Array;
  /** Per column v, for each pair s1 < s2 of its rows, the block of rows[s2] in column rows[s1] (the update target). */
  private readonly tStart: Int32Array;
  private readonly targets: Int32Array;
  /** Multiply-adds of one rank-1 downdate starting at each column and running to the root. */
  readonly pathCost: Float64Array;
  readonly stats: FactorStats;
  /** Scratch for downdates and factorization. */
  private readonly uIndex: Int32Array;
  private readonly blockNz: Uint8Array;
  private readonly reach: Uint8Array;
  private readonly mem: Arena;

  private constructor(g: Graph, order: Int32Array, t0: number, kernels: boolean) {
    const n = g.n;
    this.n = n;
    this.order = order;
    this.pos = new Int32Array(n);
    for (let k = 0; k < n; k++) this.pos[order[k]!] = k;
    const pos = this.pos;

    // Symbolic factor: column v's rows are its later neighbours plus its children's rows (less v).
    this.parent = new Int32Array(n).fill(-1);
    const firstChild = new Int32Array(n).fill(-1);
    const nextSibling = new Int32Array(n).fill(-1);
    const mark = new Int32Array(n).fill(-1);
    const cols: Int32Array[] = new Array<Int32Array>(n);
    let total = 0;
    const buf: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = order[k]!;
      buf.length = 0;
      mark[v] = v;
      for (let e = g.start[v]!; e < g.start[v + 1]!; e++) {
        const w = g.list[e]!;
        if (pos[w]! > k && mark[w] !== v) {
          mark[w] = v;
          buf.push(w);
        }
      }
      for (let c = firstChild[v]!; c >= 0; c = nextSibling[c]!) {
        for (const w of cols[c]!) {
          if (w !== v && mark[w] !== v) {
            mark[w] = v;
            buf.push(w);
          }
        }
      }
      const rows = Int32Array.from(buf).sort((a, b) => pos[a]! - pos[b]!);
      cols[v] = rows;
      total += rows.length;
      if (rows.length > 0) {
        const p = rows[0]!;
        this.parent[v] = p;
        nextSibling[v] = firstChild[p]!;
        firstChild[p] = v;
      }
    }
    this.mem = arena(n, total, kernels);
    this.mem.order.set(order);
    this.order = this.mem.order;
    this.colStart = this.mem.colStart;
    this.rowIdx = this.mem.rowIdx;
    let at = 0;
    let maxRows = 0;
    for (let k = 0; k < n; k++) {
      const col = cols[order[k]!]!;
      this.colStart[k] = at;
      this.rowIdx.set(col, at);
      at += col.length;
      maxRows = Math.max(maxRows, col.length);
    }
    this.colStart[n] = at;
    this.vals = this.mem.vals;
    this.diag = this.mem.diag;

    // Resolve every update target once, so the numeric phase is pure array arithmetic.
    this.tStart = new Int32Array(n + 1);
    let tTotal = 0;
    for (let k = 0; k < n; k++) {
      this.tStart[k] = tTotal;
      const s = this.colStart[k + 1]! - this.colStart[k]!;
      tTotal += (s * (s - 1)) / 2;
    }
    this.tStart[n] = tTotal;
    this.targets = new Int32Array(tTotal);
    const where = new Int32Array(n);
    let tk = 0;
    for (let k = 0; k < n; k++) {
      const cs = this.colStart[k]!;
      const ce = this.colStart[k + 1]!;
      for (let t1 = cs; t1 < ce; t1++) {
        const k1 = pos[this.rowIdx[t1]!]!;
        for (let t = this.colStart[k1]!; t < this.colStart[k1 + 1]!; t++) where[this.rowIdx[t]!] = t;
        for (let t2 = t1 + 1; t2 < ce; t2++) this.targets[tk++] = where[this.rowIdx[t2]!]!;
      }
    }

    // Costs: the factor's multiply-adds, and a rank-1 downdate's from each column to the root.
    let flops = BB * n;
    this.pathCost = new Float64Array(n);
    for (let k = n - 1; k >= 0; k--) {
      const v = order[k]!;
      const s = this.colStart[k + 1]! - this.colStart[k]!;
      flops += (s * (s + 1) * BB * BS) / 2 + s * BB * BS;
      const p = this.parent[v]!;
      this.pathCost[v] = ROTATION_COST * (BB * s + 15) + (p >= 0 ? this.pathCost[p]! : 0);
    }
    this.uIndex = this.mem.uIndex;
    this.blockNz = new Uint8Array(maxRows);
    this.reach = this.mem.reach;
    this.stats = { n, lBlocks: total, aBlocks: g.start[n]! / 2, flops, orderMs: performance.now() - t0, numericMs: 0 };
  }

  /** Order A's block graph and read L's pattern off the elimination. */
  static analyze(a: BlockMatrix, options: AnalyzeOptions = {}): BlockCholesky {
    const n = a.n;
    const ei = new Int32Array(a.off.size);
    const ej = new Int32Array(a.off.size);
    let k = 0;
    for (const key of a.off.keys()) {
      const i = Math.floor(key / n);
      ei[k] = i;
      ej[k++] = key - i * n;
    }
    return BlockCholesky.analyzeGraph(n, ei, ej, options);
  }

  /** The same, from the graph's edges (`ei[k]`–`ej[k]`; a negative end is no edge). */
  static analyzeGraph(n: number, ei: ArrayLike<number>, ej: ArrayLike<number>, options: AnalyzeOptions = {}): BlockCholesky {
    const t0 = performance.now();
    const g = graphOf(n, ei, ej);
    const order = options.ordering === 'nested' && options.coords ? nestedDissection(g, options.coords, options.leaf) : minimumDegree(g);
    return new BlockCholesky(g, order, t0, options.kernels ?? true);
  }

  /** Where the block coupling i and j lives in `vals` (in the column of whichever is eliminated first), or −1. */
  slot(i: number, j: number): number {
    const [col, row] = this.pos[i]! < this.pos[j]! ? [i, j] : [j, i];
    const p = this.pos[row]!;
    let lo = this.colStart[this.pos[col]!]!;
    let hi = this.colStart[this.pos[col]! + 1]! - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const q = this.pos[this.rowIdx[mid]!]!;
      if (q === p) return mid;
      if (q < p) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Zero the values, to assemble a new matrix in place. */
  clear(): void {
    this.vals.fill(0);
    this.diag.fill(0);
  }

  /** Numeric factorization of `a`. Returns the first node whose pivot failed, or −1. */
  factor(a: BlockMatrix): number {
    if (a.n !== this.n) throw new Error('BlockCholesky.factor: size mismatch');
    const n = this.n;
    this.diag.set(a.diag);
    this.vals.fill(0);
    for (const [key, blk] of a.off) {
      const i = Math.floor(key / n);
      const j = key - i * n;
      const t = this.slot(i, j);
      if (t < 0) throw new Error(`BlockCholesky.factor: (${i},${j}) outside the analyzed pattern`);
      const o = t * BB;
      // The slot holds L[later][earlier]: A[j][i] = A[i][j]ᵀ when i is eliminated first.
      if (this.pos[i]! < this.pos[j]!) {
        for (let r = 0; r < BS; r++) for (let c = 0; c < BS; c++) this.vals[o + c * BS + r]! += blk[r * BS + c]!;
      } else {
        for (let q = 0; q < BB; q++) this.vals[o + q]! += blk[q]!;
      }
    }
    return this.factorize();
  }

  /** Factor what was assembled into `diag` and `vals`, in place. Returns the first node whose pivot failed, or −1. */
  factorize(): number {
    const t0 = performance.now();
    const { n, order, colStart, rowIdx, vals, diag, targets, tStart, blockNz } = this;
    for (let k = 0; k < n; k++) {
      const v = order[k]!;
      const dv = v * BB;
      if (!chol6(diag, dv)) {
        this.stats.numericMs = performance.now() - t0;
        return v;
      }
      const cs = colStart[k]!;
      const ce = colStart[k + 1]!;
      let any = false;
      for (let t = cs; t < ce; t++) {
        const nz = trsmRightLT(diag, dv, vals, t * BB);
        blockNz[t - cs] = nz ? 1 : 0;
        if (nz) any = true;
      }
      // A column of zeros (a chunk cut off from everything) updates nothing.
      if (!any) continue;
      let tk = tStart[k]!;
      for (let t1 = cs; t1 < ce; t1++) {
        if (!blockNz[t1 - cs]) {
          tk += ce - t1 - 1;
          continue;
        }
        const o1 = t1 * BB;
        gemmNTSub(vals, o1, vals, o1, diag, rowIdx[t1]! * BB);
        updateFromBlock(vals, o1, t1, cs, ce, targets, tk, blockNz);
        tk += ce - t1 - 1;
      }
    }
    this.stats.numericMs = performance.now() - t0;
    return -1;
  }

  /** Solve `A x = b` with the current factor. */
  solve(b: Float64Array, out: Float64Array = new Float64Array(b.length)): Float64Array {
    const { kernels, at, x } = this.mem;
    if (kernels) {
      x.set(b);
      kernels.forward(at.order, at.colStart, at.rowIdx, at.vals, at.diag, at.x, 0, this.n);
      kernels.backward(at.order, at.colStart, at.rowIdx, at.vals, at.diag, at.x, this.n);
      out.set(x);
      return out;
    }
    if (out !== b) out.set(b);
    this.substitute(out, null);
    return out;
  }

  /** Whether solves run in the WebAssembly kernels. */
  get usesKernels(): boolean {
    return this.mem.kernels !== null;
  }

  /**
   * Solve `A x = b` in place for a `b` that is zero outside block rows
   * `nodes[0 .. count)`: the forward pass then only has work on their
   * elimination-tree paths (the rest of L⁻¹b is zero), and only the backward
   * pass runs over the whole factor. Half the memory traffic of `solve` when
   * the change is local.
   */
  solveSparse(b: Float64Array, nodes: ArrayLike<number>, count: number): Float64Array {
    const reach = this.reach;
    const { parent } = this;
    for (let i = 0; i < count; i++) {
      for (let v = nodes[i]!; v >= 0 && !reach[v]; v = parent[v]!) reach[v] = 1;
    }
    const { kernels, at, x } = this.mem;
    if (kernels) {
      x.set(b);
      kernels.forward(at.order, at.colStart, at.rowIdx, at.vals, at.diag, at.x, at.reach, this.n);
      kernels.backward(at.order, at.colStart, at.rowIdx, at.vals, at.diag, at.x, this.n);
      b.set(x);
    } else {
      this.substitute(b, reach);
    }
    reach.fill(0);
    return b;
  }

  /** Forward then backward substitution in place; the forward pass skips columns outside `reach` when given. */
  private substitute(out: Float64Array, reach: Uint8Array | null): void {
    const { n, order, colStart, rowIdx, vals: L } = this;
    const d = this.diag;
    for (let k = 0; k < n; k++) {
      const v = order[k]!;
      if (reach && !reach[v]) continue;
      const o = v * BS;
      const lo = v * BB;
      const y0 = out[o]! / d[lo]!;
      const y1 = (out[o + 1]! - d[lo + 6]! * y0) / d[lo + 7]!;
      const y2 = (out[o + 2]! - d[lo + 12]! * y0 - d[lo + 13]! * y1) / d[lo + 14]!;
      const y3 = (out[o + 3]! - d[lo + 18]! * y0 - d[lo + 19]! * y1 - d[lo + 20]! * y2) / d[lo + 21]!;
      const y4 = (out[o + 4]! - d[lo + 24]! * y0 - d[lo + 25]! * y1 - d[lo + 26]! * y2 - d[lo + 27]! * y3) / d[lo + 28]!;
      const y5 = (out[o + 5]! - d[lo + 30]! * y0 - d[lo + 31]! * y1 - d[lo + 32]! * y2 - d[lo + 33]! * y3 - d[lo + 34]! * y4) / d[lo + 35]!;
      out[o] = y0;
      out[o + 1] = y1;
      out[o + 2] = y2;
      out[o + 3] = y3;
      out[o + 4] = y4;
      out[o + 5] = y5;
      const ce = colStart[k + 1]!;
      for (let t = colStart[k]!; t < ce; t++) {
        const p = t * BB;
        const q = rowIdx[t]! * BS;
        out[q]! -= L[p]! * y0 + L[p + 1]! * y1 + L[p + 2]! * y2 + L[p + 3]! * y3 + L[p + 4]! * y4 + L[p + 5]! * y5;
        out[q + 1]! -= L[p + 6]! * y0 + L[p + 7]! * y1 + L[p + 8]! * y2 + L[p + 9]! * y3 + L[p + 10]! * y4 + L[p + 11]! * y5;
        out[q + 2]! -= L[p + 12]! * y0 + L[p + 13]! * y1 + L[p + 14]! * y2 + L[p + 15]! * y3 + L[p + 16]! * y4 + L[p + 17]! * y5;
        out[q + 3]! -= L[p + 18]! * y0 + L[p + 19]! * y1 + L[p + 20]! * y2 + L[p + 21]! * y3 + L[p + 22]! * y4 + L[p + 23]! * y5;
        out[q + 4]! -= L[p + 24]! * y0 + L[p + 25]! * y1 + L[p + 26]! * y2 + L[p + 27]! * y3 + L[p + 28]! * y4 + L[p + 29]! * y5;
        out[q + 5]! -= L[p + 30]! * y0 + L[p + 31]! * y1 + L[p + 32]! * y2 + L[p + 33]! * y3 + L[p + 34]! * y4 + L[p + 35]! * y5;
      }
    }
    for (let k = n - 1; k >= 0; k--) {
      const v = order[k]!;
      const o = v * BS;
      const lo = v * BB;
      let s0 = out[o]!;
      let s1 = out[o + 1]!;
      let s2 = out[o + 2]!;
      let s3 = out[o + 3]!;
      let s4 = out[o + 4]!;
      let s5 = out[o + 5]!;
      const ce = colStart[k + 1]!;
      for (let t = colStart[k]!; t < ce; t++) {
        const p = t * BB;
        const q = rowIdx[t]! * BS;
        const x0 = out[q]!;
        const x1 = out[q + 1]!;
        const x2 = out[q + 2]!;
        const x3 = out[q + 3]!;
        const x4 = out[q + 4]!;
        const x5 = out[q + 5]!;
        s0 -= L[p]! * x0 + L[p + 6]! * x1 + L[p + 12]! * x2 + L[p + 18]! * x3 + L[p + 24]! * x4 + L[p + 30]! * x5;
        s1 -= L[p + 1]! * x0 + L[p + 7]! * x1 + L[p + 13]! * x2 + L[p + 19]! * x3 + L[p + 25]! * x4 + L[p + 31]! * x5;
        s2 -= L[p + 2]! * x0 + L[p + 8]! * x1 + L[p + 14]! * x2 + L[p + 20]! * x3 + L[p + 26]! * x4 + L[p + 32]! * x5;
        s3 -= L[p + 3]! * x0 + L[p + 9]! * x1 + L[p + 15]! * x2 + L[p + 21]! * x3 + L[p + 27]! * x4 + L[p + 33]! * x5;
        s4 -= L[p + 4]! * x0 + L[p + 10]! * x1 + L[p + 16]! * x2 + L[p + 22]! * x3 + L[p + 28]! * x4 + L[p + 34]! * x5;
        s5 -= L[p + 5]! * x0 + L[p + 11]! * x1 + L[p + 17]! * x2 + L[p + 23]! * x3 + L[p + 29]! * x4 + L[p + 35]! * x5;
      }
      const x5 = s5 / d[lo + 35]!;
      const x4 = (s4 - d[lo + 34]! * x5) / d[lo + 28]!;
      const x3 = (s3 - d[lo + 33]! * x5 - d[lo + 27]! * x4) / d[lo + 21]!;
      const x2 = (s2 - d[lo + 32]! * x5 - d[lo + 26]! * x4 - d[lo + 20]! * x3) / d[lo + 14]!;
      const x1 = (s1 - d[lo + 31]! * x5 - d[lo + 25]! * x4 - d[lo + 19]! * x3 - d[lo + 13]! * x2) / d[lo + 7]!;
      const x0 = (s0 - d[lo + 30]! * x5 - d[lo + 24]! * x4 - d[lo + 18]! * x3 - d[lo + 12]! * x2 - d[lo + 6]! * x1) / d[lo]!;
      out[o] = x0;
      out[o + 1] = x1;
      out[o + 2] = x2;
      out[o + 3] = x3;
      out[o + 4] = x4;
      out[o + 5] = x5;
    }
  }

  /** Multiply-adds `downdate` would spend on a rank-1 vector whose first nonzero block row is `v` (by elimination order). */
  downdateCost(v: number): number {
    return this.pathCost[v]!;
  }

  /**
   * Exact low-rank downdate in place: L Lᵀ ← L Lᵀ − Σ_k W_k W_kᵀ, where each
   * W_k is n×6 (a rank-6 term, such as one contact's stiffness) and nonzero
   * only in block rows `node0[k]` and `node1[k]` (−1: none), with those two
   * 6×6 blocks row-major at `w[72k ..]` and `w[72k + 36 ..]`.
   *
   * Each term runs up the elimination tree from its first nonzero row (a
   * column's rows are all its ancestors, so the path holds every entry it can
   * fill), as six rank-1 downdates by mixed (Chambers) hyperbolic rotations:
   * the factor's entry is updated from the old vector entry and the vector's
   * from the new factor entry, which is what keeps downdating stable. Terms
   * are batched so each column on the union of their paths is read once per
   * batch, and each row of a column takes all 36 rotations of a term in
   * registers.
   *
   * False if a pivot would turn non-positive (the downdated matrix is not
   * safely positive definite): the factor is then part-modified and must be
   * rebuilt.
   */
  downdate(count: number, node0: ArrayLike<number>, node1: ArrayLike<number>, w: ArrayLike<number>): boolean {
    const { pos, parent, colStart, rowIdx, vals, diag, uIndex } = this;
    const { ws, act, rot, kernels, at } = this.mem;
    const path: number[] = [];
    const R = new Float64Array(DOWNDATE_BATCH * 108);
    for (let k0 = 0; k0 < count; k0 += DOWNDATE_BATCH) {
      const g = Math.min(DOWNDATE_BATCH, count - k0);
      // The union of the batch's paths, in elimination order.
      path.length = 0;
      for (let k = k0; k < k0 + g; k++) {
        const a = node0[k]!;
        const b = node1[k]!;
        let v = a < 0 ? b : b < 0 ? a : pos[a]! < pos[b]! ? a : b;
        while (v >= 0 && uIndex[v]! < 0) {
          uIndex[v] = 0;
          path.push(v);
          v = parent[v]!;
        }
      }
      path.sort((x, y) => pos[x]! - pos[y]!);
      const m = path.length;
      for (let i = 0; i < m; i++) uIndex[path[i]!] = i;
      // Workspace: per path node, per row (6), per term in the batch, its six vectors.
      const stride = g * BS;
      ws.fill(0, 0, m * BS * stride);
      for (let kk = 0; kk < g; kk++) {
        const k = k0 + kk;
        for (let e = 0; e < 2; e++) {
          const node = e === 0 ? node0[k]! : node1[k]!;
          if (node < 0) continue;
          const src = k * 72 + e * 36;
          for (let r = 0; r < BS; r++) {
            const o = (uIndex[node]! * BS + r) * stride + kk * BS;
            for (let q = 0; q < BS; q++) ws[o + q] = w[src + r * BS + q]!;
          }
        }
      }

      let ok = true;
      for (let ui = 0; ui < m && ok; ui++) {
        const v = path[ui]!;
        const dv = v * BB;
        const wv = ui * BS * stride;
        // Terms that reach this column: any nonzero in its six rows.
        let na = 0;
        for (let kk = 0; kk < g; kk++) {
          let hit = false;
          for (let r = 0; r < BS && !hit; r++) {
            const o = wv + r * stride + kk * BS;
            for (let q = 0; q < BS; q++) {
              if (ws[o + q] !== 0) {
                hit = true;
                break;
              }
            }
          }
          if (hit) act[na++] = kk;
        }
        if (na === 0) continue;
        if (!diagRotations(diag, dv, ws, wv, stride, act, na, R)) {
          ok = false;
          break;
        }
        // The same rotations down the rest of the column, two rows at a time (they share every rotation).
        const ce = colStart[pos[v]! + 1]!;
        if (kernels) {
          for (let a = 0; a < na; a++) {
            const src = act[a]! * 108;
            const dst = act[a]! * 216;
            for (let e = 0; e < 108; e++) rot[dst + 2 * e] = rot[dst + 2 * e + 1] = R[src + e]!;
          }
          kernels.rotate(at.vals, at.rowIdx, at.uIndex, at.ws, at.rot, at.act, colStart[pos[v]!]!, ce, stride * 8, na);
          continue;
        }
        sweepRows(vals, rowIdx, uIndex, ws, stride, colStart[pos[v]!]!, ce, act, na, R);
      }
      for (const v of path) uIndex[v] = -1;
      if (!ok) return false;
    }
    return true;
  }
}
