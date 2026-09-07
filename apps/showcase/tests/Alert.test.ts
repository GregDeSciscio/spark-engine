import { describe, expect, it } from 'vitest';
import { ALERT, AlertDirector, type AlertSample, type LevelAlert, type ReinforcementPoint } from '../src/mission/Alert';

/**
 * The level-wide alert model from `docs/design/mission-shape.md`. The director
 * is plain numbers by design, so the whole escalation ladder is testable
 * without a renderer, a navmesh or an enemy.
 */

const POINTS: readonly ReinforcementPoint[] = [
  { id: 'a1', wave: 'alerted', position: { x: 0, y: 0, z: -60 }, route: 'Rifleman 3' },
  { id: 'a2', wave: 'alerted', position: { x: -7, y: 0, z: -30 }, route: null },
  { id: 'l1', wave: 'lockdown', position: { x: 7, y: 0, z: -60 }, route: null },
  { id: 'l2', wave: 'lockdown', position: { x: -6, y: 0, z: 22 }, route: null },
];

const HERE = { x: 1, y: 0, z: 2 };

interface Harness {
  readonly director: AlertDirector;
  readonly deployed: string[];
  readonly hunts: { x: number; y: number; z: number }[];
  readonly tiers: LevelAlert[];
  /** Run `seconds` of fixed steps at 60 Hz with a constant sample. */
  run(seconds: number, sample: Partial<AlertSample>): void;
  now(): number;
}

function harness(options: { spare?: () => boolean } = {}): Harness {
  const deployed: string[] = [];
  const hunts: { x: number; y: number; z: number }[] = [];
  const tiers: LevelAlert[] = [];
  const director = new AlertDirector({
    points: POINTS,
    deploy: (point) => {
      if (options.spare && !options.spare()) return false;
      deployed.push(point.id);
      return true;
    },
    hunt: (target) => hunts.push({ ...target }),
    onTier: (tier) => tiers.push(tier),
  });
  const dt = 1 / 60;
  let t = 0;
  return {
    director,
    deployed,
    hunts,
    tiers,
    now: () => t,
    run(seconds, sample) {
      const full: AlertSample = { contacts: 0, searching: 0, casualties: 0, live: 3, lastKnown: HERE, ...sample };
      for (let i = 0; i < Math.round(seconds / dt); i++) {
        t += dt;
        director.fixedUpdate(dt, t, full);
      }
    },
  };
}

describe('AlertDirector', () => {
  it('stays quiet while nobody is in contact', () => {
    const h = harness();
    h.run(60, { contacts: 0, searching: 1, lastKnown: null });
    expect(h.director.tier).toBe('quiet');
    expect(h.deployed).toEqual([]);
    expect(h.tiers).toEqual([]);
  });

  it('goes alerted on the first contact and sends the alerted wave in, spaced out', () => {
    const h = harness();
    h.run(0.5, { contacts: 1 });
    expect(h.director.tier).toBe('alerted');
    expect(h.tiers).toEqual(['alerted']);
    // The sweep is pointed at the contact the moment the tier changes.
    expect(h.hunts[0]).toEqual(HERE);
    // Nothing arrives instantly: the first is one spacing in.
    expect(h.deployed).toEqual([]);
    h.run(ALERT.spawnSpacing, { contacts: 1 });
    expect(h.deployed).toEqual(['a1']);
    h.run(ALERT.spawnSpacing, { contacts: 1 });
    expect(h.deployed).toEqual(['a1', 'a2']);
    // The alerted wave is spent; the lockdown points wait for lockdown.
    h.run(20, { contacts: 1 });
    expect(h.deployed).toEqual(['a1', 'a2']);
  });

  it('locks down when two hostiles are in contact at once', () => {
    const h = harness();
    h.run(0.5, { contacts: ALERT.lockdownContacts });
    expect(h.director.tier).toBe('lockdown');
    expect(h.tiers).toEqual(['alerted', 'lockdown']);
    h.run(ALERT.spawnSpacing * 4, { contacts: 2 });
    // Both waves are in play once the level is locked down.
    expect(h.deployed).toEqual(['a1', 'a2', 'l1', 'l2']);
  });

  it('locks down when the sector bleeds while alerted', () => {
    const h = harness();
    h.run(1, { contacts: 1, casualties: 0 });
    expect(h.director.tier).toBe('alerted');
    h.run(1, { contacts: 1, casualties: ALERT.lockdownCasualties - 1 });
    expect(h.director.tier).toBe('alerted');
    h.run(1, { contacts: 1, casualties: ALERT.lockdownCasualties });
    expect(h.director.tier).toBe('lockdown');
  });

  it('locks down when one contact drags on', () => {
    const h = harness();
    h.run(ALERT.lockdownAfter - 2, { contacts: 1 });
    expect(h.director.tier).toBe('alerted');
    h.run(3, { contacts: 1 });
    expect(h.director.tier).toBe('lockdown');
  });

  it('settles one tier at a time once nobody is in contact or searching', () => {
    const h = harness();
    h.run(0.5, { contacts: 2 });
    expect(h.director.tier).toBe('lockdown');
    // Still searching: the sector does not calm down.
    h.run(ALERT.settleAfter + 5, { contacts: 0, searching: 2 });
    expect(h.director.tier).toBe('lockdown');
    // The searching stopped, and the settle window has long since passed: one
    // tier goes now, and the next only after another quiet window.
    h.run(0.5, { contacts: 0, searching: 0 });
    expect(h.director.tier).toBe('alerted');
    h.run(ALERT.settleAfter - 2, { contacts: 0, searching: 0 });
    expect(h.director.tier).toBe('alerted');
    h.run(3, { contacts: 0, searching: 0 });
    expect(h.director.tier).toBe('quiet');
    expect(h.tiers).toEqual(['alerted', 'lockdown', 'alerted', 'quiet']);
  });

  it('keeps pointing the hunt at the last contact while alerted and out of touch', () => {
    const h = harness();
    h.run(0.5, { contacts: 1 });
    expect(h.hunts).toHaveLength(1);
    h.run(ALERT.huntEvery + 0.5, { contacts: 0, searching: 1 });
    expect(h.hunts).toHaveLength(2);
    expect(h.hunts[1]).toEqual(HERE);
  });

  it('does not exceed the live hostile cap', () => {
    const h = harness();
    h.run(ALERT.spawnSpacing * 6, { contacts: 2, live: ALERT.maxLiveHostiles });
    expect(h.deployed).toEqual([]);
    // Room again: the queued points go in.
    h.run(ALERT.spawnSpacing * 2, { contacts: 2, live: ALERT.maxLiveHostiles - 1 });
    expect(h.deployed.length).toBeGreaterThan(0);
  });

  it('keeps an ingress point queued when nothing is spare to send', () => {
    let spare = false;
    const h = harness({ spare: () => spare });
    h.run(ALERT.spawnSpacing * 3, { contacts: 1 });
    expect(h.deployed).toEqual([]);
    spare = true;
    h.run(ALERT.spawnSpacing * 1.2, { contacts: 1 });
    // The point was never consumed while there was nothing to send.
    expect(h.deployed[0]).toBe('a1');
  });

  it('forgets everything on a checkpoint reload, points included', () => {
    const h = harness();
    h.run(ALERT.spawnSpacing * 3, { contacts: 2 });
    expect(h.director.tier).toBe('lockdown');
    expect(h.deployed.length).toBeGreaterThan(0);
    const sent = h.deployed.length;
    h.director.reset(h.now());
    expect(h.director.tier).toBe('quiet');
    expect(h.director.status().deployed).toBe(0);
    expect(h.tiers.at(-1)).toBe('quiet');
    // The same points are available to the next run.
    h.run(ALERT.spawnSpacing * 3, { contacts: 2 });
    expect(h.deployed.length).toBe(sent * 2);
  });

  it('stands down the wave a tier above it when the sector calms', () => {
    // Nothing can deploy while the level is at its hostile cap, so the queue
    // is still full when the sector settles: the lockdown points must stand
    // down with the lockdown, or a calmed street keeps receiving its wave.
    const h = harness();
    h.run(0.5, { contacts: 2, live: ALERT.maxLiveHostiles });
    expect(h.director.tier).toBe('lockdown');
    expect(h.director.status().pending).toBe(POINTS.length);
    h.run(ALERT.settleAfter + 1, { contacts: 0, searching: 0, live: ALERT.maxLiveHostiles });
    expect(h.director.tier).toBe('alerted');
    expect(h.director.status().pending).toBe(POINTS.filter((p) => p.wave === 'alerted').length);
    h.run(ALERT.settleAfter + 1, { contacts: 0, searching: 0, live: ALERT.maxLiveHostiles });
    expect(h.director.tier).toBe('quiet');
    expect(h.director.status().pending).toBe(0);
  });

  it('reports what it has left to send', () => {
    const h = harness();
    h.run(0.1, { contacts: 1 });
    const status = h.director.status(h.now());
    expect(status.tier).toBe('alerted');
    expect(status.pending).toBe(2);
    expect(status.deployed).toBe(0);
    expect(status.sinceTier).toBeGreaterThanOrEqual(0);
  });
});
