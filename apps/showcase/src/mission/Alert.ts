/**
 * The level-wide alert model from `docs/design/mission-shape.md`:
 *
 *     Quiet -> Alerted (reinforcements, changed routes) -> Lockdown
 *
 * Per-enemy awareness (`ai/Awareness.ts`, owned by `actors/Enemy.ts`) says
 * what one rifleman knows. This says what the sector knows, which is the half
 * that makes stealth a mechanic rather than a stat: going loud costs the
 * player the level, not just the enemy who saw them.
 *
 * The director is deliberately free of three.js and of the entity world. It
 * reads a sample of numbers each fixed step and calls back out to deploy a
 * reinforcement, to send the live hostiles hunting, and to say the tier
 * changed. That keeps it testable (`apps/showcase/tests/Alert.test.ts`) and
 * keeps the spawning policy — which is game code — out of the enemy.
 */

export type LevelAlert = 'quiet' | 'alerted' | 'lockdown';

/** Which tier brings an ingress point into play. */
export type ReinforcementWave = 'alerted' | 'lockdown';

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** An authored ingress point: `spark.type=reinforce` in the level (ADR-008). */
export interface ReinforcementPoint {
  readonly id: string;
  readonly wave: ReinforcementWave;
  readonly position: Vec3Like;
  /** Patrol route the arrival adopts once its sweep runs out; null keeps it near the ingress. */
  readonly route: string | null;
}

export const ALERT = {
  /** Enemies in contact at once that take an alerted level to lockdown. */
  lockdownContacts: 2,
  /** Hostiles lost since the level went alerted that take it to lockdown. */
  lockdownCasualties: 2,
  /** Seconds of unbroken contact at alerted before command locks the sector down anyway. */
  lockdownAfter: 30,
  /** Seconds with nobody in contact, suspicious or searching before the level drops a tier. */
  settleAfter: 25,
  /** Live hostiles the director will not exceed, whatever the level authors. */
  maxLiveHostiles: 12,
  /** Seconds between arrivals inside one wave: they trickle in, they do not pop. */
  spawnSpacing: 2.5,
  /** While alerted and out of contact, re-point the hunt at the last known position this often. */
  huntEvery: 12,
} as const;

/** What the scene knows about the fight this tick. */
export interface AlertSample {
  /** Live hostiles currently alert: eyes on, or shooting. */
  readonly contacts: number;
  /** Live hostiles suspicious or searching: the level is not settled yet. */
  readonly searching: number;
  /** Hostiles down since the mission started. */
  readonly casualties: number;
  /** Hostiles alive and deployed, reinforcements included. */
  readonly live: number;
  /** Where the enemies last placed the operator; null before the first contact. */
  readonly lastKnown: Vec3Like | null;
}

export interface AlertDeps {
  /** Ingress points authored in the level. */
  readonly points: readonly ReinforcementPoint[];
  /** Put a hostile in at this point, sweeping toward `target`. False when none was spare. */
  deploy(point: ReinforcementPoint, target: Vec3Like | null): boolean;
  /** Every live hostile converges on this point: the changed-routes half of an alert. */
  hunt(target: Vec3Like): void;
  /** The tier changed. */
  onTier(tier: LevelAlert, previous: LevelAlert): void;
  /** A reinforcement went in, for the HUD and the barks. */
  onReinforcement?(point: ReinforcementPoint): void;
}

export interface AlertStatus {
  readonly tier: LevelAlert;
  /** Ingress points queued and not yet used. */
  readonly pending: number;
  /** Reinforcements sent in this run. */
  readonly deployed: number;
  /** Seconds in the current tier. */
  readonly sinceTier: number;
}

const RANK: Record<LevelAlert, number> = { quiet: 0, alerted: 1, lockdown: 2 };
const LOWER: Record<LevelAlert, LevelAlert> = { quiet: 'quiet', alerted: 'quiet', lockdown: 'alerted' };

export class AlertDirector {
  tier: LevelAlert = 'quiet';

  private readonly deps: AlertDeps;
  private readonly used = new Set<string>();
  private queue: ReinforcementPoint[] = [];
  private deployed = 0;
  private tierSince = 0;
  private lastContactAt = -Infinity;
  private casualtiesAtTier = 0;
  private nextSpawnAt = 0;
  private nextHuntAt = Infinity;

  constructor(deps: AlertDeps) {
    this.deps = deps;
  }

  /** Unused ingress points for a wave, in authored order. */
  private wave(wave: ReinforcementWave): ReinforcementPoint[] {
    return this.deps.points.filter((p) => p.wave === wave && !this.used.has(p.id));
  }

  fixedUpdate(dt: number, now: number, sample: AlertSample): void {
    void dt;
    if (sample.contacts > 0) this.lastContactAt = now;

    // ---- escalate ------------------------------------------------------------
    if (this.tier === 'quiet') {
      if (sample.contacts > 0) this.enter('alerted', now, sample);
    } else if (this.tier === 'alerted') {
      const bled = sample.casualties - this.casualtiesAtTier >= ALERT.lockdownCasualties;
      const swarmed = sample.contacts >= ALERT.lockdownContacts;
      const dragged = sample.contacts > 0 && now - this.tierSince >= ALERT.lockdownAfter;
      if (bled || swarmed || dragged) this.enter('lockdown', now, sample);
    }

    // ---- settle back down ----------------------------------------------------
    // Nobody in contact and nobody still poking around: the sector calms one tier
    // at a time, so a player who breaks contact after a loud fight waits out
    // lockdown before it is quiet again.
    if (this.tier !== 'quiet' && sample.contacts === 0 && sample.searching === 0 && now - this.lastContactAt >= ALERT.settleAfter) {
      const previous = this.tier;
      this.tier = LOWER[this.tier];
      this.tierSince = now;
      // One tier per settle window: dropping restarts the clock, so lockdown
      // takes two quiet stretches to become quiet.
      this.lastContactAt = now;
      this.casualtiesAtTier = sample.casualties;
      this.nextHuntAt = this.tier === 'quiet' ? Infinity : now + ALERT.huntEvery;
      if (this.tier === 'quiet') this.queue = [];
      this.deps.onTier(this.tier, previous);
    }

    // ---- reinforcements trickle in ------------------------------------------
    if (this.queue.length > 0 && now >= this.nextSpawnAt && sample.live < ALERT.maxLiveHostiles) {
      const point = this.queue[0] as ReinforcementPoint;
      if (this.deps.deploy(point, sample.lastKnown)) {
        this.queue.shift();
        this.used.add(point.id);
        this.deployed++;
        this.deps.onReinforcement?.(point);
      }
      // Spare or not, the next attempt waits a spacing: no per-tick retries.
      this.nextSpawnAt = now + ALERT.spawnSpacing;
    }

    // ---- keep the hunt pointed at the last contact ---------------------------
    if (this.tier !== 'quiet' && sample.contacts === 0 && sample.lastKnown && now >= this.nextHuntAt) {
      this.nextHuntAt = now + ALERT.huntEvery;
      this.deps.hunt(sample.lastKnown);
    }
  }

  private enter(tier: LevelAlert, now: number, sample: AlertSample): void {
    const previous = this.tier;
    this.tier = tier;
    this.tierSince = now;
    this.casualtiesAtTier = sample.casualties;
    this.nextHuntAt = now + ALERT.huntEvery;
    // A tier reached again after settling keeps the points it already spent.
    if (RANK[tier] > RANK[previous]) {
      this.queue = [...this.queue, ...this.wave(tier === 'lockdown' ? 'lockdown' : 'alerted')];
      this.nextSpawnAt = now + ALERT.spawnSpacing;
    }
    if (sample.lastKnown) this.deps.hunt(sample.lastKnown);
    this.deps.onTier(tier, previous);
  }

  /** Checkpoint reload: the sector forgets, and every ingress point is available again. */
  reset(now = 0): void {
    const previous = this.tier;
    this.tier = 'quiet';
    this.used.clear();
    this.queue = [];
    this.deployed = 0;
    this.tierSince = now;
    this.lastContactAt = -Infinity;
    this.casualtiesAtTier = 0;
    this.nextSpawnAt = 0;
    this.nextHuntAt = Infinity;
    if (previous !== 'quiet') this.deps.onTier('quiet', previous);
  }

  status(now = this.tierSince): AlertStatus {
    return { tier: this.tier, pending: this.queue.length, deployed: this.deployed, sinceTier: Math.max(0, now - this.tierSince) };
  }
}
