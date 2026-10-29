import { add, cross, plane, polygonMoments, scale, type P2, type V3 } from './math';

/**
 * What a face of a piece shows. Painted surfaces are the building as authored;
 * `fracture` faces are the cuts between chunks, hidden while intact and raw
 * concrete once a chunk comes away.
 */
export type Surface = 'outer' | 'inner' | 'floor' | 'ceiling' | 'edge' | 'fracture';

export interface Face {
  /** Indices into the piece's vertices, counter-clockwise around `normal`. */
  verts: number[];
  normal: V3;
  surface: Surface;
}

export type PieceKind = 'wall' | 'slab' | 'column';

/** One pre-fractured chunk: a convex polyhedron in world space at rest. */
export interface Piece {
  id: number;
  /** The wall segment, slab or column this chunk was cut from. */
  element: number;
  kind: PieceKind;
  vertices: V3[];
  faces: Face[];
  centroid: V3;
  volume: number;
  mass: number;
  min: V3;
  max: V3;
}

/** A slab's local frame: `u`, `v` span the face, `n = u × v` is the thickness direction. */
export interface Frame {
  origin: V3;
  u: V3;
  v: V3;
}

export interface PrismSpec {
  id: number;
  element: number;
  kind: PieceKind;
  /** CCW cell in the frame's (u, v) coordinates. */
  poly: P2[];
  frame: Frame;
  thickness: number;
  /** The rectangle the cell was cut from, so cuts and authored edges can be told apart. */
  width: number;
  height: number;
  /** Cap at `origin` (normal −n) and cap at `origin + n·thickness` (normal +n). */
  minus: Surface;
  plus: Surface;
  density: number;
}

/** Extrude a 2D fracture cell through its slab. */
export function prism(spec: PrismSpec): Piece {
  const { poly, frame, thickness } = spec;
  const n = cross(frame.u, frame.v);
  const lift = scale(n, thickness);
  const m = poly.length;
  const vertices: V3[] = [];
  for (const [x, y] of poly) vertices.push(plane(frame.origin, frame.u, x, frame.v, y));
  for (let i = 0; i < m; i++) vertices.push(add(vertices[i]!, lift));

  const faces: Face[] = [];
  faces.push({ verts: Array.from({ length: m }, (_, i) => m + i), normal: n, surface: spec.plus });
  faces.push({ verts: Array.from({ length: m }, (_, i) => m - 1 - i), normal: scale(n, -1), surface: spec.minus });
  const eps = 1e-6;
  const onSameBorder = (a: P2, b: P2): boolean =>
    (Math.abs(a[0]) < eps && Math.abs(b[0]) < eps) ||
    (Math.abs(a[0] - spec.width) < eps && Math.abs(b[0] - spec.width) < eps) ||
    (Math.abs(a[1]) < eps && Math.abs(b[1]) < eps) ||
    (Math.abs(a[1] - spec.height) < eps && Math.abs(b[1] - spec.height) < eps);
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const a = poly[i]!;
    const b = poly[j]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    // Outward normal of a CCW edge is its right-hand perpendicular (dy, −dx).
    const outward = add(scale(frame.u, dy / len), scale(frame.v, -dx / len));
    faces.push({ verts: [i, j, j + m, i + m], normal: outward, surface: onSameBorder(a, b) ? 'edge' : 'fracture' });
  }

  const mom = polygonMoments(poly);
  const centroid = add(plane(frame.origin, frame.u, mom.cx, frame.v, mom.cy), scale(lift, 0.5));
  const volume = mom.area * thickness;
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of vertices) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, p[k]!);
      max[k] = Math.max(max[k]!, p[k]!);
    }
  }
  return { id: spec.id, element: spec.element, kind: spec.kind, vertices, faces, centroid, volume, mass: volume * spec.density, min, max };
}
