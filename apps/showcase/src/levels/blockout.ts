import * as THREE from 'three/webgpu';
import { DisposeBag, Navigation, SurfaceLibrary, Transform, TriangleSoup, type Entity, type EntityWorld, type PhysicsWorld, type Random } from '@spark/engine';
import type { ObjectiveDef } from '../mission/Objectives';
import type { MissionLevel } from './MissionLevel';

/**
 * A grey-box night street built in code: the fallback level (`?level=blockout`)
 * and the reference the Blender-authored street (tools/level-authoring/street.py)
 * was drawn from. Two rows of building slabs, crates and low walls for cover,
 * neon on the facades. Everything is seeded so the same seed gives the same
 * street. Bakes its own navmesh at load; call `initNavigation()` first.
 */

const STREET_HALF_WIDTH = 9;
const STREET_Z_MIN = -70;
const STREET_Z_MAX = 40;
const SIDEWALK = 2.5;
const NEON_COLORS = [0xff2bd6, 0x22e8ff, 0xff7a1a, 0x4dff6a, 0xff3d5a, 0x3d7bff, 0xffd23d, 0xb14dff] as const;

interface Box {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}

export function buildBlockout(scene: THREE.Scene, entities: EntityWorld, physics: PhysicsWorld, random: Random): MissionLevel {
  const bag = new DisposeBag();
  const spawned: Entity[] = [];
  const meshes = new Map<Entity, THREE.Mesh>();
  const navSoup = new TriangleSoup();
  bag.add(() => {
    for (const eid of spawned) entities.destroy(eid);
  });

  // ---- shared geometry and materials ----------------------------------------
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const surfaces = new SurfaceLibrary();
  bag.add(surfaces);
  const asphalt = surfaces.get('asphalt');
  const sidewalk = surfaces.get('concrete');
  const facade = surfaces.get('brick');
  const crate = surfaces.get('metal', { color: 0x3a3f4a, roughness: 0.55, metalness: 0.35 });
  const barrier = surfaces.get('metal', { color: 0x4a3a2a, roughness: 0.6, metalness: 0.2 });
  bag.add(() => unitBox.dispose());

  physics.layers.define('world', 'player', 'target', 'enemy');

  const addBox = (box: Box, material: THREE.Material, options: { shadow?: boolean; body?: boolean } = {}): THREE.Mesh => {
    const mesh = new THREE.Mesh(unitBox, material);
    mesh.position.set(box.x, box.y, box.z);
    mesh.scale.set(box.hx * 2, box.hy * 2, box.hz * 2);
    mesh.castShadow = options.shadow ?? true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (options.body ?? true) {
      const eid = entities.create([Transform, { x: box.x, y: box.y, z: box.z }]);
      physics.addBody(eid, { type: 'fixed', shape: { kind: 'box', hx: box.hx, hy: box.hy, hz: box.hz }, layer: 'world', friction: 0.8, events: false });
      spawned.push(eid);
      meshes.set(eid, mesh);
      navSoup.addBox(box.x, box.y, box.z, box.hx, box.hy, box.hz);
    }
    return mesh;
  };

  // ---- ground: street and raised sidewalks -------------------------------------
  const length = STREET_Z_MAX - STREET_Z_MIN;
  const zMid = (STREET_Z_MAX + STREET_Z_MIN) / 2;
  addBox({ x: 0, y: -0.5, z: zMid, hx: 80, hy: 0.5, hz: 100 }, asphalt, { shadow: false });
  for (const side of [-1, 1] as const) {
    const x = side * (STREET_HALF_WIDTH + SIDEWALK / 2);
    addBox({ x, y: 0.075, z: zMid, hx: SIDEWALK / 2, hy: 0.075, hz: length / 2 }, sidewalk, { shadow: false });
  }

  // ---- buildings: slabs along both sides, gaps for alleys ------------------------
  const neonLights: THREE.PointLight[] = [];
  let neonIndex = 0;
  for (const side of [-1, 1] as const) {
    let z = STREET_Z_MIN;
    while (z < STREET_Z_MAX) {
      const depth = random.range(8, 16);
      const height = random.range(9, 24);
      const setback = random.range(0, 1.5);
      const x = side * (STREET_HALF_WIDTH + SIDEWALK + depth / 2 + setback);
      addBox({ x, y: height / 2, z: z + depth / 2, hx: depth / 2, hy: height / 2, hz: depth / 2 }, facade);
      // A neon sign on the street face of most buildings.
      if (random.next() < 0.55) {
        const color = NEON_COLORS[neonIndex++ % NEON_COLORS.length] as number;
        const signY = random.range(3, Math.min(height - 1, 9));
        const sign = new THREE.Mesh(unitBox, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.5, roughness: 0.4 }));
        const faceX = side * (STREET_HALF_WIDTH + SIDEWALK + setback);
        sign.position.set(faceX - side * 0.12, signY, z + depth / 2);
        sign.scale.set(0.2, random.range(0.6, 1.4), random.range(1.6, 3.2));
        scene.add(sign);
        bag.add(() => (sign.material as THREE.Material).dispose());
        const light = new THREE.PointLight(color, 22, 8, 2);
        light.position.set(faceX - side * 0.6, signY, z + depth / 2);
        scene.add(light);
        neonLights.push(light);
      }
      z += depth + random.range(1.5, 4);
    }
  }

  // ---- cover: crates and low barriers in the street ------------------------------
  for (let i = 0; i < 22; i++) {
    const big = random.next() < 0.4;
    const hx = big ? 1 : 0.5;
    const hy = 0.5;
    const hz = big ? 0.5 : 0.5;
    const x = random.range(-STREET_HALF_WIDTH + 1.5, STREET_HALF_WIDTH - 1.5);
    const z = random.range(STREET_Z_MIN + 6, STREET_Z_MAX - 12);
    addBox({ x, y: hy, z, hx, hy, hz }, crate);
    if (big && random.next() < 0.5) addBox({ x, y: 2 * hy + hy, z, hx: 0.5, hy, hz: 0.5 }, crate);
  }
  for (let i = 0; i < 6; i++) {
    const x = random.range(-STREET_HALF_WIDTH + 2, STREET_HALF_WIDTH - 2);
    const z = random.range(STREET_Z_MIN + 10, STREET_Z_MAX - 16);
    addBox({ x, y: 0.4, z, hx: 1.6, hy: 0.4, hz: 0.18 }, barrier);
  }

  // ---- far end: a wall so the street reads as enclosed ------------------------
  addBox({ x: 0, y: 6, z: STREET_Z_MIN - 1, hx: STREET_HALF_WIDTH + SIDEWALK + 2, hy: 6, hz: 1 }, facade);
  addBox({ x: 0, y: 6, z: STREET_Z_MAX + 1, hx: STREET_HALF_WIDTH + SIDEWALK + 2, hy: 6, hz: 1 }, facade);

  bag.add(() => {
    for (const light of neonLights) {
      scene.remove(light);
      light.dispose();
    }
  });

  const navigation = Navigation.bake(navSoup.positions, navSoup.indices);
  bag.add(navigation);

  // Range targets on the right sidewalk near the spawn, out of the patrol lanes.
  const targetSpots = [
    { position: new THREE.Vector3(9.5, 0.15, 24), yaw: 0 },
    { position: new THREE.Vector3(9.5, 0.15, 16), yaw: 0 },
  ];
  // Three riflemen: one close, two deeper in, each on a short loop.
  const patrols = [
    { name: 'Rifleman 1', route: [new THREE.Vector3(5, 0, -4), new THREE.Vector3(-2, 0, -12), new THREE.Vector3(-4, 0, 6)] },
    { name: 'Rifleman 2', route: [new THREE.Vector3(4, 0, -24), new THREE.Vector3(-5, 0, -34)] },
    { name: 'Rifleman 3', route: [new THREE.Vector3(0, 0, -52), new THREE.Vector3(6, 0, -42), new THREE.Vector3(-6, 0, -44)] },
  ];

  // Insert at the near end, cross the street, set the charge at the far wall, come back out.
  const objectives: ObjectiveDef[] = [
    { id: 'square', kind: 'reach', label: 'Reach the square', position: new THREE.Vector3(0, 0, -8), radius: 3 },
    { id: 'charge', kind: 'plant', label: 'Set the charge on the depot wall', position: new THREE.Vector3(0, 0, STREET_Z_MIN + 4), radius: 2.2, holdSeconds: 3 },
    { id: 'extract', kind: 'reach', label: 'Return to extraction', position: new THREE.Vector3(0, 0, STREET_Z_MAX - 6), radius: 3 },
  ];

  return {
    spawn: new THREE.Vector3(0, 0, STREET_Z_MAX - 6),
    spawnYaw: 0,
    meshes,
    targetSpots,
    patrols,
    objectives,
    navigation,
    vfx: [],
    dispose: () => bag.dispose(),
  };
}
