import { buildBuilding, fractureRect, prism, rng, type BuildingParams, type Piece, type PieceFrame as Frame, type V3 } from '@spark/engine';

/**
 * The sandbox arena: two buildings a street apart, a fractured footbridge
 * between their second floors with parapets, and the rope anchors for a
 * container slung under the bridge. One piece list (ids 0..n−1, element ids
 * unique across it), so one Strain structure covers everything.
 */
export interface Arena {
  pieces: Piece[];
  /** Which structure each element belongs to (for HUD and demolition helpers). */
  groups: { name: string; first: number; count: number; params?: BuildingParams }[];
  /** Rope anchor points on the bridge's underside, and the bridge chunk each hangs from. */
  ropes: { anchor: V3; piece: number }[];
  /** Where the slung container hangs (its centre) and its half-size. */
  container: { center: V3; half: V3 };
}

export const ARENA_A: Partial<BuildingParams> = { x: -16, z: -4, width: 12, depth: 8, floors: 3, seed: 7 };
export const ARENA_B: Partial<BuildingParams> = { x: 6, z: -5, width: 14, depth: 10, floors: 4, seed: 11 };
/** The tower (on unless `?tower=0`): eight storeys behind the street, for the solver at the size it was scaled for. */
export const TOWER: Partial<BuildingParams> = { x: -4, z: 12, width: 10, depth: 8, floors: 8, seed: 19 };

export function buildArena(options: { tower?: boolean } = {}): Arena {
  const pieces: Piece[] = [];
  const groups: Arena['groups'] = [];
  let elementBase = 0;
  const take = (name: string, list: Piece[], elements: number, params?: BuildingParams): void => {
    const first = pieces.length;
    for (const p of list) {
      p.id = pieces.length;
      p.element += elementBase;
      pieces.push(p);
    }
    elementBase += elements;
    groups.push(params ? { name, first, count: list.length, params } : { name, first, count: list.length });
  };

  const a = buildBuilding(ARENA_A);
  take('A', a.pieces, a.elements, a.params);
  const b = buildBuilding(ARENA_B);
  take('B', b.pieces, b.elements, b.params);

  // ---- the footbridge ------------------------------------------------------------------
  // A slab at second-floor slab level, butting into both buildings' slab edges, with parapets.
  const H = a.params.storeyHeight;
  const x0 = (ARENA_A.x ?? 0) + (ARENA_A.width ?? 0);
  const x1 = ARENA_B.x ?? 0;
  const width = 3;
  const z0 = -width / 2;
  const top = 2 * H;
  const deck = 0.45;
  const random = rng(23);
  const bridge: Piece[] = [];
  let element = 0;
  const panel = (frame: Frame, w: number, h: number, thickness: number, cell: number, kind: Piece['kind']): void => {
    for (const poly of fractureRect(w, h, cell, random)) {
      bridge.push(prism({ id: bridge.length, element, kind, poly, frame, thickness, width: w, height: h, minus: kind === 'slab' ? 'ceiling' : 'outer', plus: kind === 'slab' ? 'floor' : 'outer', density: 2400 }));
    }
    element++;
  };
  // Deck: u along Z, v along X → thickness up (+Y). Its top sits flush with the slab tops.
  panel({ origin: [x0, top - deck, z0], u: [0, 0, 1], v: [1, 0, 0] }, width, x1 - x0, deck, 1.1, 'slab');
  // Parapets on the deck edges, 1 m tall, 0.2 m thick.
  const ph = 1;
  const pt = 0.2;
  panel({ origin: [x0, top, z0], u: [1, 0, 0], v: [0, 1, 0] }, x1 - x0, ph, pt, 0.9, 'wall');
  panel({ origin: [x0, top, -z0 - pt], u: [1, 0, 0], v: [0, 1, 0] }, x1 - x0, ph, pt, 0.9, 'wall');
  take('bridge', bridge, element);

  // ---- the slung container ----------------------------------------------------------------
  const mid = (x0 + x1) / 2;
  const ropes = [-1.4, 1.4].map((dx) => {
    const ax = mid + dx;
    // The deck chunk right above the anchor point.
    let best = -1;
    let bestD = Infinity;
    for (const p of pieces) {
      if (p.kind !== 'slab' || groups.at(-1)!.first > p.id) continue;
      const d = Math.hypot(p.centroid[0] - ax, p.centroid[2]);
      if (d < bestD) {
        bestD = d;
        best = p.id;
      }
    }
    return { anchor: [ax, top - deck, 0] as V3, piece: best };
  });
  const half: V3 = [2.2, 0.75, 0.9];

  // Last, so every id before it is the same with or without it.
  if (options.tower) {
    const t = buildBuilding(TOWER);
    take('T', t.pieces, t.elements, t.params);
  }
  return { pieces, groups, ropes, container: { center: [mid, top - deck - 2.6 - half[1], 0], half } };
}
