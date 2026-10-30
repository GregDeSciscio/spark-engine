import { findConnections, type Connection } from './connections';
import { fractureRect } from './fracture';
import { rng, type V3 } from './math';
import { prism, type Piece, type PieceKind, type Surface } from './pieces';

/**
 * One authored box of a structure (ADR-008: a Blender object with
 * `spark.type = destructible`): a wall panel, a slab or a column, placed and
 * turned any way. Its thinnest axis is its thickness; the face across the
 * other two is fractured into Voronoi cells and extruded through it, as the
 * procedural builder does with its panels.
 */
export interface PieceBox {
  /** World centre. */
  readonly center: V3;
  /** World rotation, xyzw. */
  readonly quaternion: readonly [number, number, number, number];
  /** Half extents along the box's own axes, scale applied. */
  readonly halfExtents: V3;
  readonly kind: PieceKind;
  /** Target chunk size (m). Default: walls 0.8, slabs 1.4, columns half their length. */
  readonly cell?: number | undefined;
  /** kg/m³. Default 2400 (concrete). */
  readonly density?: number | undefined;
}

export interface AuthoredOptions {
  /** Seeds the fracture: the same boxes and seed give the same chunks. Default 1. */
  seed?: number | undefined;
  /** Where the ground is: faces resting there are glued to it. Default: the lowest point of any box. */
  groundY?: number | undefined;
  /**
   * How far apart (m) two faces may be and still be glued. Default 0.002: snapped geometry from
   * Blender meets to float precision.
   */
  eps?: number | undefined;
}

/** v rotated by the unit quaternion q. */
function rotate(q: readonly [number, number, number, number], v: V3): V3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 q.xyz × v; v' = v + w t + q.xyz × t
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Fracture authored boxes into a structure's chunks, ids `firstId..`, one element per box. */
export function fractureBoxes(boxes: readonly PieceBox[], options: AuthoredOptions = {}, firstId = 0): Piece[] {
  const random = rng(options.seed ?? 1);
  const pieces: Piece[] = [];
  boxes.forEach((box, element) => {
    const axes: V3[] = [rotate(box.quaternion, [1, 0, 0]), rotate(box.quaternion, [0, 1, 0]), rotate(box.quaternion, [0, 0, 1])];
    const half = box.halfExtents;
    // The thinnest axis is the thickness; of the other two, the more vertical one runs up the face.
    const k = half[0] <= half[1] && half[0] <= half[2] ? 0 : half[1] <= half[2] ? 1 : 2;
    let [i, j] = [0, 1, 2].filter((a) => a !== k) as [number, number];
    if (Math.abs(axes[i]![1]) > Math.abs(axes[j]![1])) [i, j] = [j, i];
    let u = axes[i]!;
    let v = axes[j]!;
    let w = 2 * half[i]!;
    let h = 2 * half[j]!;
    // A right-handed frame, so the prism's faces point out (n = u × v).
    if (dot(cross(u, v), axes[k]!) < 0) [u, v, w, h] = [v, u, h, w];
    const n = cross(u, v);
    const t = 2 * half[k]!;
    const c = box.center;
    const origin: V3 = [c[0] - (u[0] * w + v[0] * h + n[0] * t) / 2, c[1] - (u[1] * w + v[1] * h + n[1] * t) / 2, c[2] - (u[2] * w + v[2] * h + n[2] * t) / 2];
    const cell = box.cell ?? (box.kind === 'slab' ? 1.4 : box.kind === 'column' ? Math.max(w, h) / 2 : 0.8);
    // A slab's caps are a ceiling below and a floor above; walls and columns show their outer face both ways.
    let minus: Surface = box.kind === 'column' ? 'inner' : 'outer';
    let plus: Surface = minus;
    if (box.kind === 'slab') [minus, plus] = n[1] >= 0 ? ['ceiling', 'floor'] : ['floor', 'ceiling'];
    for (const poly of fractureRect(w, h, cell, random)) {
      pieces.push(prism({ id: firstId + pieces.length, element, kind: box.kind, poly, frame: { origin, u, v }, thickness: t, width: w, height: h, minus, plus, density: box.density ?? 2400 }));
    }
  });
  return pieces;
}

/** Authored boxes as a structure for `new Destruction(ctx, structure)`: their chunks, and the glue between them and to the ground. */
export function authoredStructure(boxes: readonly PieceBox[], options: AuthoredOptions = {}): { pieces: Piece[]; connections: Connection[] } {
  const pieces = fractureBoxes(boxes, options);
  const groundY = options.groundY ?? Math.min(...pieces.map((p) => p.min[1]));
  return { pieces, connections: findConnections(pieces, { groundY, eps: options.eps ?? 0.002 }) };
}
