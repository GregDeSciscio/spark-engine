import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { SURFACE_NAMES, SurfaceLibrary, createSurface, isSurfaceName } from '../src/rendering/Surfaces';

describe('createSurface', () => {
  it('builds every surface as a node material with a colour graph', () => {
    for (const name of SURFACE_NAMES) {
      const m = createSurface(name);
      expect(m.isNodeMaterial).toBe(true);
      expect(m.name).toBe(`surface:${name}`);
      expect(m.colorNode).not.toBeNull();
      m.dispose();
    }
    expect(isSurfaceName('brick')).toBe(true);
    expect(isSurfaceName('velvet')).toBe(false);
  });
});

describe('SurfaceLibrary', () => {
  function level(): THREE.Group {
    const root = new THREE.Group();
    const geo = new THREE.BoxGeometry();
    const named = (name: string, hex = 0x808080): THREE.Mesh => {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name, color: hex }));
      root.add(m);
      return m;
    };
    named('brick');
    named('brick');
    named('asphalt');
    named('metal', 0xff0000);
    named('metal', 0x00ff00);
    named('paint');
    const tagged = named('paint');
    tagged.userData['spark.surface'] = 'concrete';
    return root;
  }

  it('swaps by material name and by spark.surface extra, sharing instances', () => {
    const lib = new SurfaceLibrary();
    const root = level();
    const changed = lib.applyTo(root);
    expect(changed).toBe(6);
    const meshes = root.children as THREE.Mesh[];
    expect((meshes[0]?.material as THREE.Material).name).toBe('surface:brick');
    expect(meshes[0]?.material).toBe(meshes[1]?.material);
    expect((meshes[2]?.material as THREE.Material).name).toBe('surface:asphalt');
    // Tinted surfaces get one instance per colour.
    expect(meshes[3]?.material).not.toBe(meshes[4]?.material);
    expect((meshes[3]?.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
    // A plain material with no surface name is left alone; the extra wins over the name.
    expect((meshes[5]?.material as THREE.Material).name).toBe('paint');
    expect((meshes[6]?.material as THREE.Material).name).toBe('surface:concrete');
    expect(lib.size).toBe(5);
    lib.dispose();
  });

  it('honours an explicit mapping', () => {
    const lib = new SurfaceLibrary();
    const root = level();
    lib.applyTo(root, { paint: 'metal' });
    const meshes = root.children as THREE.Mesh[];
    expect((meshes[5]?.material as THREE.Material).name).toBe('surface:metal');
    expect((meshes[0]?.material as THREE.Material).name).toBe('brick');
    lib.dispose();
  });
});
