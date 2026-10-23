import { describe, expect, it } from 'vitest';
import { MANTLE, mantlePose, planMantle, type MantlePlan, type MantleWorld, type MantleZone } from '../src/actors/mantle';

/**
 * The operator's vault (`src/actors/mantle.ts`): when a jump becomes a vault,
 * where it lands, and that the path goes over the obstacle rather than
 * through it. The world is a flat floor at y = 0 plus solid boxes, which is
 * all the planner asks about; the probe `mantle-vaults-a-crate` covers the
 * same move against the real street.
 */

const RADIUS = 0.4;

interface Solid {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly top: number;
}

function zone(minX: number, maxX: number, minZ: number, maxZ: number, top: number): MantleZone {
  return { minX, maxX, minZ, maxZ, bottom: 0, top };
}

/** A floor at 0 and these boxes, each standing on it. */
function world(solids: readonly Solid[]): MantleWorld {
  const inside = (s: Solid, x: number, z: number, pad = 0): boolean => x > s.minX - pad && x < s.maxX + pad && z > s.minZ - pad && z < s.maxZ + pad;
  return {
    groundBelow(x, z, fromY, depth) {
      let best = 0;
      for (const s of solids) if (inside(s, x, z) && s.top <= fromY && s.top > best) best = s.top;
      return best >= fromY - depth ? best : null;
    },
    standClear(x, y, z) {
      // A box blocks a standing capsule if it overlaps its circle and reaches above the feet.
      return solids.every((s) => !(inside(s, x, z, RADIUS - 0.04) && s.top > y + 0.05));
    },
  };
}

const feet = (x: number, z: number, y = 0) => ({ x, y, z });

describe('planMantle', () => {
  const wall = zone(-0.15, 0.15, -2, 2, 1.1);

  it('vaults a knee wall the operator faces, landing on the far side', () => {
    const plan = planMantle([wall], feet(-0.9, 0), 1, 0, RADIUS, world([wall]));
    expect(plan).not.toBeNull();
    const p = plan as MantlePlan;
    expect(p.over).toBe(true);
    expect([p.nx, p.nz]).toEqual([1, 0]);
    expect(p.to.x).toBeGreaterThan(wall.maxX + RADIUS);
    expect(p.to.y).toBeCloseTo(0, 1);
    expect(p.peak).toBeGreaterThan(wall.top);
  });

  it('goes square over the edge from a slanting approach, kept off the corner', () => {
    const crate = zone(0, 1, 0, 1, 1);
    // Looking 35 degrees off the face's normal, at a point 3 cm from its corner.
    const a = (35 * Math.PI) / 180;
    const plan = planMantle([crate], feet(0.45, -0.75), Math.sin(a), Math.cos(a), RADIUS, world([crate]));
    expect(plan).not.toBeNull();
    const p = plan as MantlePlan;
    expect([p.nx, p.nz]).toEqual([0, 1]);
    expect(p.to.z).toBeGreaterThan(crate.maxZ + RADIUS);
    expect(p.to.x).toBeCloseTo(crate.maxX - 0.2, 5);
  });

  it('climbs onto something too deep to vault', () => {
    const ledge = zone(0, 3, -1, 1, 1.0);
    const plan = planMantle([ledge], feet(-0.8, 0), 1, 0, RADIUS, world([ledge]));
    expect(plan?.over).toBe(false);
    expect(plan?.to.y).toBeCloseTo(1.0, 1);
    expect(plan?.to.x).toBeGreaterThan(ledge.minX + RADIUS);
  });

  it('lands on top of a crate when the far side is blocked', () => {
    const crate = zone(0, 1, -0.5, 0.5, 1);
    const behind: Solid = { minX: 1, maxX: 2, minZ: -2, maxZ: 2, top: 2.5 };
    const plan = planMantle([crate], feet(-0.8, 0), 1, 0, RADIUS, world([crate, behind]));
    expect(plan?.over).toBe(false);
    expect(plan?.to.y).toBeCloseTo(1, 1);
  });

  it('refuses a thin wall with nowhere to land: that is an ordinary jump', () => {
    const behind: Solid = { minX: 0.15, maxX: 1.5, minZ: -3, maxZ: 3, top: 3 };
    expect(planMantle([wall], feet(-0.9, 0), 1, 0, RADIUS, world([wall, behind]))).toBeNull();
  });

  it('refuses edges it should not take', () => {
    const w = world([wall]);
    expect(planMantle([wall], feet(-0.9, 0), -1, 0, RADIUS, w), 'facing away').toBeNull();
    expect(planMantle([wall], feet(-2.0, 0), 1, 0, RADIUS, w), 'out of reach').toBeNull();
    // Close enough that the slanting view still meets the face within reach; only the angle refuses it.
    const a = ((MANTLE.facingDeg + 10) * Math.PI) / 180;
    expect(planMantle([wall], feet(-0.56, 0), Math.cos(a), Math.sin(a), RADIUS, w), 'too oblique').toBeNull();
    const b = ((MANTLE.facingDeg - 10) * Math.PI) / 180;
    expect(planMantle([wall], feet(-0.56, 0), Math.cos(b), Math.sin(b), RADIUS, w), 'but inside the angle it goes').not.toBeNull();
    const tall = zone(-0.15, 0.15, -2, 2, 1.8);
    expect(planMantle([tall], feet(-0.9, 0), 1, 0, RADIUS, world([tall])), 'too high: a wall').toBeNull();
    const kerb = zone(-0.15, 0.15, -2, 2, 0.3);
    expect(planMantle([kerb], feet(-0.9, 0), 1, 0, RADIUS, world([kerb])), 'too low: a step').toBeNull();
    expect(planMantle([wall], feet(-0.9, 0, 1.0), 1, 0, RADIUS, w), 'already up there').toBeNull();
  });

  it('takes the nearer of two edges in view', () => {
    const near = zone(0, 0.3, -1, 1, 1);
    const far = zone(0.8, 1.1, -1, 1, 1);
    const plan = planMantle([far, near], feet(-0.7, 0), 1, 0, RADIUS, world([near]));
    expect(plan?.zone).toBe(near);
  });
});

describe('mantlePose', () => {
  /** Horizontal distance from a point to a footprint; 0 inside it. */
  const distanceTo = (z: MantleZone, x: number, zz: number): number => Math.hypot(Math.max(z.minX - x, 0, x - z.maxX), Math.max(z.minZ - zz, 0, zz - z.maxZ));

  const cases: [string, MantleZone, Solid[]][] = [
    ['over a knee wall', zone(-0.15, 0.15, -2, 2, 1.1), []],
    ['onto a ledge', zone(0, 3, -1, 1, 1.0), []],
  ];
  for (const [name, z, extra] of cases) {
    it(`${name}: starts at the feet, ends at the landing, never inside the obstacle`, () => {
      const plan = planMantle([z], feet(z.minX - 0.8, 0), 1, 0, RADIUS, world([z, ...extra])) as MantlePlan;
      expect(plan).not.toBeNull();
      const out = { x: 0, y: 0, z: 0 };
      const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): void => {
        expect(a.x).toBeCloseTo(b.x, 9);
        expect(a.y).toBeCloseTo(b.y, 9);
        expect(a.z).toBeCloseTo(b.z, 9);
      };
      near(mantlePose(plan, 0, out), plan.from);
      near(mantlePose(plan, 1, out), plan.to);
      for (let i = 0; i <= 200; i++) {
        const p = mantlePose(plan, i / 200, out);
        // Wherever the capsule overhangs the footprint, the feet are above the top.
        if (distanceTo(z, p.x, p.z) < RADIUS - 0.06) expect(p.y, `u=${i / 200}`).toBeGreaterThanOrEqual(z.top - 1e-6);
      }
    });
  }
});
