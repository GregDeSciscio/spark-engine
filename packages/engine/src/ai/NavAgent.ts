import type { Navigation, Vec3Like } from './Navigation';
import { PathFollower } from './PathFollower';

/**
 * A destination on the navmesh and the steering toward it: path request,
 * repath cadence, arrival. Movement itself (speed, the character controller,
 * avoidance) stays with the agent that owns it; this only answers "which way
 * now, and are we there". Promoted from the showcase's enemy, which carried
 * the same five steps as private methods.
 */
export interface NavAgentOptions {
  /** Seconds between repaths toward a live destination. Default 0.8. */
  readonly repathSeconds?: number | undefined;
  /** Horizontal distance at which a path corner counts as reached. Default 0.4. */
  readonly reachDistance?: number | undefined;
  /** Horizontal distance from the destination that counts as arrived. Default 0.6. */
  readonly arriveDistance?: number | undefined;
  /** A destination that moved less than this keeps the current path until the next repath. Default 1. */
  readonly retargetDistance?: number | undefined;
}

export class NavAgent {
  private readonly navigation: Navigation;
  private readonly follower: PathFollower;
  private readonly repathSeconds: number;
  private readonly arriveDistance: number;
  private readonly retargetDistance: number;
  private readonly target = { x: 0, y: 0, z: 0 };
  private hasTarget = false;
  private repathAt = -Infinity;
  private readonly corners: Vec3Like[] = [];
  /** Whether the last path reached the destination (false: partial path to the nearest reachable point). */
  lastPathComplete = true;

  constructor(navigation: Navigation, options: NavAgentOptions = {}) {
    this.navigation = navigation;
    this.follower = new PathFollower(options.reachDistance ?? 0.4);
    this.repathSeconds = options.repathSeconds ?? 0.8;
    this.arriveDistance = options.arriveDistance ?? 0.6;
    this.retargetDistance = options.retargetDistance ?? 1;
  }

  get hasDestination(): boolean {
    return this.hasTarget;
  }

  destination(out: Vec3Like): Vec3Like | null {
    if (!this.hasTarget) return null;
    out.x = this.target.x;
    out.y = this.target.y;
    out.z = this.target.z;
    return out;
  }

  /**
   * Set (or move) the destination. A small move keeps the current path until
   * the cadence repaths; a large one, or `force`, repaths on the next steer.
   */
  setDestination(target: Vec3Like, force = false): void {
    const moved = !this.hasTarget || Math.hypot(target.x - this.target.x, target.z - this.target.z) > this.retargetDistance;
    this.target.x = target.x;
    this.target.y = target.y;
    this.target.z = target.z;
    this.hasTarget = true;
    if (moved || force) this.repathAt = -Infinity;
  }

  clear(): void {
    this.hasTarget = false;
    this.follower.clear();
    this.repathAt = -Infinity;
  }

  /** Within arrive distance of the destination (horizontal). */
  arrived(position: Vec3Like): boolean {
    if (!this.hasTarget) return true;
    return Math.hypot(this.target.x - position.x, this.target.z - position.z) <= this.arriveDistance;
  }

  /**
   * Unit horizontal direction to move from `position` this tick, written to
   * `out`. Returns false (and zeroes `out`) when there is no destination,
   * the agent has arrived, or no path exists.
   */
  steer(position: Vec3Like, now: number, out: Vec3Like): boolean {
    if (!this.hasTarget || this.arrived(position)) {
      out.x = out.y = out.z = 0;
      return false;
    }
    if (now >= this.repathAt || !this.follower.hasPath) {
      this.lastPathComplete = this.navigation.findPath(position, this.target, this.corners);
      this.follower.setPath(this.corners);
      this.repathAt = now + this.repathSeconds;
    }
    return this.follower.steer(position, out);
  }

  remainingDistance(position: Vec3Like): number {
    return this.follower.remainingDistance(position);
  }
}
