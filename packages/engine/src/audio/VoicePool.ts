import type { BusName } from './Buses';

/** Bookkeeping for one allocated voice. The live nodes live on the `Voice`; this is what the pool orders by. */
export interface VoiceSlot {
  readonly id: number;
  readonly bus: BusName;
  /** Allocation order; lower is older. */
  readonly serial: number;
  /** Steal priority: higher survives longer. Default 0. Loops usually raise it. */
  readonly priority: number;
}

/**
 * Per-bus voice caps with a steal-oldest policy. Pure: the caller supplies the
 * cap table and reacts to `steal` results by stopping the evicted voice.
 *
 * Stealing prefers the lowest priority, then the oldest within that priority,
 * so a footstep never evicts the neon loop unless the loop is the only voice left.
 */
export class VoicePool {
  private readonly slots = new Map<number, VoiceSlot>();
  private readonly perBus = new Map<BusName, number>();
  private nextId = 1;
  private serial = 0;
  private stolen = 0;

  constructor(private readonly caps: Readonly<Record<BusName, number>>) {}

  get size(): number {
    return this.slots.size;
  }

  countOn(bus: BusName): number {
    return this.perBus.get(bus) ?? 0;
  }

  capOf(bus: BusName): number {
    return this.caps[bus];
  }

  /** Total voices evicted by the steal policy since creation (a stat, not a fault). */
  get stolenCount(): number {
    return this.stolen;
  }

  /**
   * Allocate a slot on `bus`. If the bus is at its cap, returns the slot that
   * must be stopped in `steal` (already released from the pool) and the new slot.
   * A cap of 0 refuses allocation (`slot === null`).
   */
  allocate(bus: BusName, priority = 0): { slot: VoiceSlot | null; steal: VoiceSlot | null } {
    const cap = this.caps[bus];
    if (cap <= 0) return { slot: null, steal: null };
    let steal: VoiceSlot | null = null;
    if (this.countOn(bus) >= cap) {
      steal = this.oldestOn(bus);
      if (steal) {
        // Refuse rather than evict something more important than the newcomer.
        if (steal.priority > priority) return { slot: null, steal: null };
        this.release(steal.id);
        this.stolen += 1;
      }
    }
    const slot: VoiceSlot = { id: this.nextId++, bus, serial: this.serial++, priority };
    this.slots.set(slot.id, slot);
    this.perBus.set(bus, this.countOn(bus) + 1);
    return { slot, steal };
  }

  release(id: number): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    this.slots.delete(id);
    this.perBus.set(slot.bus, Math.max(0, this.countOn(slot.bus) - 1));
    return true;
  }

  has(id: number): boolean {
    return this.slots.has(id);
  }

  /** Lowest priority first, then oldest serial. */
  oldestOn(bus: BusName): VoiceSlot | null {
    let best: VoiceSlot | null = null;
    for (const slot of this.slots.values()) {
      if (slot.bus !== bus) continue;
      if (!best || slot.priority < best.priority || (slot.priority === best.priority && slot.serial < best.serial)) best = slot;
    }
    return best;
  }

  clear(): void {
    this.slots.clear();
    this.perBus.clear();
  }
}
