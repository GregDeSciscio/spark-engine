import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { dropTinyShadowCasters } from '../src/world/LevelLoader';

/**
 * A bolt or a cable clip costs a draw in the shadow pass for a shadow nobody
 * can resolve. The rule has to read size *in the world*, not in the model:
 * levels place the same kit piece at wildly different scales.
 */

function mesh(name: string, radius: number, scale = 1): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 4, 2), new THREE.MeshBasicMaterial());
  m.name = name;
  m.castShadow = true;
  m.scale.setScalar(scale);
  return m;
}

function sceneWith(...objects: THREE.Object3D[]): THREE.Object3D {
  const root = new THREE.Object3D();
  root.add(...objects);
  return root;
}

const casting = (root: THREE.Object3D): string[] => {
  const names: string[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.castShadow) names.push(o.name);
  });
  return names.sort();
};

describe('dropTinyShadowCasters', () => {
  it('drops the small ones and keeps the rest', () => {
    const root = sceneWith(mesh('bolt', 0.05), mesh('crate', 0.8), mesh('handle', 0.2), mesh('building', 6));
    expect(dropTinyShadowCasters(root, 0.35)).toBe(2);
    expect(casting(root)).toEqual(['building', 'crate']);
  });

  it('measures in the world, so scale decides', () => {
    // The same geometry, placed twice at different scales: the big placement
    // keeps its shadow and the small one loses it.
    const root = sceneWith(mesh('scaled_up', 0.1, 10), mesh('scaled_down', 2, 0.05));
    expect(dropTinyShadowCasters(root, 0.35)).toBe(1);
    expect(casting(root)).toEqual(['scaled_up']);
  });

  it('inherits scale from parents', () => {
    const group = new THREE.Group();
    group.scale.setScalar(0.02);
    group.add(mesh('shrunk_by_parent', 5));
    expect(dropTinyShadowCasters(sceneWith(group), 0.35)).toBe(1);
  });

  it('is a no-op at zero or below', () => {
    const root = sceneWith(mesh('bolt', 0.05));
    expect(dropTinyShadowCasters(root, 0)).toBe(0);
    expect(dropTinyShadowCasters(root, -1)).toBe(0);
    expect(casting(root)).toEqual(['bolt']);
  });

  it('does not count meshes that were not casting anyway', () => {
    const off = mesh('already_off', 0.05);
    off.castShadow = false;
    expect(dropTinyShadowCasters(sceneWith(off, mesh('bolt', 0.05)), 0.35)).toBe(1);
  });

  it('leaves anything that is not a mesh alone', () => {
    const light = new THREE.PointLight();
    light.castShadow = true;
    light.name = 'lamp';
    const root = sceneWith(light, mesh('bolt', 0.05));
    expect(dropTinyShadowCasters(root, 0.35)).toBe(1);
    expect(light.castShadow).toBe(true);
  });

  it('computes a bounding sphere when the geometry has none', () => {
    const m = mesh('fresh', 0.1);
    m.geometry.boundingSphere = null;
    expect(dropTinyShadowCasters(sceneWith(m), 0.35)).toBe(1);
    expect(m.geometry.boundingSphere).not.toBeNull();
  });

  it('cuts where the threshold says, either side of it', () => {
    // Not tested exactly on the boundary: a tessellated sphere's computed
    // bounding radius lands a float's breadth off its nominal one, and a test
    // that turns on that is testing arithmetic, not the rule.
    const root = sceneWith(mesh('just_over', 0.4), mesh('just_under', 0.3));
    expect(dropTinyShadowCasters(root, 0.35)).toBe(1);
    expect(casting(root)).toEqual(['just_over']);
  });
});
