import { add, basisFor, clipConvex, dot, polygonArea, polygonMoments, scale, sub, type P2, type V3 } from './math';
import type { Face, Piece } from './pieces';

/** `Connection.b` for a chunk resting on the ground. */
export const GROUND = -1;

/**
 * A glued contact between two chunks (or a chunk and the ground): the edge of
 * THE FINALS' connection graph. The contact patch is kept so the strain solve
 * can turn forces into stresses.
 */
export interface Connection {
  id: number;
  a: number;
  /** Piece id, or `GROUND`. */
  b: number;
  /** Centroid of the contact patch. */
  point: V3;
  /** Unit normal from `a` toward `b`. */
  normal: V3;
  area: number;
  /** Principal axes of the patch (in its plane) and its second moments about them. */
  e1: V3;
  e2: V3;
  /** ∫y² dA: resists rotation about `e1`. */
  i1: number;
  /** ∫x² dA: resists rotation about `e2`. */
  i2: number;
  /** The patch in (e1, e2) coordinates about its centroid. */
  poly: P2[];
}

export interface ConnectionOptions {
  /** Faces this close (m) and this parallel count as touching. */
  eps?: number;
  /** Ignore slivers smaller than this (m²). */
  minArea?: number;
  groundY?: number;
}

function facePolygon(piece: Piece, face: Face, origin: V3, e1: V3, e2: V3, reverse: boolean): P2[] {
  const pts = face.verts.map((i): P2 => {
    const d = sub(piece.vertices[i]!, origin);
    return [dot(d, e1), dot(d, e2)];
  });
  return reverse ? pts.reverse() : pts;
}

/** Build a connection from a contact polygon given in the (e1, e2) plane basis at `origin`. */
function makeConnection(id: number, a: number, b: number, normal: V3, origin: V3, e1: V3, e2: V3, poly: P2[]): Connection {
  const m = polygonMoments(poly);
  const center = add(origin, add(scale(e1, m.cx), scale(e2, m.cy)));
  // Rotate the in-plane axes onto the principal axes so the product moment vanishes.
  const theta = 0.5 * Math.atan2(-2 * m.ixy, m.ixx - m.iyy);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const p1 = add(scale(e1, c), scale(e2, s));
  const p2 = add(scale(e1, -s), scale(e2, c));
  const local = poly.map(([x, y]): P2 => {
    const dx = x - m.cx;
    const dy = y - m.cy;
    return [dx * c + dy * s, -dx * s + dy * c];
  });
  const pm = polygonMoments(local);
  return { id, a, b, point: center, normal, area: m.area, e1: p1, e2: p2, i1: pm.ixx, i2: pm.iyy, poly: local };
}

/**
 * Find every glued contact: coplanar, opposing faces of neighbouring chunks
 * whose overlap has real area, plus downward faces resting on the ground.
 * THE FINALS generates these offline per module; here it runs at load.
 */
export function findConnections(pieces: readonly Piece[], options: ConnectionOptions = {}): Connection[] {
  const eps = options.eps ?? 1e-3;
  const minArea = options.minArea ?? 0.04;
  const groundY = options.groundY ?? 0;
  const out: Connection[] = [];

  // Broadphase: hash AABBs into a coarse grid.
  const cell = 2;
  const grid = new Map<string, number[]>();
  pieces.forEach((p, idx) => {
    const lo = p.min.map((v) => Math.floor((v - eps) / cell));
    const hi = p.max.map((v) => Math.floor((v + eps) / cell));
    for (let x = lo[0]!; x <= hi[0]!; x++)
      for (let y = lo[1]!; y <= hi[1]!; y++)
        for (let z = lo[2]!; z <= hi[2]!; z++) {
          const key = `${x},${y},${z}`;
          const list = grid.get(key);
          if (list) list.push(idx);
          else grid.set(key, [idx]);
        }
  });
  const seen = new Set<number>();
  const n = pieces.length;
  const overlaps = (a: Piece, b: Piece): boolean =>
    a.min[0] <= b.max[0] + eps && b.min[0] <= a.max[0] + eps &&
    a.min[1] <= b.max[1] + eps && b.min[1] <= a.max[1] + eps &&
    a.min[2] <= b.max[2] + eps && b.min[2] <= a.max[2] + eps;

  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const ia = Math.min(list[i]!, list[j]!);
        const ib = Math.max(list[i]!, list[j]!);
        const key = ia * n + ib;
        if (seen.has(key)) continue;
        seen.add(key);
        const A = pieces[ia]!;
        const B = pieces[ib]!;
        if (!overlaps(A, B)) continue;
        // Convex chunks share at most one plane, so the first real patch is the contact.
        found: for (const fa of A.faces) {
          for (const fb of B.faces) {
            if (dot(fa.normal, fb.normal) > -0.999) continue;
            const origin = A.vertices[fa.verts[0]!]!;
            if (Math.abs(dot(fa.normal, sub(B.vertices[fb.verts[0]!]!, origin))) > eps) continue;
            const [e1, e2] = basisFor(fa.normal);
            const polyA = facePolygon(A, fa, origin, e1, e2, false);
            const polyB = facePolygon(B, fb, origin, e1, e2, true); // B's face winds the other way
            const patch = clipConvex(polyA, polyB);
            if (patch.length < 3 || polygonArea(patch) < minArea) continue;
            out.push(makeConnection(out.length, A.id, B.id, fa.normal, origin, e1, e2, patch));
            break found;
          }
        }
      }
    }
  }

  for (const piece of pieces) {
    for (const face of piece.faces) {
      if (face.normal[1] > -0.999) continue;
      if (!face.verts.every((i) => Math.abs(piece.vertices[i]![1] - groundY) < eps)) continue;
      const origin = piece.vertices[face.verts[0]!]!;
      const [e1, e2] = basisFor(face.normal);
      const poly = facePolygon(piece, face, origin, e1, e2, false);
      if (polygonArea(poly) < minArea) continue;
      out.push(makeConnection(out.length, piece.id, GROUND, face.normal, origin, e1, e2, poly));
    }
  }
  return out;
}
