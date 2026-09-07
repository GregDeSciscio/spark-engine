import * as THREE from 'three/webgpu';
import {
  DisposeBag,
  LevelLoader,
  Navigation,
  SurfaceLibrary,
  createHeightFog,
  type AssetManager,
  type Entity,
  type EntityWorld,
  type LevelEntityDescriptor,
  type LightingSystem,
  type Logger,
  type PhysicsWorld,
  type QualitySettings,
  type RenderSync,
} from '@spark/engine';
import type { ObjectiveDef, ObjectiveKind } from '../mission/Objectives';
import type { ReinforcementPoint, ReinforcementWave } from '../mission/Alert';

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
  /** Where the sector sends hostiles in from once it is alerted (`mission/Alert.ts`). */
  readonly reinforcements: readonly ReinforcementPoint[];
  readonly objectives: readonly ObjectiveDef[];
  /** Baked offline for authored levels, at load for the blockout (ADR-009). */
  readonly navigation: Navigation;
  /** Authored particle sources: steam vents and the like (`spark.type=vfx`). */
  readonly vfx: readonly VfxSpot[];
  /** The level's local lights (neon), for volumetric cones and light meters. */
  readonly lights: readonly THREE.PointLight[];
  /** The playable extents, for fog volumes and rain. */
  readonly bounds: { readonly min: THREE.Vector3; readonly max: THREE.Vector3 };
  dispose(): void;
}

/** The street's playable box; both levels are built to it. */
export const STREET_BOUNDS = { min: new THREE.Vector3(-14, 0, -76), max: new THREE.Vector3(14, 12, 46) };

export interface VfxSpot {
  readonly preset: 'steam' | 'smoke' | 'embers';
  readonly position: THREE.Vector3;
  readonly direction: THREE.Vector3;
}

/** Night sky, moon, fog: the scene-level look every level shares until levels carry their own lighting rigs. */
export function applyAtmosphere(scene: THREE.Scene, quality: QualitySettings): { readonly moon: THREE.DirectionalLight; dispose(): void } {
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
    moon,
    dispose() {
      scene.remove(moon, moon.target, hemi);
      moon.dispose();
      hemi.dispose();
      scene.fogNode = null;
    },
  };
}

/** The CC0 prop kit (tools/asset-pipeline/fetch-polyhaven.mjs --kit=street), served from the app's models folder. */
export const PROP_KIT = [
  'fire_hydrant',
  'metal_trash_can',
  'trashbag',
  'barrel_03',
  'barrel_stove',
  'concrete_road_barrier',
  'old_tyre',
  'street_lamp_01',
  'utility_box_01',
  'water_manhole_cover',
  'cardboard_box_01',
  'plastic_crate_03',
  'power_box_01',
  'portable_generator',
] as const;

const PROP_URLS: Readonly<Record<string, string>> = Object.fromEntries(PROP_KIT.map((id) => [id, `/models/${id}.glb`]));

export interface StreetLevelDeps {
  readonly entities: EntityWorld;
  readonly physics: PhysicsWorld;
  readonly lighting: LightingSystem;
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
 * lights into entities; the gameplay-only types (objective, patrol, target,
 * reinforce, vfx) come back as `unknown` descriptors and are read here, the
 * one place the showcase interprets its own extras. The navmesh was baked by
 * the asset pipeline and sits beside the GLB.
 */
export async function loadStreetLevel(deps: StreetLevelDeps, url = '/levels/street.glb'): Promise<MissionLevel> {
  const { entities, physics, assets, renderSync, scene, logger, lighting } = deps;
  const bag = new DisposeBag();

  const navUrl = url.replace(/\.glb$/i, '.navmesh.bin');
  const [level, navBytes] = await Promise.all([
    new LevelLoader({ entities, assets, renderSync, scene, physics, props: PROP_URLS, teams: ['player'], castShadow: true, receiveShadow: true }).load(url),
    fetch(navUrl).then(async (r) => {
      if (!r.ok) throw new Error(`${navUrl}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    }),
  ]);
  bag.add(level);
  const navigation = Navigation.fromBytes(navBytes);
  bag.add(navigation);

  // The level's material names are surface names; swap in the procedural wet-city surfaces.
  const surfaces = new SurfaceLibrary();
  bag.add(surfaces);
  const surfaced = surfaces.applyTo(level.root);

  // Decals clip against the render twin of each collider: COL_<name> ↔ <name>.
  const meshes = new Map<Entity, THREE.Mesh>();
  let colliderIndex = 0;
  const objectives: (ObjectiveDef & { order: number })[] = [];
  const routes = new Map<string, { index: number; position: THREE.Vector3 }[]>();
  const reinforcements: (ReinforcementPoint & { order: number })[] = [];
  const targets: { index: number; position: THREE.Vector3 }[] = [];
  const vfx: VfxSpot[] = [];
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
      case 'reinforce': {
        // `wave` says which alert tier calls this ingress in; `route` is the
        // patrol the arrival adopts once its sweep runs out.
        const wave = str(s.wave, 'alerted') === 'lockdown' ? 'lockdown' : ('alerted' as ReinforcementWave);
        const route = s.route === undefined ? null : str(s.route, '');
        reinforcements.push({
          id: str(s.id, d.node.name),
          wave,
          position: positionOf(d),
          route: route === '' ? null : route,
          order: num(s.index, reinforcements.length),
        });
        break;
      }
      case 'target':
        targets.push({ index: num(s.index, targets.length), position: positionOf(d) });
        break;
      case 'vfx': {
        const preset = str(s.preset, 'steam');
        if (preset === 'steam' || preset === 'smoke' || preset === 'embers') {
          vfx.push({ preset, position: positionOf(d), direction: new THREE.Vector3(num(s.dx, 0), num(s.dy, 1), num(s.dz, 0)) });
        }
        break;
      }
      default:
        logger.warn(`street: unknown spark.type "${d.type}" on ${d.node.path}`);
    }
  }

  const spawnPoint = level.spawn('player');
  if (!spawnPoint) throw new Error('street: no spark.type=spawn with team=player');
  const lights: THREE.PointLight[] = [];
  for (const eid of level.lights) {
    const light = lighting.lights.get(eid) as THREE.PointLight | undefined;
    if (light?.isPointLight) lights.push(light);
  }
  objectives.sort((a, b) => a.order - b.order);
  const patrols: PatrolSpec[] = [...routes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, points]) => ({ name, route: points.sort((a, b) => a.index - b.index).map((p) => p.position) }));
  targets.sort((a, b) => a.index - b.index);
  reinforcements.sort((a, b) => a.order - b.order);

  const stats = navigation.stats();
  logger.info(
    `street: ${level.entities.length} entities, ${level.colliders.length} colliders (${meshes.size} with render twins), ${level.lights.length} lights, ${level.props.length} props, ${surfaced} surfaced meshes, ${vfx.length} vfx spots, ${objectives.length} objectives, ${patrols.length} patrols, ${reinforcements.length} ingress points, navmesh ${stats.polys} polys`,
  );

  return {
    spawn: new THREE.Vector3(spawnPoint.x, spawnPoint.y, spawnPoint.z),
    spawnYaw,
    meshes,
    targetSpots: targets.map((t) => ({ position: t.position, yaw: 0 })),
    patrols,
    reinforcements: reinforcements.map(({ order: _order, ...r }) => r),
    objectives: objectives.map(({ order: _order, ...o }) => o),
    navigation,
    vfx,
    lights,
    bounds: STREET_BOUNDS,
    dispose: () => bag.dispose(),
  };
}
