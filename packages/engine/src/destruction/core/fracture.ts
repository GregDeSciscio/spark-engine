import { clipHalfPlane, cleanPolygon, polygonArea, type P2 } from './math';

/**
 * Voronoi-fracture the rectangle [0,w]×[0,h] into convex cells. Seeds sit on a
 * jittered grid of roughly `cellSize`, so chunk sizes stay even (THE FINALS
 * authors this in Houdini; a 2D fracture extruded through a slab is enough for
 * walls and floors). Same `random` stream, same cells.
 */
export function fractureRect(w: number, h: number, cellSize: number, random: () => number, jitter = 0.8): P2[][] {
  const nx = Math.max(1, Math.round(w / cellSize));
  const ny = Math.max(1, Math.round(h / cellSize));
  const rect: P2[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  if (nx * ny === 1) return [rect];

  const sx = w / nx;
  const sy = h / ny;
  const seeds: P2[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      seeds.push([(i + 0.5 + (random() - 0.5) * jitter) * sx, (j + 0.5 + (random() - 0.5) * jitter) * sy]);
    }
  }

  const cells: P2[][] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const s = seeds[j * nx + i]!;
      let poly: P2[] = rect;
      // With jitter < 1 a seed's Voronoi neighbours are within two grid cells.
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          if (di === 0 && dj === 0) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const o = seeds[jj * nx + ii]!;
          // Points closer to s than to o: (o - s)·p <= (|o|² - |s|²) / 2.
          const ex = o[0] - s[0];
          const ey = o[1] - s[1];
          poly = clipHalfPlane(poly, ex, ey, (o[0] * o[0] + o[1] * o[1] - s[0] * s[0] - s[1] * s[1]) / 2);
          if (poly.length < 3) break;
        }
      }
      poly = cleanPolygon(poly);
      if (poly.length >= 3 && polygonArea(poly) > 1e-6) cells.push(poly);
    }
  }
  return cells;
}
