import type { Vec3Like } from './Navigation';

/**
 * Walks a corner list from `Navigation.findPath`. Pure and allocation-free
 * after construction: give it the agent's position each tick and it says
 * which way to go and whether it has arrived. Steering (speed, avoidance,
 * turning) stays with the agent; this only tracks progress along the path.
 */
export class PathFollower {
  private readonly corners: Vec3Like[] = [];
  private index = 0;
  /** Horizontal distance at which a corner counts as reached. */
  reachDistance: number;

  constructor(reachDistance = 0.35) {
    this.reachDistance = reachDistance;
  }

  /** Replace the path. Points are copied. */
  setPath(corners: readonly Vec3Like[]): void {
    this.corners.length = 0;
    for (const c of corners) this.corners.push({ x: c.x, y: c.y, z: c.z });
    this.index = 0;
  }

  clear(): void {
    this.corners.length = 0;
    this.index = 0;
  }

  get hasPath(): boolean {
    return this.index < this.corners.length;
  }

  get remainingCorners(): number {
    return Math.max(0, this.corners.length - this.index);
  }

  /** The corner currently being walked toward, or null when done. */
  current(): Vec3Like | null {
    return this.corners[this.index] ?? null;
  }

  /** The final destination, or null when there is no path. */
  destination(): Vec3Like | null {
    return this.corners[this.corners.length - 1] ?? null;
  }

  /**
   * Advance past any corners within reach of `position`, then write the unit
   * horizontal direction toward the current corner into `out`. Returns false
   * (and zeroes `out`) once the path is finished.
   */
  steer(position: Vec3Like, out: Vec3Like): boolean {
    const reach2 = this.reachDistance * this.reachDistance;
    while (this.index < this.corners.length) {
      const c = this.corners[this.index] as Vec3Like;
      const dx = c.x - position.x;
      const dz = c.z - position.z;
      if (dx * dx + dz * dz > reach2) break;
      this.index += 1;
    }
    const target = this.corners[this.index];
    if (!target) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return false;
    }
    const dx = target.x - position.x;
    const dz = target.z - position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return true;
    }
    out.x = dx / len;
    out.y = 0;
    out.z = dz / len;
    return true;
  }

  /** Horizontal distance left along the remaining corners. */
  remainingDistance(position: Vec3Like): number {
    let total = 0;
    let px = position.x;
    let pz = position.z;
    for (let i = this.index; i < this.corners.length; i++) {
      const c = this.corners[i] as Vec3Like;
      total += Math.hypot(c.x - px, c.z - pz);
      px = c.x;
      pz = c.z;
    }
    return total;
  }
}
