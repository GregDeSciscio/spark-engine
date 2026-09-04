/**
 * Seeded PRNG (mulberry32). Every engine-owned source of randomness uses this;
 * `Math.random()` is banned from simulation code (see the kickoff doc, Game Loop).
 *
 * Small, fast, and good enough for gameplay. Not cryptographic.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Random.pick: empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Derive an independent stream, e.g. one per subsystem, from this one. */
  fork(): Random {
    return new Random(Math.floor(this.next() * 0xffffffff));
  }

  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }
}
