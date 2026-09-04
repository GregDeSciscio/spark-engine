/**
 * Accumulates triangle soup (flat positions and indices) for a navmesh bake.
 * Levels push their collision geometry here; procedural scenes push boxes.
 */
export class TriangleSoup {
  readonly positions: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  /** Append an indexed mesh. `positions` is flat xyz in world space. */
  add(positions: ArrayLike<number>, indices: ArrayLike<number>): void {
    const base = this.vertexCount;
    for (let i = 0; i < positions.length; i++) this.positions.push(positions[i] as number);
    for (let i = 0; i < indices.length; i++) this.indices.push(base + (indices[i] as number));
  }

  /** Append an axis-aligned box given its centre and half extents. */
  addBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    const { positions, indices } = boxTriangles(cx, cy, cz, hx, hy, hz);
    this.add(positions, indices);
  }
}

/**
 * Recast's walkable test takes the triangle normal as (v1 - v0) x (v2 - v0)
 * in a right-handed Y-up space, so faces must wind counter-clockwise seen
 * from outside. Vertices 0-3 are the bottom ring, 4-7 the top ring, both in
 * (x0,z0) (x1,z0) (x1,z1) (x0,z1) order.
 */
const BOX_INDICES = [
  0, 1, 2, 0, 2, 3, // -y (bottom)
  4, 7, 6, 4, 6, 5, // +y (top)
  0, 4, 5, 0, 5, 1, // -z
  1, 5, 6, 1, 6, 2, // +x
  2, 6, 7, 2, 7, 3, // +z
  3, 7, 4, 3, 4, 0, // -x
];

/** Twelve outward-facing triangles for an axis-aligned box. */
export function boxTriangles(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): { positions: number[]; indices: number[] } {
  const x0 = cx - hx;
  const x1 = cx + hx;
  const y0 = cy - hy;
  const y1 = cy + hy;
  const z0 = cz - hz;
  const z1 = cz + hz;
  const positions = [
    x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,
    x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1,
  ];
  return { positions, indices: BOX_INDICES.slice() };
}
