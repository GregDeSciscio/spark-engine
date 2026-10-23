import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { EntityWorld, Renderable, Transform, type RenderSync, type WorldLabels } from '@spark/engine';
import { DEFUSE_RADIUS, MissionRunner, type ObjectiveDef, type ObjectiveWorld } from '../src/mission/Objectives';

/**
 * The mission's spine: the objective kinds from `docs/design/mission-shape.md`
 * and the checkpoint that follows them. The runner draws one marker and owns
 * no player or enemy state, so a scene, an entity world, two stub sinks and a
 * stub world are the whole harness — no renderer.
 */

interface StubWorld extends ObjectiveWorld {
  hostilesAlive: number;
  /** Named targets by feet position; delete one to kill it. */
  readonly targets: Map<string, THREE.Vector3>;
  /** Live hostiles' feet, for the defuse test. */
  readonly hostiles: THREE.Vector3[];
}

function stubWorld(): StubWorld {
  const world: StubWorld = {
    hostilesAlive: 1,
    targets: new Map(),
    hostiles: [],
    targetPosition(name, out) {
      const at = world.targets.get(name);
      if (!at) return false;
      out.copy(at);
      return true;
    },
    hostileWithin(position, radius) {
      return world.hostiles.some((h) => Math.hypot(h.x - position.x, h.z - position.z) <= radius);
    },
  };
  return world;
}

function harness(objectives: readonly ObjectiveDef[], start = new THREE.Vector3(0, 0, 20)) {
  const entities = new EntityWorld({ capacity: 64 });
  const scene = new THREE.Scene();
  const labelText: string[] = [];
  const labels = {
    attach: () => true,
    detach: () => true,
    setText: (_eid: number, text: string) => labelText.push(text),
    setValue: () => {},
  } as unknown as WorldLabels;
  const renderSync = { attach: () => {} } as unknown as RenderSync;
  const runner = new MissionRunner({ entities, scene, labels, renderSync }, objectives, { position: start, yaw: 0 });
  const world = stubWorld();
  const at = new THREE.Vector3();
  return {
    runner,
    scene,
    entities,
    labelText,
    world,
    /** Stand at (x, z) for `seconds`, optionally holding interact, with `alive` hostiles left. */
    tick(x: number, z: number, seconds: number, interact = false, alive = 1): void {
      const dt = 1 / 60;
      at.set(x, 0, z);
      world.hostilesAlive = alive;
      for (let i = 0; i < Math.round(seconds / dt); i++) runner.fixedUpdate(dt, at, interact, world);
    },
    /** Event kinds since the last call. */
    events(): string[] {
      return runner.takeEvents().map((e) => `${e.kind}:${e.objective.id}`);
    },
  };
}

const reach: ObjectiveDef = { id: 'square', kind: 'reach', label: 'Reach the square', position: new THREE.Vector3(0, 0, -8), radius: 3 };
const plant: ObjectiveDef = { id: 'charge', kind: 'plant', label: 'Set the charge', position: new THREE.Vector3(0, 0, -66), radius: 2.2, holdSeconds: 3 };
const charge: ObjectiveDef = { ...plant, fuseSeconds: 10, defuseSeconds: 2 };
const clear: ObjectiveDef = { id: 'yard', kind: 'eliminate', label: 'Clear the yard', position: new THREE.Vector3(4, 0, -40), radius: 6 };
const broker: ObjectiveDef = { id: 'broker', kind: 'eliminate', label: 'Eliminate the broker', position: new THREE.Vector3(-4, 0, -36), radius: 4, target: 'Broker' };
const extract: ObjectiveDef = { id: 'extract', kind: 'extract', label: 'Extract at the insert', position: new THREE.Vector3(0, 0, 34), radius: 3 };

describe('MissionRunner', () => {
  it('starts on the first objective with the insertion checkpoint', () => {
    const h = harness([reach, plant, extract]);
    const s = h.runner.status();
    expect(s.objective?.id).toBe('square');
    expect(s.index).toBe(0);
    expect(s.total).toBe(3);
    expect(s.complete).toBe(false);
    expect(h.runner.checkpoint.position.z).toBe(20);
  });

  it('completes a reach objective on entering the volume, and not before', () => {
    const h = harness([reach, extract]);
    h.tick(0, -12, 1); // 4 m out, radius 3
    expect(h.runner.status().index).toBe(0);
    expect(h.runner.status().distance).toBeCloseTo(4, 5);
    expect(h.runner.status().inRange).toBe(false);
    h.tick(0, -10, 1 / 60);
    expect(h.runner.status().index).toBe(1);
    expect(h.events()).toEqual(['completed:square']);
  });

  it('moves the checkpoint to each completed objective', () => {
    const h = harness([reach, extract]);
    h.tick(0, -8, 1 / 60);
    expect(h.runner.checkpoint.position.z).toBe(-8);
    expect(h.runner.checkpoint.yaw).toBe(0);
  });

  it('holds a plant for its full duration, inside the volume, with the key down', () => {
    const h = harness([plant]);
    h.tick(0, -66, 2, true);
    expect(h.runner.status().progress).toBeCloseTo(2 / 3, 1);
    expect(h.runner.status().index).toBe(0);
    // Letting go bleeds the hold back at twice the rate.
    h.tick(0, -66, 0.5, false);
    expect(h.runner.status().progress).toBeLessThan(0.34);
    h.tick(0, -66, 3, true);
    expect(h.runner.status().index).toBe(1);
    expect(h.runner.status().complete).toBe(true);
  });

  it('does not count a plant held outside the volume', () => {
    const h = harness([plant]);
    h.tick(0, -60, 5, true); // 6 m out, radius 2.2
    expect(h.runner.status().progress).toBe(0);
    expect(h.runner.status().index).toBe(0);
  });

  it('arms a charge with a fuse instead of completing on the hold, and completes when it goes off', () => {
    const h = harness([charge, extract]);
    h.tick(0, -66, 3.1, true);
    let s = h.runner.status();
    expect(s.index).toBe(0);
    expect(s.phase).toBe('armed');
    expect(s.fuse).toBeGreaterThan(9.5);
    expect(h.runner.armedCharge?.id).toBe('charge');
    expect(h.events()).toEqual(['armed:charge']);
    // The player does not have to stand on it: the fuse burns wherever they are.
    h.tick(0, 10, 5);
    s = h.runner.status();
    expect(s.fuse).toBeLessThan(5.5);
    expect(s.index).toBe(0);
    h.tick(0, 10, 5.1);
    expect(h.runner.status().index).toBe(1);
    expect(h.events()).toEqual(['detonated:charge', 'completed:charge']);
    // The checkpoint is the plant site, not wherever the player stood when it blew.
    expect(h.runner.checkpoint.position.z).toBe(-66);
  });

  it('lets a hostile who stays at an armed charge defuse it, and the plant starts over', () => {
    const h = harness([charge]);
    h.tick(0, -66, 3.1, true);
    h.events();
    h.world.hostiles.push(new THREE.Vector3(DEFUSE_RADIUS - 0.2, 0, -66));
    h.tick(0, 10, 1);
    expect(h.runner.status().defuse).toBeCloseTo(0.5, 1);
    h.tick(0, 10, 1.1);
    const s = h.runner.status();
    expect(s.phase).toBe('hold');
    expect(s.progress).toBe(0);
    expect(s.fuse).toBe(0);
    expect(h.runner.armedCharge).toBeNull();
    expect(h.events()).toEqual(['defused:charge']);
  });

  it('bleeds defuse work off when the hostile is driven away', () => {
    const h = harness([charge]);
    h.tick(0, -66, 3.1, true);
    const man = new THREE.Vector3(0.5, 0, -66);
    h.world.hostiles.push(man);
    h.tick(0, 10, 1.5);
    expect(h.runner.status().defuse).toBeCloseTo(0.75, 1);
    man.set(10, 0, -66);
    h.tick(0, 10, 1.5);
    expect(h.runner.status().defuse).toBe(0);
    expect(h.runner.status().phase).toBe('armed');
  });

  it('completes an untagged eliminate objective only when the last hostile is down, wherever the player stands', () => {
    const h = harness([clear, extract]);
    h.tick(0, 20, 1, false, 3);
    expect(h.runner.status().index).toBe(0);
    h.tick(0, 20, 1, false, 1);
    expect(h.runner.status().index).toBe(0);
    h.tick(0, 20, 1 / 60, false, 0);
    expect(h.runner.status().index).toBe(1);
    expect(h.events()).toEqual(['completed:yard']);
  });

  it('completes a tagged eliminate when that target is down, whoever else is alive, and tracks it while it moves', () => {
    const h = harness([broker, extract]);
    const at = new THREE.Vector3(-4, 0, -36);
    h.world.targets.set('Broker', at);
    h.tick(0, -30, 1, false, 9);
    expect(h.runner.status().index).toBe(0);
    expect(h.runner.status().distance).toBeCloseTo(Math.hypot(4, 6), 5);
    at.set(4, 0, -36);
    h.tick(0, -30, 1 / 60, false, 9);
    expect(h.runner.status().distance).toBeCloseTo(Math.hypot(4, 6), 5);
    const t = h.entities.store(Transform);
    const markerX = [...Array(64).keys()].map((e) => t.x[e]).find((x) => x === 4);
    expect(markerX).toBe(4); // the marker went with him
    h.world.targets.delete('Broker');
    h.tick(0, -30, 1 / 60, false, 8);
    expect(h.runner.status().index).toBe(1);
    expect(h.events()).toEqual(['completed:broker']);
  });

  it('runs a whole mission and reports complete at extraction', () => {
    const h = harness([reach, broker, charge, extract]);
    h.world.targets.set('Broker', new THREE.Vector3(-4, 0, -36));
    h.tick(0, -8, 1 / 60, false, 9);
    h.world.targets.delete('Broker');
    h.tick(4, -40, 1 / 60, false, 8);
    h.tick(0, -66, 3.2, true, 8);
    expect(h.runner.status().phase).toBe('armed');
    h.tick(0, -40, 10.1, false, 8);
    expect(h.runner.status().complete).toBe(false);
    expect(h.runner.status().objective?.kind).toBe('extract');
    h.tick(0, 34, 1 / 60, false, 8);
    const s = h.runner.status();
    expect(s.complete).toBe(true);
    expect(s.objective).toBeNull();
    expect(s.index).toBe(4);
    expect(h.runner.checkpoint.position.z).toBe(34);
  });

  it('drops a part-finished plant on a checkpoint reload but keeps the objective', () => {
    const h = harness([plant]);
    h.tick(0, -66, 2, true);
    expect(h.runner.status().progress).toBeGreaterThan(0.5);
    h.runner.resetProgress();
    expect(h.runner.status().progress).toBe(0);
    expect(h.runner.status().objective?.id).toBe('charge');
  });

  it('loses a burning charge on a checkpoint reload', () => {
    const h = harness([charge]);
    h.tick(0, -66, 3.1, true);
    expect(h.runner.status().phase).toBe('armed');
    h.runner.resetProgress();
    expect(h.runner.status().phase).toBe('hold');
    expect(h.runner.armedCharge).toBeNull();
    expect(h.events()).toEqual([]);
  });

  it('restarts a finished mission from the first objective and the insert', () => {
    const h = harness([reach, extract]);
    h.tick(0, -8, 1 / 60);
    h.tick(0, 34, 1 / 60);
    expect(h.runner.status().complete).toBe(true);
    h.runner.restart();
    const s = h.runner.status();
    expect(s.complete).toBe(false);
    expect(s.index).toBe(0);
    expect(h.runner.checkpoint.position.z).toBe(20);
    expect(h.labelText.at(-1)).toBe('GO');
  });

  it('labels the marker by kind, and clears it when the mission ends', () => {
    const h = harness([reach, clear, broker, charge, extract]);
    h.world.targets.set('Broker', new THREE.Vector3(-4, 0, -36));
    expect(h.labelText[0]).toBe('GO');
    h.tick(0, -8, 1 / 60, false, 1);
    expect(h.labelText.at(-1)).toBe('CLEAR');
    h.tick(0, -8, 1 / 60, false, 0);
    expect(h.labelText.at(-1)).toBe('TARGET');
    h.world.targets.delete('Broker');
    h.tick(0, -8, 1 / 60, false, 0);
    expect(h.labelText.at(-1)).toBe('PLANT');
    h.tick(0, -66, 3.1, true, 0);
    expect(h.labelText.at(-1)).toBe('ARMED');
    h.tick(0, -66, 10.1, false, 0);
    expect(h.labelText.at(-1)).toBe('EXTRACT');
    h.tick(0, 34, 1 / 60, false, 0);
    expect(h.labelText.at(-1)).toBe('');
  });

  it('sizes the marker to each objective and hides it when the mission ends, through the entity', () => {
    // RenderSync writes visibility and scale from the components every frame;
    // whatever the runner sets on the Object3D itself is overwritten.
    const h = harness([reach, extract]);
    const t = h.entities.store(Transform);
    const r = h.entities.store(Renderable);
    const marker = [...Array(64).keys()].find((e) => t.sx[e] === reach.radius);
    expect(marker).toBeDefined();
    expect(r.visible[marker as number]).toBe(1);
    h.tick(0, -8, 1 / 60);
    expect(t.sx[marker as number]).toBe(extract.radius);
    h.tick(0, 34, 1 / 60);
    expect(r.visible[marker as number]).toBe(0);
    h.runner.restart();
    expect(r.visible[marker as number]).toBe(1);
  });

  it('releases its marker on dispose', () => {
    const h = harness([reach]);
    expect(h.scene.children).toHaveLength(1);
    const marker = h.scene.children[0] as THREE.Group;
    // Geometries and materials go with it; a runner that only removes the group leaks both.
    const owned: THREE.EventDispatcher[] = marker.children.flatMap((c) => [(c as THREE.Mesh).geometry, (c as THREE.Mesh).material as THREE.Material]);
    const disposed = new Set<THREE.EventDispatcher>();
    for (const o of owned) o.addEventListener('dispose', () => disposed.add(o));
    h.runner.dispose();
    expect(h.scene.children).toHaveLength(0);
    expect(disposed.size).toBe(owned.length);
  });
});
