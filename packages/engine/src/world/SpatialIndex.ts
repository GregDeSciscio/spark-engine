import { FrustumResult, aabbInFrustum, raySlabXZ, raySphere, sphereInFrustum } from './Frustum';

export interface SpatialIndexOptions {
  /** World size of one grid cell along X and Z. */
  cellSize: number;
  /** World-space XZ rectangle the grid covers. Entries outside clamp to the edge cells (loose grid). */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Highest id + 1 the index may hold. Ids are entity ids, so pass the entity capacity + 1. */
  capacity: number;
}

export interface SpatialIndexStats {
  entries: number;
  cells: number;
  occupiedCells: number;
  /** Cells visited by the last query. */
  lastCellsVisited: number;
  /** Per-entity tests performed by the last query. */
  lastEntityTests: number;
}

/**
 * Uniform (loose) grid over bounding spheres, keyed by entity id. Pure logic:
 * no three, no allocation on `update` or on any query. Cells own dense id
 * arrays; each cell keeps a loose vertical extent and a loose maximum radius so
 * a sphere that sticks out of its cell is still found.
 *
 * Queries append candidate ids to a caller-owned `out` array (after clearing
 * it) and return the count. Candidates from `queryFrustum` and `queryRadius`
 * are exact sphere tests; `queryRay` returns the ids whose sphere the ray
 * hits, unsorted.
 */
export class SpatialIndex {
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly capacity: number;

  private readonly cellOf: Int32Array;
  private readonly slotOf: Int32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly pr: Float32Array;

  private readonly cells: Array<number[] | undefined>;
  private readonly cellMinY: Float32Array;
  private readonly cellMaxY: Float32Array;
  private readonly cellMaxR: Float32Array;
  private readonly occupied: number[] = [];
  private readonly occupiedSlot: Int32Array;
  private entries = 0;
  private maxRadius = 0;
  private lastCellsVisited = 0;
  private lastEntityTests = 0;

  constructor(options: SpatialIndexOptions) {
    if (!(options.cellSize > 0)) throw new Error('SpatialIndex: cellSize must be positive');
    if (!(options.maxX > options.minX) || !(options.maxZ > options.minZ)) throw new Error('SpatialIndex: empty bounds');
    this.cellSize = options.cellSize;
    this.minX = options.minX;
    this.minZ = options.minZ;
    this.cols = Math.max(1, Math.ceil((options.maxX - options.minX) / options.cellSize));
    this.rows = Math.max(1, Math.ceil((options.maxZ - options.minZ) / options.cellSize));
    this.capacity = options.capacity;
    const cellCount = this.cols * this.rows;
    this.cellOf = new Int32Array(options.capacity).fill(-1);
    this.slotOf = new Int32Array(options.capacity);
    this.px = new Float32Array(options.capacity);
    this.py = new Float32Array(options.capacity);
    this.pz = new Float32Array(options.capacity);
    this.pr = new Float32Array(options.capacity);
    this.cells = new Array<number[] | undefined>(cellCount);
    this.cellMinY = new Float32Array(cellCount);
    this.cellMaxY = new Float32Array(cellCount);
    this.cellMaxR = new Float32Array(cellCount);
    this.occupiedSlot = new Int32Array(cellCount).fill(-1);
  }

  get size(): number {
    return this.entries;
  }

  get cellCount(): number {
    return this.cols * this.rows;
  }

  has(id: number): boolean {
    return (this.cellOf[id] ?? -1) !== -1;
  }

  /** Cell index for a world XZ position, clamped to the grid. */
  cellAt(x: number, z: number): number {
    let cx = Math.floor((x - this.minX) / this.cellSize);
    let cz = Math.floor((z - this.minZ) / this.cellSize);
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.rows) cz = this.rows - 1;
    return cz * this.cols + cx;
  }

  // ---- mutation ------------------------------------------------------------

  insert(id: number, x: number, y: number, z: number, radius: number): void {
    if (id < 0 || id >= this.capacity) throw new Error(`SpatialIndex: id ${id} out of range (capacity ${this.capacity})`);
    if (this.cellOf[id] !== -1) {
      this.update(id, x, y, z, radius);
      return;
    }
    this.px[id] = x;
    this.py[id] = y;
    this.pz[id] = z;
    this.pr[id] = radius;
    this.addToCell(id, this.cellAt(x, z));
    this.entries++;
    if (radius > this.maxRadius) this.maxRadius = radius;
  }

  /** Move or resize an entry. Cheap when it stays in the same cell. */
  update(id: number, x: number, y: number, z: number, radius: number): void {
    const cell = this.cellOf[id] ?? -1;
    if (cell === -1) {
      this.insert(id, x, y, z, radius);
      return;
    }
    this.px[id] = x;
    this.py[id] = y;
    this.pz[id] = z;
    this.pr[id] = radius;
    if (radius > this.maxRadius) this.maxRadius = radius;
    const target = this.cellAt(x, z);
    if (target === cell) {
      this.growCellBounds(cell, y, radius);
      return;
    }
    this.removeFromCell(id, cell);
    this.addToCell(id, target);
  }

  remove(id: number): boolean {
    const cell = this.cellOf[id] ?? -1;
    if (cell === -1) return false;
    this.removeFromCell(id, cell);
    this.cellOf[id] = -1;
    this.entries--;
    return true;
  }

  clear(): void {
    for (const cell of this.occupied) {
      const list = this.cells[cell];
      if (list) {
        for (const id of list) this.cellOf[id] = -1;
        list.length = 0;
      }
      this.occupiedSlot[cell] = -1;
    }
    this.occupied.length = 0;
    this.entries = 0;
    this.maxRadius = 0;
  }

  private addToCell(id: number, cell: number): void {
    let list = this.cells[cell];
    if (!list) {
      list = [];
      this.cells[cell] = list;
    }
    if (list.length === 0) {
      this.occupiedSlot[cell] = this.occupied.length;
      this.occupied.push(cell);
      const y = this.py[id] as number;
      const r = this.pr[id] as number;
      this.cellMinY[cell] = y - r;
      this.cellMaxY[cell] = y + r;
      this.cellMaxR[cell] = r;
    } else {
      this.growCellBounds(cell, this.py[id] as number, this.pr[id] as number);
    }
    this.cellOf[id] = cell;
    this.slotOf[id] = list.length;
    list.push(id);
  }

  private removeFromCell(id: number, cell: number): void {
    const list = this.cells[cell];
    if (!list) return;
    const slot = this.slotOf[id] as number;
    const last = list.length - 1;
    const lastId = list[last] as number;
    if (slot !== last) {
      list[slot] = lastId;
      this.slotOf[lastId] = slot;
    }
    list.pop();
    if (list.length === 0) {
      // Swap-remove the cell from the occupied list.
      const os = this.occupiedSlot[cell] as number;
      const lastCell = this.occupied[this.occupied.length - 1] as number;
      this.occupied[os] = lastCell;
      this.occupiedSlot[lastCell] = os;
      this.occupied.pop();
      this.occupiedSlot[cell] = -1;
      this.cellMaxR[cell] = 0;
    }
  }

  private growCellBounds(cell: number, y: number, r: number): void {
    if (y - r < (this.cellMinY[cell] as number)) this.cellMinY[cell] = y - r;
    if (y + r > (this.cellMaxY[cell] as number)) this.cellMaxY[cell] = y + r;
    if (r > (this.cellMaxR[cell] as number)) this.cellMaxR[cell] = r;
  }

  // ---- queries ---------------------------------------------------------------

  /**
   * Ids whose sphere touches the frustum (6 planes × 4 floats, see `Frustum.ts`).
   * Cells fully inside contribute every entry without per-entity tests.
   */
  queryFrustum(planes: ArrayLike<number>, out: number[]): number {
    out.length = 0;
    let visited = 0;
    let tests = 0;
    const size = this.cellSize;
    for (let i = 0; i < this.occupied.length; i++) {
      const cell = this.occupied[i] as number;
      const list = this.cells[cell];
      if (!list || list.length === 0) continue;
      visited++;
      const cx = cell % this.cols;
      const cz = (cell - cx) / this.cols;
      const pad = this.cellMaxR[cell] as number;
      const x0 = this.minX + cx * size - pad;
      const z0 = this.minZ + cz * size - pad;
      const result = aabbInFrustum(
        planes,
        x0,
        this.cellMinY[cell] as number,
        z0,
        x0 + size + pad * 2,
        this.cellMaxY[cell] as number,
        z0 + size + pad * 2,
      );
      if (result === FrustumResult.Outside) continue;
      if (result === FrustumResult.Inside) {
        for (let j = 0; j < list.length; j++) out.push(list[j] as number);
        continue;
      }
      for (let j = 0; j < list.length; j++) {
        const id = list[j] as number;
        tests++;
        if (sphereInFrustum(planes, this.px[id] as number, this.py[id] as number, this.pz[id] as number, this.pr[id] as number)) {
          out.push(id);
        }
      }
    }
    this.lastCellsVisited = visited;
    this.lastEntityTests = tests;
    return out.length;
  }

  /** Ids whose sphere overlaps the sphere `(x, y, z, r)`. */
  queryRadius(x: number, y: number, z: number, r: number, out: number[]): number {
    out.length = 0;
    let visited = 0;
    let tests = 0;
    const reach = r + this.maxRadius;
    const c0 = this.cellAt(x - reach, z - reach);
    const c1 = this.cellAt(x + reach, z + reach);
    const cx0 = c0 % this.cols;
    const cz0 = (c0 - cx0) / this.cols;
    const cx1 = c1 % this.cols;
    const cz1 = (c1 - cx1) / this.cols;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells[cz * this.cols + cx];
        if (!list || list.length === 0) continue;
        visited++;
        for (let j = 0; j < list.length; j++) {
          const id = list[j] as number;
          tests++;
          const dx = (this.px[id] as number) - x;
          const dy = (this.py[id] as number) - y;
          const dz = (this.pz[id] as number) - z;
          const rr = r + (this.pr[id] as number);
          if (dx * dx + dy * dy + dz * dz <= rr * rr) out.push(id);
        }
      }
    }
    this.lastCellsVisited = visited;
    this.lastEntityTests = tests;
    return out.length;
  }

  /**
   * Ids whose sphere the ray hits within `maxDist`. `dir` need not be unit
   * length. Candidates are unsorted; use `hitDistance` if the order matters.
   */
  queryRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, out: number[]): number {
    out.length = 0;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0) || !(maxDist > 0)) return 0;
    dx /= len;
    dy /= len;
    dz /= len;
    let visited = 0;
    let tests = 0;
    const ex = ox + dx * maxDist;
    const ez = oz + dz * maxDist;
    const pad = this.maxRadius;
    const c0 = this.cellAt(Math.min(ox, ex) - pad, Math.min(oz, ez) - pad);
    const c1 = this.cellAt(Math.max(ox, ex) + pad, Math.max(oz, ez) + pad);
    const cx0 = c0 % this.cols;
    const cz0 = (c0 - cx0) / this.cols;
    const cx1 = c1 % this.cols;
    const cz1 = (c1 - cx1) / this.cols;
    const size = this.cellSize;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = cz * this.cols + cx;
        const list = this.cells[cell];
        if (!list || list.length === 0) continue;
        const cpad = this.cellMaxR[cell] as number;
        const x0 = this.minX + cx * size - cpad;
        const z0 = this.minZ + cz * size - cpad;
        if (!raySlabXZ(ox, oz, dx, dz, maxDist, x0, z0, x0 + size + cpad * 2, z0 + size + cpad * 2)) continue;
        visited++;
        for (let j = 0; j < list.length; j++) {
          const id = list[j] as number;
          tests++;
          const t = raySphere(ox, oy, oz, dx, dy, dz, maxDist, this.px[id] as number, this.py[id] as number, this.pz[id] as number, this.pr[id] as number);
          if (t >= 0) out.push(id);
        }
      }
    }
    this.lastCellsVisited = visited;
    this.lastEntityTests = tests;
    return out.length;
  }

  /** Entry distance along a unit ray to an entry's sphere, or -1. For sorting `queryRay` results. */
  hitDistance(id: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
    if ((this.cellOf[id] ?? -1) === -1) return -1;
    return raySphere(ox, oy, oz, dx, dy, dz, maxDist, this.px[id] as number, this.py[id] as number, this.pz[id] as number, this.pr[id] as number);
  }

  // ---- introspection -----------------------------------------------------------

  centerX(id: number): number {
    return this.px[id] as number;
  }

  centerY(id: number): number {
    return this.py[id] as number;
  }

  centerZ(id: number): number {
    return this.pz[id] as number;
  }

  radius(id: number): number {
    return this.pr[id] as number;
  }

  stats(): SpatialIndexStats {
    return {
      entries: this.entries,
      cells: this.cellCount,
      occupiedCells: this.occupied.length,
      lastCellsVisited: this.lastCellsVisited,
      lastEntityTests: this.lastEntityTests,
    };
  }
}
