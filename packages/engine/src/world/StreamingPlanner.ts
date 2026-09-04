/**
 * The pure half of chunk streaming: which chunks should be resident around a
 * moving target, in what order, and when they may go. No three, no entities,
 * no allocation once constructed (the queue array is reused across replans).
 *
 * Chunks are addressed by integer grid coordinates `(cx, cz)` and packed into
 * a single non-negative key so systems can store them in numeric components.
 */

export interface StreamingPlannerOptions {
  /** World size of one chunk along X and Z. Chunk `(cx, cz)` spans `[cx·size, (cx+1)·size)`. */
  chunkSize: number;
  /** Inclusive chunk-coordinate bounds of the world. */
  minChunkX: number;
  minChunkZ: number;
  maxChunkX: number;
  maxChunkZ: number;
  /** Chunks whose centre is within this distance of the streaming centre are wanted. */
  loadRadius: number;
  /** Resident chunks are released only once their centre is beyond this (> loadRadius: hysteresis). */
  unloadRadius: number;
  /** Move the streaming centre this far ahead of the target along its heading. Default 0. */
  lookAhead?: number | undefined;
  /**
   * How strongly chunks ahead of the target's motion are preferred, 0..1.
   * Priority = distance × (1 − weight × cos(angle to heading)). Default 0.5.
   */
  directionWeight?: number | undefined;
  /** Replan when the target moved at least this far since the last plan. Default chunkSize / 4. */
  replanDistance?: number | undefined;
  /** Replan when the heading turned at least this much (radians). Default ~15°. */
  replanAngle?: number | undefined;
}

export class StreamingPlanner {
  readonly chunkSize: number;
  readonly minChunkX: number;
  readonly minChunkZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly loadRadius: number;
  readonly unloadRadius: number;
  readonly lookAhead: number;
  readonly directionWeight: number;
  readonly replanDistance: number;
  readonly replanAngle: number;

  /** Wanted chunk keys in priority order (index 0 loads first). Rebuilt on replan; do not mutate. */
  readonly queue: number[] = [];

  private readonly score: Float32Array;
  private targetX = 0;
  private targetZ = 0;
  private dirX = 0;
  private dirZ = 0;
  private centreX = 0;
  private centreZ = 0;
  private planX = Number.NaN;
  private planZ = Number.NaN;
  private planDirX = 0;
  private planDirZ = 0;
  private replans = 0;

  constructor(options: StreamingPlannerOptions) {
    if (!(options.chunkSize > 0)) throw new Error('StreamingPlanner: chunkSize must be positive');
    if (options.maxChunkX < options.minChunkX || options.maxChunkZ < options.minChunkZ) throw new Error('StreamingPlanner: empty grid');
    if (!(options.unloadRadius >= options.loadRadius)) throw new Error('StreamingPlanner: unloadRadius must be >= loadRadius');
    this.chunkSize = options.chunkSize;
    this.minChunkX = options.minChunkX;
    this.minChunkZ = options.minChunkZ;
    this.cols = options.maxChunkX - options.minChunkX + 1;
    this.rows = options.maxChunkZ - options.minChunkZ + 1;
    this.loadRadius = options.loadRadius;
    this.unloadRadius = options.unloadRadius;
    this.lookAhead = options.lookAhead ?? 0;
    this.directionWeight = Math.min(1, Math.max(0, options.directionWeight ?? 0.5));
    this.replanDistance = options.replanDistance ?? options.chunkSize / 4;
    this.replanAngle = options.replanAngle ?? 0.26;
    this.score = new Float32Array(this.cols * this.rows);
  }

  // ---- keys ------------------------------------------------------------------

  get chunkCount(): number {
    return this.cols * this.rows;
  }

  /** Packed key for chunk coordinates, or -1 when outside the grid. */
  key(cx: number, cz: number): number {
    const ix = cx - this.minChunkX;
    const iz = cz - this.minChunkZ;
    if (ix < 0 || iz < 0 || ix >= this.cols || iz >= this.rows) return -1;
    return iz * this.cols + ix;
  }

  chunkX(key: number): number {
    return (key % this.cols) + this.minChunkX;
  }

  chunkZ(key: number): number {
    return Math.floor(key / this.cols) + this.minChunkZ;
  }

  /** Key of the chunk containing a world position, clamped to the grid. */
  keyAt(x: number, z: number): number {
    let ix = Math.floor(x / this.chunkSize) - this.minChunkX;
    let iz = Math.floor(z / this.chunkSize) - this.minChunkZ;
    if (ix < 0) ix = 0;
    else if (ix >= this.cols) ix = this.cols - 1;
    if (iz < 0) iz = 0;
    else if (iz >= this.rows) iz = this.rows - 1;
    return iz * this.cols + ix;
  }

  centreXOf(key: number): number {
    return (this.chunkX(key) + 0.5) * this.chunkSize;
  }

  centreZOf(key: number): number {
    return (this.chunkZ(key) + 0.5) * this.chunkSize;
  }

  // ---- target ------------------------------------------------------------------

  get replanCount(): number {
    return this.replans;
  }

  /** The streaming centre (target moved ahead by `lookAhead`). */
  get centre(): { x: number; z: number } {
    return { x: this.centreX, z: this.centreZ };
  }

  /**
   * Update the target position and heading (`dx, dz` need not be unit length;
   * zero means "no heading"). Returns true when the wanted set was recomputed.
   */
  setTarget(x: number, z: number, dx: number, dz: number): boolean {
    const len = Math.hypot(dx, dz);
    this.targetX = x;
    this.targetZ = z;
    this.dirX = len > 0 ? dx / len : 0;
    this.dirZ = len > 0 ? dz / len : 0;
    this.centreX = x + this.dirX * this.lookAhead;
    this.centreZ = z + this.dirZ * this.lookAhead;
    if (!this.needsReplan()) return false;
    this.replan();
    return true;
  }

  private needsReplan(): boolean {
    if (Number.isNaN(this.planX)) return true;
    const mx = this.targetX - this.planX;
    const mz = this.targetZ - this.planZ;
    if (mx * mx + mz * mz >= this.replanDistance * this.replanDistance) return true;
    const hadHeading = this.planDirX !== 0 || this.planDirZ !== 0;
    const hasHeading = this.dirX !== 0 || this.dirZ !== 0;
    if (hadHeading !== hasHeading) return true;
    if (!hasHeading) return false;
    const dot = this.planDirX * this.dirX + this.planDirZ * this.dirZ;
    return dot < Math.cos(this.replanAngle);
  }

  /** Force the wanted set to be recomputed on the current target. */
  replan(): void {
    this.planX = this.targetX;
    this.planZ = this.targetZ;
    this.planDirX = this.dirX;
    this.planDirZ = this.dirZ;
    this.replans++;
    const queue = this.queue;
    queue.length = 0;
    const r = this.loadRadius;
    const size = this.chunkSize;
    const cx0 = Math.max(this.minChunkX, Math.floor((this.centreX - r) / size));
    const cx1 = Math.min(this.minChunkX + this.cols - 1, Math.floor((this.centreX + r) / size));
    const cz0 = Math.max(this.minChunkZ, Math.floor((this.centreZ - r) / size));
    const cz1 = Math.min(this.minChunkZ + this.rows - 1, Math.floor((this.centreZ + r) / size));
    const r2 = r * r;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const px = (cx + 0.5) * size - this.centreX;
        const pz = (cz + 0.5) * size - this.centreZ;
        if (px * px + pz * pz > r2) continue;
        const key = this.key(cx, cz);
        this.score[key] = this.priority(key);
        queue.push(key);
      }
    }
    const score = this.score;
    queue.sort((a, b) => (score[a] as number) - (score[b] as number) || a - b);
  }

  /** Lower loads first: distance from the target, discounted for chunks ahead of its heading. */
  priority(key: number): number {
    const px = this.centreXOf(key) - this.targetX;
    const pz = this.centreZOf(key) - this.targetZ;
    const d = Math.hypot(px, pz);
    if (d === 0) return 0;
    const ahead = (px * this.dirX + pz * this.dirZ) / d; // 0 when there is no heading
    return d * (1 - this.directionWeight * ahead);
  }

  /** Distance from the streaming centre to a chunk's centre. */
  distanceTo(key: number): number {
    return Math.hypot(this.centreXOf(key) - this.centreX, this.centreZOf(key) - this.centreZ);
  }

  /** True once a resident chunk's centre is beyond the unload radius (hysteresis band above the load radius). */
  shouldUnload(key: number): boolean {
    return this.distanceTo(key) > this.unloadRadius;
  }

  /** True when the chunk is inside the load radius (the wanted set). */
  isWanted(key: number): boolean {
    return this.distanceTo(key) <= this.loadRadius;
  }
}
