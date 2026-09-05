import * as THREE from 'three/webgpu';
import type { AssetManager } from '../assets/AssetManager';
import { COLLISION_PREFIX, type ModelAsset } from '../assets/ModelAsset';
import type { Disposable } from '../core/Disposable';
import { Logger } from '../core/Logger';
import { Renderable, Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import type { RenderSync } from '../ecs/systems/RenderSync';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { SpawnPoint, TriggerVolume } from './components';

// ---- pure part: glTF nodes → entity descriptors (ADR-008) ---------------------

/** A glTF node as the loader sees it: extras plus its world-space transform. Built by `collectLevelNodes`. */
export interface LevelNode {
  readonly name: string;
  /** Slash-separated path from the level root. */
  readonly path: string;
  /** three object type: 'Mesh', 'Object3D', 'PointLight', ... */
  readonly type: string;
  /** `spark.*` extras with the prefix stripped. */
  readonly spark: Readonly<Record<string, unknown>>;
  /** Name starts with `COL_`. */
  readonly collision: boolean;
  readonly hasMesh: boolean;
  /** A glTF light (KHR_lights_punctual) three already instantiated. */
  readonly isLight: boolean;
  readonly position: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  /** Local (unscaled) bounding-box half extents of the mesh, if any. */
  readonly halfExtents?: readonly [number, number, number] | undefined;
}

export type LevelEntityDescriptor =
  | { readonly kind: 'spawn'; readonly node: LevelNode; readonly team: string; readonly index: number }
  | {
      readonly kind: 'prop';
      readonly node: LevelNode;
      /** Prop-library name from `spark.prop`, resolved through the loader's `props` map. Null = the node's own mesh. */
      readonly prop: string | null;
      /** Extra uniform scale from `spark.scale`. */
      readonly scale: number;
    }
  | {
      readonly kind: 'trigger';
      readonly node: LevelNode;
      readonly id: number;
      /** World-space box half extents. */
      readonly halfExtents: readonly [number, number, number];
      /** `spark.event`, the name gameplay listens for. */
      readonly event: string | null;
    }
  | {
      readonly kind: 'light';
      readonly node: LevelNode;
      /** `'gltf'` keeps the light three already built; the others create one from `spark.*`. */
      readonly light: 'gltf' | 'point' | 'spot';
      readonly color: number;
      readonly intensity: number;
      readonly range: number;
    }
  | {
      readonly kind: 'collider';
      readonly node: LevelNode;
      readonly shape: 'trimesh' | 'box';
      readonly layer: string;
      /** World-space half extents for `box`. */
      readonly halfExtents: readonly [number, number, number];
    }
  | { readonly kind: 'unknown'; readonly node: LevelNode; readonly type: string };

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asVec3(value: unknown): readonly [number, number, number] | null {
  if (typeof value === 'number') return [value, value, value];
  if (Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number')) {
    return [value[0] as number, value[1] as number, value[2] as number];
  }
  return null;
}

function colorOf(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value >>> 0;
  if (typeof value === 'string') {
    const hex = value.startsWith('#') ? value.slice(1) : value.startsWith('0x') ? value.slice(2) : value;
    const parsed = parseInt(hex, 16);
    if (Number.isFinite(parsed)) return parsed >>> 0;
  }
  if (Array.isArray(value) && value.length >= 3) {
    const [r, g, b] = value as number[];
    return ((Math.round((r ?? 0) * 255) << 16) | (Math.round((g ?? 0) * 255) << 8) | Math.round((b ?? 0) * 255)) >>> 0;
  }
  return fallback;
}

/**
 * The only place glTF extras become gameplay (ADR-008). Pure: nodes in, entity
 * descriptors out, in node order. Nodes without a `spark.type` and without the
 * `COL_` prefix are static geometry and produce nothing.
 */
export function parseLevelNodes(nodes: readonly LevelNode[]): LevelEntityDescriptor[] {
  const out: LevelEntityDescriptor[] = [];
  let spawnIndex = 0;
  let triggerId = 0;
  for (const node of nodes) {
    const s = node.spark;
    if (node.collision) {
      const shape = s.collider === 'box' ? 'box' : 'trimesh';
      const he = node.halfExtents ?? [0.5, 0.5, 0.5];
      out.push({
        kind: 'collider',
        node,
        shape,
        layer: asString(s.layer) ?? 'world',
        halfExtents: [he[0] * node.scale[0], he[1] * node.scale[1], he[2] * node.scale[2]],
      });
      continue;
    }
    const type = asString(s.type);
    if (type === null) {
      if (node.isLight) {
        out.push({ kind: 'light', node, light: 'gltf', color: 0xffffff, intensity: 1, range: 0 });
      }
      continue;
    }
    switch (type) {
      case 'spawn':
        out.push({ kind: 'spawn', node, team: asString(s.team) ?? 'default', index: spawnIndex++ });
        break;
      case 'prop':
        out.push({ kind: 'prop', node, prop: asString(s.prop), scale: asNumber(s.scale, 1) });
        break;
      case 'trigger': {
        const size = asVec3(s.size);
        const he = node.halfExtents;
        const halfExtents: readonly [number, number, number] = size
          ? [size[0] / 2, size[1] / 2, size[2] / 2]
          : he
            ? [he[0] * node.scale[0], he[1] * node.scale[1], he[2] * node.scale[2]]
            : [node.scale[0] / 2, node.scale[1] / 2, node.scale[2] / 2];
        out.push({ kind: 'trigger', node, id: triggerId++, halfExtents, event: asString(s.event) });
        break;
      }
      case 'light':
      case 'light_hero':
        out.push({
          kind: 'light',
          node,
          light: node.isLight ? 'gltf' : s.spot === true || s.light === 'spot' ? 'spot' : 'point',
          color: colorOf(s.color, 0xffffff),
          intensity: asNumber(s.intensity, 10),
          range: asNumber(s.range, 0),
        });
        break;
      default:
        out.push({ kind: 'unknown', node, type });
    }
  }
  return out;
}

// ---- three-dependent part --------------------------------------------------------

const SPARK_PREFIX = 'spark.';
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _inverse = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Read every node of an instantiated level into `LevelNode`s (world-space transforms). */
export function collectLevelNodes(root: THREE.Object3D): { nodes: LevelNode[]; objects: THREE.Object3D[] } {
  root.updateMatrixWorld(true);
  const nodes: LevelNode[] = [];
  const objects: THREE.Object3D[] = [];
  const visit = (object: THREE.Object3D, path: string): void => {
    const spark: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(object.userData as Record<string, unknown>)) {
      if (key.startsWith(SPARK_PREFIX)) spark[key.slice(SPARK_PREFIX.length)] = value;
    }
    const mesh = object as THREE.Mesh;
    const hasMesh = mesh.isMesh === true;
    const collision = object.name.startsWith(COLLISION_PREFIX);
    const light = (object as THREE.Light).isLight === true;
    if (Object.keys(spark).length > 0 || collision || light) {
      object.matrixWorld.decompose(_position, _quaternion, _scale);
      let halfExtents: [number, number, number] | undefined;
      if (hasMesh) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox;
        if (box) halfExtents = [(box.max.x - box.min.x) / 2, (box.max.y - box.min.y) / 2, (box.max.z - box.min.z) / 2];
      }
      nodes.push({
        name: object.name,
        path,
        type: object.type,
        spark,
        collision,
        hasMesh,
        isLight: light,
        position: [_position.x, _position.y, _position.z],
        quaternion: [_quaternion.x, _quaternion.y, _quaternion.z, _quaternion.w],
        scale: [_scale.x, _scale.y, _scale.z],
        halfExtents,
      });
      objects.push(object);
    }
    for (const child of object.children) visit(child, `${path}/${child.name || child.type}`);
  };
  visit(root, root.name || 'root');
  return { nodes, objects };
}

export interface LevelPlacement {
  position?: readonly [number, number, number] | undefined;
  /** Yaw around Y in radians. */
  yaw?: number | undefined;
  scale?: number | undefined;
}

export interface LevelLoaderOptions {
  entities: EntityWorld;
  assets: AssetManager;
  renderSync: RenderSync;
  /** Where the level root and prop instances are added. */
  scene: THREE.Object3D;
  /** Colliders and triggers need physics; without it they become plain entities. */
  physics?: PhysicsWorld | undefined;
  /** Prop library: `spark.prop` name → model URL, loaded through the asset manager. */
  props?: Readonly<Record<string, string>> | undefined;
  /** Team names; `SpawnPoint.team` is the index here (unknown teams append). */
  teams?: readonly string[] | undefined;
  /** Optional debug marker per spawn point (attached through RenderSync; the level disposes it). */
  spawnMarker?: ((descriptor: Extract<LevelEntityDescriptor, { kind: 'spawn' }>) => THREE.Object3D | null) | undefined;
  castShadow?: boolean | undefined;
  receiveShadow?: boolean | undefined;
}

export interface LoadedLevel extends Disposable {
  readonly url: string | null;
  readonly root: THREE.Object3D;
  readonly rootEntity: Entity;
  readonly descriptors: readonly LevelEntityDescriptor[];
  /** Every entity the level created, root first. */
  readonly entities: readonly Entity[];
  readonly spawnPoints: readonly Entity[];
  readonly props: readonly Entity[];
  readonly triggers: readonly Entity[];
  readonly lights: readonly Entity[];
  readonly colliders: readonly Entity[];
  readonly teams: readonly string[];
  /** World position of the first spawn point for a team (any team when omitted), or null. */
  spawn(team?: string): { x: number; y: number; z: number } | null;
  /**
   * The render mesh a collider stands in for, by the `COL_<name>` ↔ `<name>`
   * convention (ADR-008), or null. Decals and hit effects clip against it.
   */
  renderTwin(collider: Entity): THREE.Mesh | null;
}

/**
 * Instantiates a level GLB and turns its `spark.*` extras and `COL_` nodes into
 * entities (ADR-008): spawn points, props, triggers, lights and colliders.
 * Static geometry stays one Object3D under a root entity. `dispose()` on the
 * returned handle destroys every entity, removes every object and gives back
 * every asset reference the loader took.
 */
export class LevelLoader {
  private readonly options: LevelLoaderOptions;
  private readonly log = new Logger('level');
  private readonly teams: string[];

  constructor(options: LevelLoaderOptions) {
    this.options = options;
    this.teams = [...(options.teams ?? [])];
  }

  private teamIndex(team: string): number {
    let index = this.teams.indexOf(team);
    if (index === -1) {
      index = this.teams.length;
      this.teams.push(team);
    }
    return index;
  }

  async load(source: ModelAsset | string, placement: LevelPlacement = {}): Promise<LoadedLevel> {
    const { entities, assets, renderSync, scene, physics } = this.options;
    const held: string[] = [];
    let model: ModelAsset;
    let url: string | null = null;
    if (typeof source === 'string') {
      url = source;
      held.push(source);
      model = await assets.loadModel(source);
    } else {
      model = source;
      url = source.url;
    }

    const root = model.instantiate({
      castShadow: this.options.castShadow,
      receiveShadow: this.options.receiveShadow,
      hideCollision: true,
      name: `level:${url ?? 'asset'}`,
    });
    const p = placement.position ?? [0, 0, 0];
    root.position.set(p[0], p[1], p[2]);
    root.quaternion.setFromAxisAngle(_v.set(0, 1, 0), placement.yaw ?? 0);
    root.scale.setScalar(placement.scale ?? 1);
    scene.add(root);

    const { nodes, objects } = collectLevelNodes(root);
    const descriptors = parseLevelNodes(nodes);
    const created: Entity[] = [];
    const spawnPoints: Entity[] = [];
    const props: Entity[] = [];
    const triggers: Entity[] = [];
    const lights: Entity[] = [];
    const colliders: Entity[] = [];
    const twins = new Map<Entity, THREE.Mesh>();
    const teamOf = new Map<Entity, string>();

    const rootEntity = entities.create([
      Transform,
      { x: root.position.x, y: root.position.y, z: root.position.z, qx: root.quaternion.x, qy: root.quaternion.y, qz: root.quaternion.z, qw: root.quaternion.w, sx: root.scale.x, sy: root.scale.y, sz: root.scale.z },
    ]);
    renderSync.attach(entities, rootEntity, root);
    created.push(rootEntity);

    const transformOf = (node: LevelNode, scale = 1): [typeof Transform, Record<string, number>] => [
      Transform,
      {
        x: node.position[0],
        y: node.position[1],
        z: node.position[2],
        qx: node.quaternion[0],
        qy: node.quaternion[1],
        qz: node.quaternion[2],
        qw: node.quaternion[3],
        sx: node.scale[0] * scale,
        sy: node.scale[1] * scale,
        sz: node.scale[2] * scale,
      },
    ];

    if (physics) physics.layers.define('world', 'trigger');

    const pendingProps: Promise<void>[] = [];
    for (const descriptor of descriptors) {
      const object = objects[nodes.indexOf(descriptor.node)];
      switch (descriptor.kind) {
        case 'spawn': {
          const eid = entities.create(transformOf(descriptor.node), [SpawnPoint, { team: this.teamIndex(descriptor.team), index: descriptor.index }]);
          teamOf.set(eid, descriptor.team);
          const marker = this.options.spawnMarker?.(descriptor);
          if (marker) {
            scene.add(marker);
            renderSync.attach(entities, eid, marker);
          }
          created.push(eid);
          spawnPoints.push(eid);
          break;
        }
        case 'prop': {
          const eid = entities.create(transformOf(descriptor.node, descriptor.scale), Renderable);
          created.push(eid);
          props.push(eid);
          const libraryUrl = descriptor.prop !== null ? this.options.props?.[descriptor.prop] : undefined;
          if (libraryUrl) {
            held.push(libraryUrl);
            pendingProps.push(
              assets.loadModel(libraryUrl).then((asset) => {
                if (!entities.exists(eid)) return;
                const instance = asset.instantiate({ castShadow: this.options.castShadow, receiveShadow: this.options.receiveShadow, name: `prop:${descriptor.prop}` });
                scene.add(instance);
                renderSync.attach(entities, eid, instance);
              }),
            );
          } else if (object && descriptor.node.hasMesh) {
            // Detach so RenderSync's world-space writes are not re-parented under the level root.
            scene.attach(object);
            renderSync.attach(entities, eid, object);
          } else if (descriptor.prop !== null) {
            this.log.info(`prop "${descriptor.prop}" on ${descriptor.node.path} is not in the prop library; placed as an empty`);
          }
          break;
        }
        case 'trigger': {
          const eid = entities.create(transformOf(descriptor.node), [TriggerVolume, { id: descriptor.id }]);
          if (physics) {
            const he = descriptor.halfExtents;
            physics.addBody(eid, {
              type: 'fixed',
              shape: { kind: 'box', hx: he[0], hy: he[1], hz: he[2] },
              isSensor: true,
              layer: 'trigger',
            });
          }
          created.push(eid);
          triggers.push(eid);
          break;
        }
        case 'light': {
          const eid = entities.create(transformOf(descriptor.node), Renderable);
          let light: THREE.Object3D | null = null;
          if (descriptor.light === 'gltf' && object) {
            scene.attach(object);
            light = object;
          } else if (descriptor.light === 'spot') {
            light = new THREE.SpotLight(descriptor.color, descriptor.intensity, descriptor.range);
          } else {
            light = new THREE.PointLight(descriptor.color, descriptor.intensity, descriptor.range);
          }
          if (light !== object) scene.add(light);
          renderSync.attach(entities, eid, light);
          created.push(eid);
          lights.push(eid);
          break;
        }
        case 'collider': {
          if (!physics) break;
          const eid = entities.create([
            Transform,
            {
              x: descriptor.node.position[0],
              y: descriptor.node.position[1],
              z: descriptor.node.position[2],
              qx: descriptor.node.quaternion[0],
              qy: descriptor.node.quaternion[1],
              qz: descriptor.node.quaternion[2],
              qw: descriptor.node.quaternion[3],
            },
          ]);
          physics.layers.define(descriptor.layer);
          if (descriptor.node.name.startsWith(COLLISION_PREFIX)) {
            const twin = root.getObjectByName(descriptor.node.name.slice(COLLISION_PREFIX.length)) as THREE.Mesh | undefined;
            if (twin?.isMesh) twins.set(eid, twin);
          }
          if (descriptor.shape === 'box' || !object || !(object as THREE.Mesh).isMesh) {
            const he = descriptor.halfExtents;
            physics.addBody(eid, { type: 'fixed', shape: { kind: 'box', hx: he[0], hy: he[1], hz: he[2] }, layer: descriptor.layer, events: false });
          } else {
            const { vertices, indices } = bakeTrimesh(object as THREE.Mesh, descriptor.node);
            physics.addBody(eid, { type: 'fixed', shape: { kind: 'trimesh', vertices, indices }, layer: descriptor.layer, events: false });
          }
          created.push(eid);
          colliders.push(eid);
          break;
        }
        case 'unknown':
          this.log.debug(`unknown spark.type "${descriptor.type}" on ${descriptor.node.path}; ignored`);
          break;
      }
    }
    await Promise.all(pendingProps);

    this.log.info(
      `level ${url ?? '(asset)'}: ${descriptors.length} descriptors → spawns=${spawnPoints.length} props=${props.length} triggers=${triggers.length} lights=${lights.length} colliders=${colliders.length}`,
    );

    const teams = this.teams;
    let disposed = false;
    const t = entities.store(Transform);
    return {
      url,
      root,
      rootEntity,
      descriptors,
      entities: created,
      spawnPoints,
      props,
      triggers,
      lights,
      colliders,
      teams,
      renderTwin(collider: Entity) {
        return twins.get(collider) ?? null;
      },
      spawn(team?: string) {
        for (const eid of spawnPoints) {
          if (team !== undefined && teamOf.get(eid) !== team) continue;
          if (!entities.exists(eid)) continue;
          return { x: t.x[eid] ?? 0, y: t.y[eid] ?? 0, z: t.z[eid] ?? 0 };
        }
        return null;
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        for (const eid of created) entities.destroy(eid); // RenderSync removes objects, physics frees bodies
        root.removeFromParent();
        for (const u of held) assets.release(u);
      },
    };
  }
}

/** World-scaled vertices relative to the node's position and rotation, so the body pose can be the node pose. */
function bakeTrimesh(mesh: THREE.Mesh, node: LevelNode): { vertices: Float32Array; indices: Uint32Array } {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const count = position.count;
  const vertices = new Float32Array(count * 3);
  _inverse.set(node.quaternion[0], node.quaternion[1], node.quaternion[2], node.quaternion[3]).invert();
  for (let i = 0; i < count; i++) {
    _v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(mesh.matrixWorld);
    _v.x -= node.position[0];
    _v.y -= node.position[1];
    _v.z -= node.position[2];
    _v.applyQuaternion(_inverse);
    vertices[i * 3] = _v.x;
    vertices[i * 3 + 1] = _v.y;
    vertices[i * 3 + 2] = _v.z;
  }
  let indices: Uint32Array;
  if (geometry.index) {
    indices = Uint32Array.from(geometry.index.array as ArrayLike<number>);
  } else {
    indices = new Uint32Array(count);
    for (let i = 0; i < count; i++) indices[i] = i;
  }
  return { vertices, indices };
}
