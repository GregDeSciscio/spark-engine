import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { EntityWorld, type RenderSync, type WorldLabels } from '@spark/engine';
import { MissionRunner, type ObjectiveDef } from '../src/mission/Objectives';

/**
 * The mission's spine: the three objective kinds from
 * `docs/design/mission-shape.md` and the checkpoint that follows them. The
 * runner draws one marker and owns no player or enemy state, so a scene, an
 * entity world and two stub sinks are the whole harness — no renderer.
 */

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
  const at = new THREE.Vector3();
  return {
    runner,
    scene,
    entities,
    labelText,
    /** Stand at (x, z) for `seconds`, optionally holding interact, with `alive` hostiles left. */
    tick(x: number, z: number, seconds: number, interact = false, alive = 1): void {
      const dt = 1 / 60;
      at.set(x, 0, z);
      for (let i = 0; i < Math.round(seconds / dt); i++) runner.fixedUpdate(dt, at, interact, alive);
    },
  };
}

const reach: ObjectiveDef = { id: 'square', kind: 'reach', label: 'Reach the square', position: new THREE.Vector3(0, 0, -8), radius: 3 };
const plant: ObjectiveDef = { id: 'charge', kind: 'plant', label: 'Set the charge', position: new THREE.Vector3(0, 0, -66), radius: 2.2, holdSeconds: 3 };
const clear: ObjectiveDef = { id: 'yard', kind: 'eliminate', label: 'Clear the yard', position: new THREE.Vector3(4, 0, -40), radius: 6 };
const extract: ObjectiveDef = { id: 'extract', kind: 'reach', label: 'Return to extraction', position: new THREE.Vector3(0, 0, 34), radius: 3 };

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
    expect(h.runner.justCompleted?.id).toBe('square');
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

  it('completes an eliminate objective only when the last hostile is down, wherever the player stands', () => {
    const h = harness([clear, extract]);
    h.tick(0, 20, 1, false, 3);
    expect(h.runner.status().index).toBe(0);
    h.tick(0, 20, 1, false, 1);
    expect(h.runner.status().index).toBe(0);
    h.tick(0, 20, 1 / 60, false, 0);
    expect(h.runner.status().index).toBe(1);
    expect(h.runner.justCompleted?.kind).toBe('eliminate');
  });

  it('runs a whole mission and reports complete at extraction', () => {
    const h = harness([reach, clear, plant, extract]);
    h.tick(0, -8, 1 / 60, false, 2);
    h.tick(4, -40, 1 / 60, false, 0);
    h.tick(0, -66, 3.2, true, 0);
    expect(h.runner.status().complete).toBe(false);
    h.tick(0, 34, 1 / 60, false, 0);
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

  it('labels the marker by kind, and clears it when the mission ends', () => {
    const h = harness([reach, clear, plant]);
    expect(h.labelText[0]).toBe('GO');
    h.tick(0, -8, 1 / 60, false, 0);
    expect(h.labelText.at(-1)).toBe('CLEAR');
    h.tick(0, -8, 1 / 60, false, 0);
    expect(h.labelText.at(-1)).toBe('PLANT');
    h.tick(0, -66, 3.2, true, 0);
    expect(h.labelText.at(-1)).toBe('');
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
