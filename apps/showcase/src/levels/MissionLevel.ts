import * as THREE from 'three/webgpu';
import {
  DisposeBag,
  LevelLoader,
  Navigation,
  createHeightFog,
  type AssetManager,
  type Entity,
  type EntityWorld,
  type LevelEntityDescriptor,
  type Logger,
  type PhysicsWorld,
  type QualitySettings,
  type RenderSync,
} from '@spark/engine';
import type { ObjectiveDef, ObjectiveKind } from '../mission/Objectives';

/**
 * What the mission scene needs from a level, however it was made: the
 * procedural blockout and the Blender-authored street both produce one.
 */
export interface PatrolSpec {
  readonly name: string;
  /** Feet positions; the first is the spawn. */
  readonly route: readonly THREE.Vector3[];
}

export interface MissionLevel {
  /** Where the operator starts, feet on the ground. */
  readonly spawn: THREE.Vector3;
  /** Camera yaw at spawn. 0 looks down -Z. */
  readonly spawnYaw: number;
  /** Level meshes by physics entity, so hits can clip decals to what they struck. */
  readonly meshes: ReadonlyMap<Entity, THREE.Mesh>;
  readonly targetSpots: readonly { readonly position: THREE.Vector3; readonly yaw: number }[];
  readonly patrols: readonly PatrolSpec[];
  readonly objectives: readonly ObjectiveDef[];
  /** Baked offline for authored levels, at load for the blockout (ADR-009). */
  readonly navigation: Navigation;
  dispose(): void;
}

/** Night sky, moon, fog: the scene-level look every level shares until levels carry their own lighting rigs. */
export function applyAtmosphere(scene: THREE.Scene, quality: QualitySettings): { dispose(): void } {
  scene.background = new THREE.Color(0x05060a);
  // Fog reaches full opacity around 120 m: the level's own sightline limit (ADR-004).
  const fog = createHeightFog({ color: 0x0a0e1c, density: 0.014, groundY: 0, falloff: 5, groundBoost: 1.0 });
  scene.fogNode = fog.node;

  const moon = new THREE.DirectionalLight(0x6f88d0, 2.2);
  moon.position.set(-18, 40, -10);
  moon.target.position.set(0, 0, -20);
  moon.castShadow = quality.shadows;
  moon.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  moon.shadow.camera.near = 5;
  moon.shadow.camera.far = 120;
  moon.shadow.camera.left = -40;
  moon.shadow.camera.right = 40;
  moon.shadow.camera.top = 60;
  moon.shadow.camera.bottom = -60;
  moon.shadow.bias = -0.0006;
  moon.shadow.normalBias = 0.04;
  const hemi = new THREE.HemisphereLight(0x2a3a66, 0x0e0b08, 1.4);
  scene.add(moon, moon.target, hemi);
  return {
    dispose() {
      scene.remove(moon, moon.target, hemi);
      moon.dispose();
      hemi.dispose();
      scene.fogNode = null;
    },
  };
}

export interface StreetLevelDeps {
  readonly entities: EntityWorld;
  readonly physics: PhysicsWorld;
  readonly assets: AssetManager;
  readonly renderSync: RenderSync;
  readonly scene: THREE.Scene;
  readonly logger: Logger;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * The Blender-authored level (tools/level-authoring/street.py) through the
 * engine's level loader (ADR-008). The loader turns COL_ nodes, spawns and
 * lights into entities; the gameplay-only types (objective, patrol, target)
 * come back as `unknown` descriptors and are read here, the one place the
 * showcase interprets its own extras. The navmesh was baked by the asset
 * pipeline and sits beside the GLB.
 */
export async function loadStreetLevel(deps: StreetLevelDeps, url = '/levels/street.glb'): Promise<MissionLevel> {
  const { entities, physics, assets, renderSync, scene, logger } = deps;
  const bag = new DisposeBag();

  const navUrl = url.replace(/\.glb$/i, '.navmesh.bin');
  const [level, navBytes] = await Promise.all([
    new LevelLoader({ entities, assets, renderSync, scene, physics, teams: ['player'], castShadow: true, receiveShadow: true }).load(url),
    fetch(navUrl).then(async (r) => {
      if (!r.ok) throw new Error(`${navUrl}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    }),
  ]);
  bag.add(level);
  const navigation = Navigation.fromBytes(navBytes);
  bag.add(navigation);

  // Decals clip against the render twin of each collider: COL_<name> ↔ <name>.
  const meshes = new Map<Entity, THREE.Mesh>();
  let colliderIndex = 0;
  const objectives: (ObjectiveDef & { order: number })[] = [];
  const routes = new Map<string, { index: number; position: THREE.Vector3 }[]>();
  const targets: { index: number; position: THREE.Vector3 }[] = [];
  let spawnYaw = 0;
  const positionOf = (d: LevelEntityDescriptor): THREE.Vector3 => new THREE.Vector3(d.node.position[0], d.node.position[1], d.node.position[2]);

  for (const d of level.descriptors) {
    if (d.kind === 'collider') {
      const eid = level.colliders[colliderIndex++];
      const twin = eid !== undefined ? level.renderTwin(eid) : null;
      if (eid !== undefined && twin) meshes.set(eid, twin);
      continue;
    }
    if (d.kind === 'spawn') {
      spawnYaw = num(d.node.spark.yaw, 0);
      continue;
    }
    if (d.kind !== 'unknown') continue;
    const s = d.node.spark;
    switch (d.type) {
      case 'objective': {
        const kind = str(s.kind, 'reach') as ObjectiveKind;
        objectives.push({
          id: str(s.id, d.node.name),
          kind,
          label: str(s.label, d.node.name),
          position: positionOf(d),
          radius: num(s.radius, 3),
          holdSeconds: num(s.hold, 3),
          order: num(s.order, objectives.length),
        });
        break;
      }
      case 'patrol': {
        const route = str(s.route, 'patrol');
        const list = routes.get(route) ?? [];
        list.push({ index: num(s.index, list.length), position: positionOf(d) });
        routes.set(route, list);
        break;
      }
      case 'target':
        targets.push({ index: num(s.index, targets.length), position: positionOf(d) });
        break;
      default:
        logger.warn(`street: unknown spark.type "${d.type}" on ${d.node.path}`);
    }
  }

  const spawnPoint = level.spawn('player');
  if (!spawnPoint) throw new Error('street: no spark.type=spawn with team=player');
  objectives.sort((a, b) => a.order - b.order);
  const patrols: PatrolSpec[] = [...routes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, points]) => ({ name, route: points.sort((a, b) => a.index - b.index).map((p) => p.position) }));
  targets.sort((a, b) => a.index - b.index);

  const stats = navigation.stats();
  logger.info(
    `street: ${level.entities.length} entities, ${level.colliders.length} colliders (${meshes.size} with render twins), ${level.lights.length} lights, ${objectives.length} objectives, ${patrols.length} patrols, navmesh ${stats.polys} polys`,
  );

  return {
    spawn: new THREE.Vector3(spawnPoint.x, spawnPoint.y, spawnPoint.z),
    spawnYaw,
    meshes,
    targetSpots: targets.map((t) => ({ position: t.position, yaw: 0 })),
    patrols,
    objectives: objectives.map(({ order: _order, ...o }) => o),
    navigation,
    dispose: () => bag.dispose(),
  };
}
