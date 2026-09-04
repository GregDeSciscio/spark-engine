import { beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../src/core/Random';
import { DEFAULT_NAV_AGENT, Navigation, bakeNavMesh, initNavigation, navMeshConfig } from '../src/ai/Navigation';
import { PathFollower } from '../src/ai/PathFollower';
import { TriangleSoup, boxTriangles } from '../src/ai/TriangleSoup';

/** A 30 m square floor with a long wall across the middle, leaving a gap at one end. */
function room(): TriangleSoup {
  const soup = new TriangleSoup();
  soup.addBox(0, -0.5, 0, 15, 0.5, 15);
  // Wall from x=-15 to x=8 at z=0: the only way around is past x=8.
  soup.addBox(-3.5, 1.5, 0, 11.5, 1.5, 0.3);
  return soup;
}

beforeAll(async () => {
  await initNavigation();
});

describe('navMeshConfig', () => {
  it('converts the world-unit agent into voxels', () => {
    const c = navMeshConfig(DEFAULT_NAV_AGENT);
    expect(c.cs).toBe(0.2);
    expect(c.walkableRadius).toBe(2);
    expect(c.walkableHeight).toBe(12);
    expect(c.walkableClimb).toBe(2);
    expect(c.walkableSlopeAngle).toBe(50);
  });
});

describe('boxTriangles', () => {
  it('produces twelve triangles with outward winding on the top face', () => {
    const { positions, indices } = boxTriangles(0, 0, 0, 1, 1, 1);
    expect(indices.length).toBe(36);
    // Recast's normal for a triangle is (v1 - v0) x (v2 - v0); the top face (second triangle pair) must point +y and the bottom -y.
    const p = (i: number): [number, number, number] => [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number];
    const normalY = (tri: number): number => {
      const [a, b, c] = [p(indices[tri * 3] as number), p(indices[tri * 3 + 1] as number), p(indices[tri * 3 + 2] as number)];
      const e0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      return (e0[2] as number) * (e1[0] as number) - (e0[0] as number) * (e1[2] as number);
    };
    expect(normalY(0)).toBeLessThan(0);
    expect(normalY(2)).toBeGreaterThan(0);
    expect(normalY(3)).toBeGreaterThan(0);
  });
});

describe('Navigation', () => {
  it('bakes, exports and re-imports a mesh with the same polygons', () => {
    const soup = room();
    const bytes = bakeNavMesh(soup.positions, soup.indices);
    expect(bytes.length).toBeGreaterThan(100);
    const nav = Navigation.fromBytes(bytes);
    const stats = nav.stats();
    expect(stats.tiles).toBe(1);
    expect(stats.polys).toBeGreaterThan(2);
    const again = Navigation.fromBytes(nav.export());
    expect(again.stats()).toEqual(stats);
    nav.dispose();
    again.dispose();
  });

  it('is deterministic for the same input', () => {
    const soup = room();
    const a = bakeNavMesh(soup.positions, soup.indices);
    const b = bakeNavMesh(soup.positions, soup.indices);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('routes around the wall through the gap', () => {
    const soup = room();
    const nav = Navigation.bake(soup.positions, soup.indices);
    const out: { x: number; y: number; z: number }[] = [];
    const ok = nav.findPath({ x: -8, y: 0, z: -8 }, { x: -8, y: 0, z: 8 }, out);
    expect(ok).toBe(true);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Some corner must pass the wall's end at x > 8 (minus the agent radius erosion).
    expect(Math.max(...out.map((p) => p.x))).toBeGreaterThan(7.5);
    const last = out[out.length - 1];
    expect(last?.x).toBeCloseTo(-8, 0);
    expect(last?.z).toBeCloseTo(8, 0);
    nav.dispose();
  });

  it('snaps a point above the floor onto the mesh and returns null far away', () => {
    const soup = room();
    const nav = Navigation.bake(soup.positions, soup.indices);
    const out = { x: 0, y: 0, z: 0 };
    expect(nav.nearestPoint({ x: 5, y: 1.5, z: -5 }, out)).not.toBeNull();
    expect(out.y).toBeCloseTo(0, 0);
    expect(nav.nearestPoint({ x: 500, y: 0, z: 500 }, out)).toBeNull();
    nav.dispose();
  });

  it('raycasts along the surface and stops at the wall', () => {
    const soup = room();
    const nav = Navigation.bake(soup.positions, soup.indices);
    const blocked = nav.raycast({ x: -8, y: 0, z: -8 }, { x: -8, y: 0, z: 8 });
    expect(blocked.blocked).toBe(true);
    expect(blocked.point.z).toBeLessThan(0);
    const clear = nav.raycast({ x: -8, y: 0, z: -8 }, { x: 8, y: 0, z: -8 });
    expect(clear.blocked).toBe(false);
    expect(clear.t).toBe(1);
    nav.dispose();
  });

  it('draws random points from the seeded stream deterministically', () => {
    const soup = room();
    const nav = Navigation.bake(soup.positions, soup.indices);
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    expect(nav.randomPointAround({ x: -8, y: 0, z: -8 }, 4, new Random(7), a)).not.toBeNull();
    expect(nav.randomPointAround({ x: -8, y: 0, z: -8 }, 4, new Random(7), b)).not.toBeNull();
    expect(a).toEqual(b);
    expect(a.y).toBeCloseTo(0, 0);
    // Detour samples whole polygons touched by the circle, so only a loose bound holds.
    expect(Math.hypot(a.x + 8, a.z + 8)).toBeLessThan(12);
    const c = { x: 0, y: 0, z: 0 };
    nav.randomPointAround({ x: -8, y: 0, z: -8 }, 4, new Random(8), c);
    expect(c).not.toEqual(a);
    nav.dispose();
  });

  it('exposes polygon outlines for debug drawing', () => {
    const soup = room();
    const nav = Navigation.bake(soup.positions, soup.indices);
    const lines = nav.debugLines();
    expect(lines.length % 6).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    nav.dispose();
  });
});

describe('PathFollower', () => {
  it('steers corner to corner and finishes', () => {
    const f = new PathFollower(0.5);
    f.setPath([
      { x: 2, y: 0, z: 0 },
      { x: 2, y: 0, z: 2 },
    ]);
    const dir = { x: 0, y: 0, z: 0 };
    expect(f.steer({ x: 0, y: 0, z: 0 }, dir)).toBe(true);
    expect(dir.x).toBeCloseTo(1);
    expect(dir.z).toBeCloseTo(0);
    expect(f.remainingDistance({ x: 0, y: 0, z: 0 })).toBeCloseTo(4);
    expect(f.steer({ x: 1.8, y: 0, z: 0 }, dir)).toBe(true);
    expect(dir.z).toBeCloseTo(1);
    expect(f.remainingCorners).toBe(1);
    expect(f.steer({ x: 2, y: 0, z: 1.9 }, dir)).toBe(false);
    expect(f.hasPath).toBe(false);
    expect(dir.x).toBe(0);
  });
});
