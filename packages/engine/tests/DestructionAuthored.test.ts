import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../src/core/Random';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { authoredStructure, fractureBoxes, type PieceBox } from '../src/destruction/core/authored';
import { GROUND } from '../src/destruction/core/connections';
import { GONE } from '../src/destruction/Debris';
import { Destruction } from '../src/destruction/Destruction';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';
import { createPhysicsSystems } from '../src/physics/systems';
import { parseLevelNodes, type LevelNode } from '../src/world/LevelLoader';

/**
 * Authored buildings (readiness gap 1): boxes tagged `spark.type =
 * destructible` in a Blender level become a structure's chunks, fractured as
 * the procedural builder fractures its panels, whichever way they are turned.
 */

const DT = 1 / 60;

/** Turn (x, z) by `yaw` about the vertical axis. */
function turn(yaw: number, x: number, z: number): [number, number] {
  return [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
}

/**
 * A one-room, two-storey building of boxes, as a level designer would block it out: four walls and
 * a slab a storey, two columns inside, the whole turned by `yaw` and moved to (ox, oz).
 */
function blockout(yaw = 0, ox = 0, oz = 0, ground = 0): PieceBox[] {
  const q: [number, number, number, number] = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const boxes: PieceBox[] = [];
  const add = (kind: PieceBox['kind'], x: number, y: number, z: number, hx: number, hy: number, hz: number): void => {
    const [tx, tz] = turn(yaw, x, z);
    boxes.push({ center: [ox + tx, ground + y, oz + tz], quaternion: q, halfExtents: [hx, hy, hz], kind });
  };
  const H = 3;
  const T = 0.25;
  for (let f = 0; f < 2; f++) {
    const y = f * H + (H - T) / 2;
    const hy = (H - T) / 2;
    add('wall', 0, y, -4 + T / 2, 5, hy, T / 2); // front, full width
    add('wall', 0, y, 4 - T / 2, 5, hy, T / 2); // back
    add('wall', -5 + T / 2, y, 0, T / 2, hy, 4 - T); // sides between them
    add('wall', 5 - T / 2, y, 0, T / 2, hy, 4 - T);
    add('column', -1.5, y, 0, 0.2, hy, 0.2);
    add('column', 1.5, y, 0, 0.2, hy, 0.2);
    add('slab', 0, (f + 1) * H - T / 2, 0, 5, T / 2, 4);
  }
  return boxes;
}

describe('parseLevelNodes: destructible boxes', () => {
  const node = (name: string, spark: Record<string, unknown>, he: [number, number, number], scale: [number, number, number] = [1, 1, 1]): LevelNode => ({
    name,
    path: name,
    type: 'Mesh',
    spark,
    collision: false,
    hasMesh: true,
    isLight: false,
    position: [1, 2, 3],
    quaternion: [0, 0, 0, 1],
    scale,
    halfExtents: he,
  });

  it('groups them by structure, scales them, and tells their kind by name or by shape', () => {
    const out = parseLevelNodes([
      node('a', { type: 'destructible', structure: 'depot', piece: 'column', cell: 0.5 }, [0.5, 0.5, 0.5], [0.4, 3, 0.4]),
      node('b', { type: 'destructible', structure: 'depot' }, [0.5, 0.5, 0.5], [10, 0.25, 8]),
      node('c', { type: 'destructible' }, [0.5, 0.5, 0.5], [10, 3, 0.3]),
      node('d', { type: 'destructible', density: 1800 }, [0.5, 0.5, 0.5], [0.4, 3, 0.4]),
    ]);
    expect(out.map((d) => d.kind)).toEqual(['destructible', 'destructible', 'destructible', 'destructible']);
    const boxes = out.map((d) => (d.kind === 'destructible' ? d : null)!);
    expect(boxes.map((d) => d.structure)).toEqual(['depot', 'depot', 'default', 'default']);
    expect(boxes.map((d) => d.box.kind)).toEqual(['column', 'slab', 'wall', 'column']);
    expect(boxes[0]!.box.halfExtents).toEqual([0.2, 1.5, 0.2]);
    expect(boxes[0]!.box.cell).toBe(0.5);
    expect(boxes[3]!.box.density).toBe(1800);
    expect(boxes[1]!.box.center).toEqual([1, 2, 3]);
  });
});

describe('fractureBoxes', () => {
  it('fills a turned box with chunks, one element per box, ids in order', () => {
    const yaw = 0.6;
    const box: PieceBox = { center: [3, 1.5, -2], quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], halfExtents: [2.5, 1.5, 0.15], kind: 'wall' };
    const pieces = fractureBoxes([box, { ...box, center: [3, 4.5, -2] }], { seed: 3 }, 10);
    expect(pieces[0]!.id).toBe(10);
    expect(pieces.every((p, i) => p.id === 10 + i)).toBe(true);
    expect(new Set(pieces.map((p) => p.element))).toEqual(new Set([0, 1]));
    const first = pieces.filter((p) => p.element === 0);
    // Volume and mass of the box, to rounding.
    const volume = first.reduce((s, p) => s + p.volume, 0);
    expect(volume).toBeCloseTo(5 * 3 * 0.3, 3);
    expect(first.reduce((s, p) => s + p.mass, 0)).toBeCloseTo(volume * 2400, 0);
    // Every chunk inside the turned box.
    for (const p of first)
      for (const [x, y, z] of p.vertices) {
        const [lx, lz] = turn(-yaw, x - 3, z + 2);
        expect(Math.abs(lx)).toBeLessThan(2.5 + 1e-6);
        expect(Math.abs(y - 1.5)).toBeLessThan(1.5 + 1e-6);
        expect(Math.abs(lz)).toBeLessThan(0.15 + 1e-6);
      }
    // The same boxes and seed: the same chunks.
    expect(fractureBoxes([box], { seed: 3 }).map((p) => p.centroid)).toEqual(fractureBoxes([box], { seed: 3 }).map((p) => p.centroid));
  });
});

describe('an authored building', () => {
  beforeAll(async () => {
    await initRapier();
  });

  const run = async (boxes: PieceBox[], groundY = 0) => {
    const entities = new EntityWorld({ capacity: 4096 });
    const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
    for (const s of createPhysicsSystems(physics)) entities.addSystem(s);
    const ground = entities.create([Transform, { y: groundY - 0.5 }]);
    physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 60, hy: 0.5, hz: 60 }, events: false });
    const structure = authoredStructure(boxes, { seed: 5 });
    const d = new Destruction({ entities, physics, random: new Random(7) }, structure);
    for (const s of d.systems()) entities.addSystem(s);
    const frames = (n: number): void => {
      for (let i = 0; i < n; i++) {
        entities.runStage('fixed', DT);
        entities.runStage('late', DT);
      }
    };
    return { d, structure, frames, dispose: () => (entities.dispose(), physics.dispose()) };
  };

  it('stands glued and grounded, turned any way and on any ground, and comes down without its ground storey', async () => {
    for (const [yaw, groundY] of [
      [0, 0],
      [Math.PI / 6, 2.5],
    ] as const) {
      const r = await run(blockout(yaw, 20, -10, groundY), groundY);
      const grounded = r.structure.connections.filter((c) => c.b === GROUND);
      expect(grounded.length).toBeGreaterThan(10);
      expect(r.structure.connections.length).toBeGreaterThan(r.structure.pieces.length);
      r.frames(60);
      expect(r.d.stats().standing).toBe(r.d.pieces.length);
      expect(r.d.stats().bodies).toBe(0);
      r.d.remove(r.d.pieces.filter((p) => p.max[1] < groundY + 2.8 && p.kind !== 'slab').map((p) => p.id));
      r.frames(240);
      const s = r.d.stats();
      expect(s.standing).toBeLessThan(r.d.pieces.length / 10);
      expect(s.sanity.nonFinite).toBe(0);
      // Nothing through the ground it stood on, loose or settled.
      const m = new THREE.Matrix4();
      for (const p of r.d.pieces) {
        if (r.d.debris.state[p.id] === GONE) continue;
        expect(new THREE.Vector3(...p.centroid).applyMatrix4(r.d.debris.restToWorld(p.id, m)).y).toBeGreaterThan(groundY - 0.5);
      }
      r.dispose();
    }
  }, 60_000);
});
