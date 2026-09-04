import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { collectLevelNodes, parseLevelNodes, type LevelNode } from '../src/world/LevelLoader';

function node(partial: Partial<LevelNode> & { name: string }): LevelNode {
  return {
    path: `root/${partial.name}`,
    type: 'Object3D',
    spark: {},
    collision: partial.name.startsWith('COL_'),
    hasMesh: false,
    isLight: false,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    ...partial,
  };
}

describe('parseLevelNodes', () => {
  it('maps the hero-placeholder layout: spawn, prop, collision; ignores static geometry and budget-only extras', () => {
    const nodes: LevelNode[] = [
      node({ name: 'hero-placeholder', spark: { budget: 'hero' } }),
      node({ name: 'hero_body', type: 'Mesh', hasMesh: true, position: [0, 0.9, 0], halfExtents: [0.4, 0.9, 0.4] }),
      node({ name: 'COL_hero_capsule', type: 'Mesh', hasMesh: true, position: [0, 0.9, 0], halfExtents: [0.42, 0.92, 0.42] }),
      node({ name: 'spawn_point', position: [0, 0, 0.6], spark: { type: 'spawn', team: 'player' } }),
      node({ name: 'prop_anchor', position: [0.6, 1.4, 0], spark: { type: 'prop', prop: 'crate', scale: 0.25 } }),
    ];
    const out = parseLevelNodes(nodes);
    expect(out.map((d) => d.kind)).toEqual(['collider', 'spawn', 'prop']);
    const [collider, spawn, prop] = out;
    expect(collider).toMatchObject({ kind: 'collider', shape: 'trimesh', layer: 'world', halfExtents: [0.42, 0.92, 0.42] });
    expect(spawn).toMatchObject({ kind: 'spawn', team: 'player', index: 0 });
    expect(prop).toMatchObject({ kind: 'prop', prop: 'crate', scale: 0.25 });
    expect(spawn?.node.position).toEqual([0, 0, 0.6]);
  });

  it('handles triggers, lights, box colliders, defaults and unknown types', () => {
    const nodes: LevelNode[] = [
      node({ name: 'COL_floor', type: 'Mesh', hasMesh: true, halfExtents: [5, 0.1, 5], scale: [2, 1, 2], spark: { collider: 'box', layer: 'ground' } }),
      node({ name: 'exit', spark: { type: 'trigger', size: [4, 2, 1], event: 'exit' } }),
      node({ name: 'zone', spark: { type: 'trigger' }, scale: [3, 2, 1] }),
      node({ name: 'zone_mesh', type: 'Mesh', hasMesh: true, halfExtents: [1, 1, 1], scale: [2, 2, 2], spark: { type: 'trigger' } }),
      node({ name: 'lamp', spark: { type: 'light', color: '#ff8800', intensity: 40, range: 12 } }),
      node({ name: 'spot', spark: { type: 'light', spot: true, color: [1, 0, 0] } }),
      node({ name: 'Point', type: 'PointLight', isLight: true }),
      node({ name: 'spawn_b', spark: { type: 'spawn' } }),
      node({ name: 'spawn_c', spark: { type: 'spawn', team: 'enemy' } }),
      node({ name: 'thing', spark: { type: 'enemy', kind: 'grunt' } }),
      node({ name: 'plain', type: 'Mesh', hasMesh: true }),
    ];
    const out = parseLevelNodes(nodes);
    expect(out.map((d) => d.kind)).toEqual(['collider', 'trigger', 'trigger', 'trigger', 'light', 'light', 'light', 'spawn', 'spawn', 'unknown']);
    expect(out[0]).toMatchObject({ shape: 'box', layer: 'ground', halfExtents: [10, 0.1, 10] });
    expect(out[1]).toMatchObject({ id: 0, halfExtents: [2, 1, 0.5], event: 'exit' });
    expect(out[2]).toMatchObject({ id: 1, halfExtents: [1.5, 1, 0.5], event: null });
    expect(out[3]).toMatchObject({ id: 2, halfExtents: [2, 2, 2] });
    expect(out[4]).toMatchObject({ light: 'point', color: 0xff8800, intensity: 40, range: 12 });
    expect(out[5]).toMatchObject({ light: 'spot', color: 0xff0000, intensity: 10 });
    expect(out[6]).toMatchObject({ light: 'gltf' });
    expect(out[7]).toMatchObject({ team: 'default', index: 0 });
    expect(out[8]).toMatchObject({ team: 'enemy', index: 1 });
    expect(out[9]).toMatchObject({ kind: 'unknown', type: 'enemy' });
  });
});

describe('collectLevelNodes', () => {
  it('reads spark extras, COL_ names, lights and world transforms from a hierarchy', () => {
    const root = new THREE.Group();
    root.name = 'level';
    root.position.set(10, 0, 0);
    const empty = new THREE.Object3D();
    empty.name = 'spawn';
    empty.position.set(1, 0, 2);
    empty.userData['spark.type'] = 'spawn';
    empty.userData['spark.team'] = 'player';
    root.add(empty);
    const col = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
    col.name = 'COL_box';
    col.scale.set(2, 2, 2);
    root.add(col);
    const light = new THREE.PointLight();
    light.name = 'Point';
    root.add(light);
    const plain = new THREE.Mesh(new THREE.BoxGeometry());
    plain.name = 'wall';
    root.add(plain);
    const { nodes, objects } = collectLevelNodes(root);
    expect(nodes.map((n) => n.name)).toEqual(['spawn', 'COL_box', 'Point']);
    expect(objects[0]).toBe(empty);
    expect(nodes[0]).toMatchObject({ spark: { type: 'spawn', team: 'player' }, position: [11, 0, 2], collision: false, hasMesh: false });
    expect(nodes[1]).toMatchObject({ collision: true, hasMesh: true, halfExtents: [1, 2, 3], scale: [2, 2, 2], path: 'level/COL_box' });
    expect(nodes[2]).toMatchObject({ isLight: true, type: 'PointLight' });
    const descriptors = parseLevelNodes(nodes);
    expect(descriptors.map((d) => d.kind)).toEqual(['spawn', 'collider', 'light']);
    expect(descriptors[1]).toMatchObject({ halfExtents: [2, 4, 6] });
  });
});
