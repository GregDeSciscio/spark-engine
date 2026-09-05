import { beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../src/core/Random';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';
import { findCover, peekPoint } from '../src/ai/Cover';
import { NavAgent } from '../src/ai/NavAgent';
import { Navigation, initNavigation } from '../src/ai/Navigation';
import { inViewCone, lineOfSight } from '../src/ai/Perception';
import { TriangleSoup } from '../src/ai/TriangleSoup';

/**
 * One room for every query: a 30 m floor with a wall across the middle from
 * x=-15 to x=8 at z=0, three metres tall. The navmesh and the physics world
 * are built from the same boxes.
 */
const WALL = { x: -3.5, y: 1.5, z: 0, hx: 11.5, hy: 1.5, hz: 0.3 };
const FLOOR = { x: 0, y: -0.5, z: 0, hx: 15, hy: 0.5, hz: 15 };

interface Fixture {
  nav: Navigation;
  physics: PhysicsWorld;
  dispose(): void;
}

async function fixture(): Promise<Fixture> {
  const soup = new TriangleSoup();
  soup.addBox(FLOOR.x, FLOOR.y, FLOOR.z, FLOOR.hx, FLOOR.hy, FLOOR.hz);
  soup.addBox(WALL.x, WALL.y, WALL.z, WALL.hx, WALL.hy, WALL.hz);
  const nav = Navigation.bake(soup.positions, soup.indices);
  const entities = new EntityWorld({ capacity: 64 });
  const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
  for (const b of [FLOOR, WALL]) {
    const eid = entities.create([Transform, { x: b.x, y: b.y, z: b.z }]);
    physics.addBody(eid, { type: 'fixed', shape: { kind: 'box', hx: b.hx, hy: b.hy, hz: b.hz }, layer: 'world' });
  }
  physics.step();
  return {
    nav,
    physics,
    dispose() {
      nav.dispose();
      entities.dispose();
      physics.dispose();
    },
  };
}

beforeAll(async () => {
  await Promise.all([initNavigation(), initRapier()]);
});

describe('lineOfSight and inViewCone', () => {
  it('sees across open floor and not through the wall', async () => {
    const f = await fixture();
    expect(lineOfSight(f.physics, { x: -8, y: 1.6, z: -8 }, { x: 8, y: 1.2, z: -8 })).toBe(true);
    expect(lineOfSight(f.physics, { x: -8, y: 1.6, z: -8 }, { x: -8, y: 1.2, z: 8 })).toBe(false);
    f.dispose();
  });

  it('view cone is symmetric about forward and ignores height', () => {
    const forward = { x: 0, y: 0, z: -1 };
    const from = { x: 0, y: 0, z: 0 };
    expect(inViewCone(forward, from, { x: 0, y: 5, z: -10 }, Math.PI / 2)).toBe(true);
    expect(inViewCone(forward, from, { x: 9, y: 0, z: -10 }, Math.PI / 2)).toBe(true);
    expect(inViewCone(forward, from, { x: 11, y: 0, z: -10 }, Math.PI / 2)).toBe(false);
    expect(inViewCone(forward, from, { x: 0, y: 0, z: 10 }, Math.PI / 2)).toBe(false);
    expect(inViewCone(forward, from, from, Math.PI / 2)).toBe(true);
  });
});

describe('NavAgent', () => {
  it('walks around the wall to its destination and arrives', async () => {
    const f = await fixture();
    const agent = new NavAgent(f.nav, { repathSeconds: 0.5, arriveDistance: 0.5 });
    const pos = { x: -8, y: 0, z: -8 };
    agent.setDestination({ x: -8, y: 0, z: 8 });
    const dir = { x: 0, y: 0, z: 0 };
    let maxX = -Infinity;
    let steps = 0;
    let now = 0;
    while (agent.steer(pos, now, dir) && steps++ < 4000) {
      pos.x += dir.x * 3 * (1 / 60);
      pos.z += dir.z * 3 * (1 / 60);
      maxX = Math.max(maxX, pos.x);
      now += 1 / 60;
    }
    expect(steps).toBeLessThan(4000);
    expect(agent.arrived(pos)).toBe(true);
    expect(maxX).toBeGreaterThan(7.5);
    expect(agent.lastPathComplete).toBe(true);
    f.dispose();
  });

  it('keeps its path for small destination moves and repaths for large ones', async () => {
    const f = await fixture();
    const agent = new NavAgent(f.nav, { repathSeconds: 10, retargetDistance: 1 });
    const pos = { x: -8, y: 0, z: -8 };
    const dir = { x: 0, y: 0, z: 0 };
    agent.setDestination({ x: 8, y: 0, z: -8 });
    expect(agent.steer(pos, 0, dir)).toBe(true);
    expect(dir.x).toBeGreaterThan(0.9);
    // A nudge keeps the old corners; a jump to the far side repaths and the first corner changes.
    agent.setDestination({ x: 8.5, y: 0, z: -8 });
    agent.steer(pos, 1, dir);
    expect(dir.x).toBeGreaterThan(0.9);
    agent.setDestination({ x: -8, y: 0, z: 8 });
    agent.steer(pos, 2, dir);
    expect(dir.x).toBeGreaterThan(0.2);
    expect(agent.hasDestination).toBe(true);
    agent.clear();
    expect(agent.steer(pos, 3, dir)).toBe(false);
    expect(dir.x).toBe(0);
    f.dispose();
  });
});

describe('findCover and peekPoint', () => {
  it('picks a point the threat cannot see into, on the far side of the wall', async () => {
    const f = await fixture();
    const random = new Random(3);
    const threatEye = { x: -6, y: 1.6, z: -10 };
    const cover = { x: 0, y: 0, z: 0 };
    const ok = findCover(f.nav, f.physics, random, {
      from: { x: -6, y: 0, z: 3 },
      threatEye,
      searchRadius: 6,
      samples: 24,
      minThreatDistance: 4,
      maxThreatDistance: 30,
      hideHeight: 1.0,
    }, cover);
    expect(ok).toBe(true);
    // Behind the wall: positive z, and not visible from the threat.
    expect(cover.z).toBeGreaterThan(0.3);
    expect(lineOfSight(f.physics, threatEye, { x: cover.x, y: cover.y + 1.0, z: cover.z })).toBe(false);

    const peek = { x: 0, y: 0, z: 0 };
    expect(peekPoint(f.nav, cover, threatEye, 1.1, random, peek)).toBe(true);
    const sideways = Math.hypot(peek.x - cover.x, peek.z - cover.z);
    expect(sideways).toBeGreaterThan(0.5);
    expect(sideways).toBeLessThan(1.6);
    f.dispose();
  });

  it('returns false with nothing to hide behind', async () => {
    const f = await fixture();
    const cover = { x: 0, y: 0, z: 0 };
    const ok = findCover(f.nav, f.physics, new Random(9), {
      from: { x: 12, y: 0, z: -12 },
      threatEye: { x: 12, y: 1.6, z: -6 },
      searchRadius: 2,
      samples: 12,
      minThreatDistance: 1,
      maxThreatDistance: 30,
      hideHeight: 1.0,
    }, cover);
    expect(ok).toBe(false);
    f.dispose();
  });
});
