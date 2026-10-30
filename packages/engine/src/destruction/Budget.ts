/** What a member of a shared budget reports: how many it holds now, and the most it would want alone. */
export interface BudgetMember {
  readonly budgetCount: number;
  readonly budgetWanted: number;
}

/**
 * A budget several structures draw on: a level's buildings share what the
 * physics world can afford (loose bodies, hinge joints), not one each. Ten
 * buildings with a 360-body budget apiece would let 3,600 bodies loose, and
 * Rapier's step costs the same whichever building they came from.
 *
 * The limit is the largest any member asks for (every default is the same, so
 * one structure's limit is the pool's). Over it, each member sheds its share
 * of the excess, in proportion to what it holds: one member alone sheds
 * exactly what it did with a budget of its own.
 */
export class SharedBudget {
  private readonly members = new Set<BudgetMember>();

  join(member: BudgetMember): void {
    this.members.add(member);
  }

  leave(member: BudgetMember): void {
    this.members.delete(member);
  }

  get size(): number {
    return this.members.size;
  }

  /** The largest any member asks for. */
  get limit(): number {
    let max = 0;
    for (const m of this.members) max = Math.max(max, m.budgetWanted);
    return max;
  }

  /** What every member holds. */
  get total(): number {
    let n = 0;
    for (const m of this.members) n += m.budgetCount;
    return n;
  }

  /** Is the pool at its limit (nothing more may be added)? */
  full(): boolean {
    return this.total >= this.limit;
  }

  /** What `member` should shed for the pool to come within `factor` times the limit: its share of the excess. */
  excess(member: BudgetMember, factor = 1): number {
    const total = this.total;
    const over = total - this.limit * factor;
    if (over <= 0 || total === 0) return 0;
    return Math.ceil((over * member.budgetCount) / total);
  }
}

/** The budgets every structure in one physics world shares. */
export interface DestructionBudgets {
  /** Loose debris bodies (`DebrisSettings.maxBodies`). */
  readonly bodies: SharedBudget;
  /** Hinge links, each a joint or two (`HingeSettings.maxLinks`). */
  readonly links: SharedBudget;
}

const pools = new WeakMap<object, DestructionBudgets>();

/** The budgets shared by every structure in `world` (a `PhysicsWorld`): made on first use, gone with it. */
export function budgetsOf(world: object): DestructionBudgets {
  let b = pools.get(world);
  if (!b) {
    b = { bodies: new SharedBudget(), links: new SharedBudget() };
    pools.set(world, b);
  }
  return b;
}
