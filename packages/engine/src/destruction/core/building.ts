import { fractureRect } from './fracture';
import { plane, rng, type V3 } from './math';
import { prism, type Frame, type Piece, type PieceKind, type Surface } from './pieces';

/**
 * A procedural test building: storeys of fractured walls with windows and a
 * door, floor slabs resting on the walls, and interior columns. It stands in
 * for THE FINALS' Houdini-authored modules until the Blender pipeline exports
 * real ones.
 */
export interface BuildingParams {
  /** Corner at minimum x/z, standing on y = 0. */
  x: number;
  z: number;
  width: number;
  depth: number;
  floors: number;
  storeyHeight: number;
  wallThickness: number;
  slabThickness: number;
  /** Target chunk size when fracturing walls and slabs. */
  wallCell: number;
  slabCell: number;
  columnSize: number;
  columnSpacing: number;
  bayWidth: number;
  windowWidth: number;
  windowHeight: number;
  sillHeight: number;
  doorWidth: number;
  doorHeight: number;
  /** kg/m³ */
  density: number;
  seed: number;
}

export const DEFAULT_BUILDING: BuildingParams = {
  x: -6,
  z: -4,
  width: 12,
  depth: 8,
  floors: 3,
  storeyHeight: 3.2,
  wallThickness: 0.3,
  slabThickness: 0.25,
  wallCell: 0.8,
  slabCell: 1.4,
  columnSize: 0.45,
  columnSpacing: 4,
  bayWidth: 3,
  windowWidth: 1.3,
  windowHeight: 1.4,
  sillHeight: 0.9,
  doorWidth: 1.4,
  doorHeight: 2.3,
  density: 2400,
  seed: 7,
};

interface Rect {
  u0: number;
  v0: number;
  w: number;
  h: number;
}

/** Piers, sills and lintels around the window (and door) openings of one storey of wall. */
function wallRects(length: number, height: number, p: BuildingParams, door: boolean): Rect[] {
  const bays = Math.max(1, Math.round(length / p.bayWidth));
  const bay = length / bays;
  const doorBay = Math.floor(bays / 2);
  const openings: Array<{ a: number; b: number; v0: number; v1: number }> = [];
  for (let i = 0; i < bays; i++) {
    const isDoor = door && i === doorBay;
    const w = Math.min(isDoor ? p.doorWidth : p.windowWidth, bay - 1.2);
    if (w < 0.5) continue;
    const c = (i + 0.5) * bay;
    const v0 = isDoor ? 0 : p.sillHeight;
    const v1 = Math.min(height - 0.3, isDoor ? p.doorHeight : p.sillHeight + p.windowHeight);
    openings.push({ a: c - w / 2, b: c + w / 2, v0, v1 });
  }
  const rects: Rect[] = [];
  let u = 0;
  for (const o of openings) {
    if (o.a - u > 1e-6) rects.push({ u0: u, v0: 0, w: o.a - u, h: height });
    if (o.v0 > 0.05) rects.push({ u0: o.a, v0: 0, w: o.b - o.a, h: o.v0 });
    if (height - o.v1 > 0.05) rects.push({ u0: o.a, v0: o.v1, w: o.b - o.a, h: height - o.v1 });
    u = o.b;
  }
  if (length - u > 1e-6) rects.push({ u0: u, v0: 0, w: length - u, h: height });
  return rects;
}

export interface Building {
  params: BuildingParams;
  pieces: Piece[];
  elements: number;
}

export function buildBuilding(params: Partial<BuildingParams> = {}, firstId = 0): Building {
  const p: BuildingParams = { ...DEFAULT_BUILDING, ...params };
  const random = rng(p.seed);
  const pieces: Piece[] = [];
  let element = 0;

  const panel = (rect: Rect, frame: Frame, thickness: number, cell: number, kind: PieceKind, minus: Surface, plus: Surface): void => {
    const origin = plane(frame.origin, frame.u, rect.u0, frame.v, rect.v0);
    const local: Frame = { origin, u: frame.u, v: frame.v };
    for (const poly of fractureRect(rect.w, rect.h, cell, random)) {
      pieces.push(
        prism({ id: firstId + pieces.length, element, kind, poly, frame: local, thickness, width: rect.w, height: rect.h, minus, plus, density: p.density }),
      );
    }
    element++;
  };

  const { x: x0, z: z0, width: W, depth: D, storeyHeight: H, wallThickness: t, slabThickness: s } = p;
  const wallHeight = H - s;
  const X: V3 = [1, 0, 0];
  const Y: V3 = [0, 1, 0];
  const Z: V3 = [0, 0, 1];
  const negZ: V3 = [0, 0, -1];

  for (let f = 0; f < p.floors; f++) {
    const yb = f * H;
    // Front and back walls run the full width; the side walls fit between them.
    const walls: Array<{ frame: Frame; length: number; minus: Surface; plus: Surface; door: boolean }> = [
      { frame: { origin: [x0, yb, z0], u: X, v: Y }, length: W, minus: 'outer', plus: 'inner', door: f === 0 },
      { frame: { origin: [x0, yb, z0 + D - t], u: X, v: Y }, length: W, minus: 'inner', plus: 'outer', door: false },
      { frame: { origin: [x0 + t, yb, z0 + t], u: Z, v: Y }, length: D - 2 * t, minus: 'inner', plus: 'outer', door: false },
      { frame: { origin: [x0 + W - t, yb, z0 + D - t], u: negZ, v: Y }, length: D - 2 * t, minus: 'inner', plus: 'outer', door: false },
    ];
    for (const wall of walls) {
      for (const rect of wallRects(wall.length, wallHeight, p, wall.door)) {
        panel(rect, wall.frame, t, p.wallCell, 'wall', wall.minus, wall.plus);
      }
    }

    // Interior columns on a grid, one fractured pillar per storey.
    const ncx = Math.max(1, Math.round(W / p.columnSpacing));
    const ncz = Math.max(1, Math.round(D / p.columnSpacing));
    for (let i = 1; i < ncx; i++) {
      for (let k = 1; k < ncz; k++) {
        const cx = x0 + (W * i) / ncx;
        const cz = z0 + (D * k) / ncz;
        const c = p.columnSize;
        const frame: Frame = { origin: [cx - c / 2, yb, cz - c / 2], u: X, v: Y };
        panel({ u0: 0, v0: 0, w: c, h: wallHeight }, frame, c, wallHeight / 2, 'column', 'inner', 'inner');
      }
    }

    // The slab above this storey rests on its walls and columns.
    const slabFrame: Frame = { origin: [x0, (f + 1) * H - s, z0], u: Z, v: X };
    panel({ u0: 0, v0: 0, w: D, h: W }, slabFrame, s, p.slabCell, 'slab', 'ceiling', 'floor');
  }

  return { params: p, pieces, elements: element };
}
