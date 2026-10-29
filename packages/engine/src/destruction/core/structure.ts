import { GROUND, type Connection } from './connections';
import type { Piece } from './pieces';

/**
 * The connection graph as flat typed arrays: what the strain solve needs and
 * nothing else, so it can be posted to a worker (or later, a server) as is.
 * Node i is the piece with id i.
 */
export interface StructureData {
  nodeCount: number;
  /** Centroids, xyz per node. */
  center: Float64Array;
  /** kg */
  mass: Float64Array;
  connCount: number;
  connA: Int32Array;
  /** Node, or −1 for the ground. */
  connB: Int32Array;
  point: Float64Array;
  /** From a toward b. */
  normal: Float64Array;
  e1: Float64Array;
  e2: Float64Array;
  area: Float64Array;
  i1: Float64Array;
  i2: Float64Array;
  /** Contact patch outlines in principal coordinates: polyXY[2·polyStart[c] ..]. */
  polyStart: Int32Array;
  polyXY: Float64Array;
}

export function buildStructure(pieces: readonly Piece[], connections: readonly Connection[]): StructureData {
  const n = pieces.length;
  const m = connections.length;
  const center = new Float64Array(n * 3);
  const mass = new Float64Array(n);
  pieces.forEach((p, i) => {
    if (p.id !== i) throw new Error(`buildStructure: piece ids must be 0..n-1 in order (got ${p.id} at ${i})`);
    center.set(p.centroid, i * 3);
    mass[i] = p.mass;
  });
  const connA = new Int32Array(m);
  const connB = new Int32Array(m);
  const point = new Float64Array(m * 3);
  const normal = new Float64Array(m * 3);
  const e1 = new Float64Array(m * 3);
  const e2 = new Float64Array(m * 3);
  const area = new Float64Array(m);
  const i1 = new Float64Array(m);
  const i2 = new Float64Array(m);
  const polyStart = new Int32Array(m + 1);
  let total = 0;
  connections.forEach((c, k) => {
    polyStart[k] = total;
    total += c.poly.length;
  });
  polyStart[m] = total;
  const polyXY = new Float64Array(total * 2);
  connections.forEach((c, k) => {
    connA[k] = c.a;
    connB[k] = c.b === GROUND ? -1 : c.b;
    point.set(c.point, k * 3);
    normal.set(c.normal, k * 3);
    e1.set(c.e1, k * 3);
    e2.set(c.e2, k * 3);
    area[k] = c.area;
    i1[k] = c.i1;
    i2[k] = c.i2;
    c.poly.forEach(([x, y], j) => {
      polyXY[(polyStart[k]! + j) * 2] = x;
      polyXY[(polyStart[k]! + j) * 2 + 1] = y;
    });
  });
  return { nodeCount: n, center, mass, connCount: m, connA, connB, point, normal, e1, e2, area, i1, i2, polyStart, polyXY };
}
