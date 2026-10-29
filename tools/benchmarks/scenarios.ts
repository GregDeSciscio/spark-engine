import { buildBuilding, type BuildingParams } from '../../packages/engine/src/destruction/core/building';
import { findConnections } from '../../packages/engine/src/destruction/core/connections';
import type { Piece } from '../../packages/engine/src/destruction/core/pieces';
import type { BlockCholesky } from '../../packages/engine/src/destruction/core/sparse';
import { StrainSolver, type StrainOptions } from '../../packages/engine/src/destruction/core/strain';
import { buildStructure, type StructureData } from '../../packages/engine/src/destruction/core/structure';

/** Shared by the benches: buildings, damage scenarios, and a look inside the solver. */

export interface Size {
  name: string;
  params: Partial<BuildingParams>;
}

export const SIZES: Size[] = [
  { name: '3 storeys 12×8 m', params: {} },
  { name: '5 storeys 20×12 m', params: { floors: 5, width: 20, depth: 12, x: -10, z: -6 } },
  { name: '8 storeys 24×16 m', params: { floors: 8, width: 24, depth: 16, x: -12, z: -8 } },
  { name: '12 storeys 24×16 m', params: { floors: 12, width: 24, depth: 16, x: -12, z: -8 } },
];

export interface Built {
  pieces: Piece[];
  params: BuildingParams;
  data: StructureData;
  buildMs: number;
}

export function build(size: Size): Built {
  const t0 = performance.now();
  const { pieces, params } = buildBuilding(size.params);
  const data = buildStructure(pieces, findConnections(pieces));
  return { pieces, params, data, buildMs: performance.now() - t0 };
}

export interface Scenario {
  name: string;
  what: string;
  doomed(b: Built): number[];
}

const near = (pieces: Piece[], c: readonly number[], r: number): number[] =>
  pieces.filter((p) => Math.hypot(p.centroid[0] - c[0]!, p.centroid[1] - c[1]!, p.centroid[2] - c[2]!) < r).map((p) => p.id);

export const SCENARIOS: Scenario[] = [
  {
    name: 'wall',
    what: "most of one long wall's ground storey",
    doomed: ({ pieces, params }) => pieces.filter((p) => p.min[1] < 0.01 && p.kind === 'wall' && p.centroid[2] < params.z + 0.5 && p.centroid[0] > params.x + 2).map((p) => p.id),
  },
  {
    name: 'rocket',
    what: 'a 1.6 m hole in a third-storey wall',
    doomed: ({ pieces, params }) => near(pieces, [params.x + params.width / 2, 2 * params.storeyHeight + 1.4, params.z], 1.6),
  },
  {
    name: 'half',
    what: 'the ground-storey supports under 45% of the building (it tears away from the rest, step by step)',
    doomed: ({ pieces, params }) => pieces.filter((p) => p.min[1] < 0.01 && p.kind !== 'slab' && p.centroid[0] < params.x + params.width * 0.45).map((p) => p.id),
  },
  {
    name: 'heavy',
    what: 'every ground-storey support but one corner (the building comes down)',
    doomed: ({ pieces, params }) =>
      pieces.filter((p) => p.min[1] < 0.01 && p.kind !== 'slab' && !(p.centroid[0] < params.x + 1 && p.centroid[2] < params.z + 1)).map((p) => p.id),
  },
];

/** The solver's insides, for timing its phases on their own. */
export interface Insides {
  chol: BlockCholesky;
  downdatesSinceRefactor: number;
  topologyDirty: boolean;
  evaluateAll(): { relative: number; backward: number };
  detachIslands(): number[][];
  element(c: number): { wa: Float64Array; wb: Float64Array };
}

export const insides = (s: StrainSolver): Insides => s as unknown as Insides;

export function solver(data: StructureData, options: Partial<StrainOptions> = {}): StrainSolver {
  const s = new StrainSolver(data, options);
  s.init();
  return s;
}

/** Median and other order statistics. */
export function stats(xs: readonly number[]): { median: number; p95: number; max: number; mean: number } {
  if (xs.length === 0) return { median: 0, p95: 0, max: 0, mean: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!;
  return { median: at(0.5), p95: at(0.95), max: s[s.length - 1]!, mean: s.reduce((a, b) => a + b, 0) / s.length };
}

/** Median of `runs` timings of `fn` (each returns its own ms). */
export function median(runs: number, fn: () => number): number {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) xs.push(fn());
  return stats(xs).median;
}

/** Counts of values in buckets, e.g. `0:3 1–2:5 3–8:7`. */
export function histogram(values: readonly number[], edges: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < edges.length; i++) {
    const lo = edges[i]!;
    const hi = i + 1 < edges.length ? edges[i + 1]! - 1 : Infinity;
    const n = values.filter((v) => v >= lo && v <= hi).length;
    if (n === 0) continue;
    const label = hi === lo ? `${lo}` : hi === Infinity ? `≥${lo}` : `${lo}–${hi}`;
    parts.push(`${label}: ${n}`);
  }
  return parts.join(', ') || '–';
}

/** The elimination tree's dense top: the chain from the root down to the first branching, and its share of the factor. */
export function denseTop(chol: BlockCholesky): { columns: number; maxRows: number; share: number } {
  const n = chol.n;
  const kids = new Int32Array(n);
  const onlyChild = new Int32Array(n).fill(-1);
  for (let v = 0; v < n; v++) {
    const p = chol.parent[v]!;
    if (p >= 0) {
      kids[p]!++;
      onlyChild[p] = v;
    }
  }
  const rows = (v: number): number => chol.colStart[chol.pos[v]! + 1]! - chol.colStart[chol.pos[v]!]!;
  const colFlops = (v: number): number => {
    const s = rows(v);
    return (s * (s + 1) * 216) / 2 + s * 216;
  };
  let maxRows = 0;
  for (let v = 0; v < n; v++) maxRows = Math.max(maxRows, rows(v));
  let columns = 0;
  let flops = 0;
  for (let v = chol.order[n - 1]!; v >= 0; v = kids[v] === 1 ? onlyChild[v]! : -1) {
    columns++;
    flops += colFlops(v);
  }
  return { columns, maxRows, share: flops / chol.stats.flops };
}

/** Multiply-adds of a rank-6 downdate of each contact (from its first endpoint in elimination order to the root). */
export function contactDowndateCosts(chol: BlockCholesky, data: StructureData): number[] {
  const out: number[] = [];
  for (let c = 0; c < data.connCount; c++) {
    const a = data.connA[c]!;
    const b = data.connB[c]!;
    out.push(6 * chol.downdateCost(b < 0 || chol.pos[a]! < chol.pos[b]! ? a : b));
  }
  return out;
}
