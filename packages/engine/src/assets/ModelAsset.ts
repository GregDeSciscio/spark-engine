import type * as THREE from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { CachedAsset } from './AssetCache';

/** Name prefix for collision meshes (ADR-008). They are never rendered. */
export const COLLISION_PREFIX = 'COL_';

/** Everything a glTF node carried in its `extras`, plus the `spark.*` subset ADR-008 consumes. */
export interface ModelNodeExtras {
  /** Object name as exported (glTF node name). */
  readonly name: string;
  /** Slash-separated path from the model root, for disambiguating duplicate names. */
  readonly path: string;
  /** three object type: 'Mesh', 'Group', 'Object3D', 'SkinnedMesh', ... */
  readonly type: string;
  /** All extras (three copies glTF extras into `userData`). */
  readonly extras: Readonly<Record<string, unknown>>;
  /** Only the `spark.*` keys, with the prefix stripped: `spark.type` → `type`. */
  readonly spark: Readonly<Record<string, unknown>>;
  /** True when the node name starts with `COL_`. */
  readonly collision: boolean;
}

export interface InstantiateOptions {
  castShadow?: boolean | undefined;
  receiveShadow?: boolean | undefined;
  /** Hide `COL_` nodes in the instance (default true; ADR-008 says they are never rendered). */
  hideCollision?: boolean | undefined;
  name?: string | undefined;
}

/** Per-clip metadata: glTF animation extras survive the pipeline as `AnimationClip.userData`. */
export interface ModelClipInfo {
  readonly name: string;
  readonly duration: number;
  /** All extras on the glTF animation. */
  readonly extras: Readonly<Record<string, unknown>>;
  /** Only the `spark.*` keys, prefix stripped: `spark.events` → `events`, `spark.loop` → `loop`. */
  readonly spark: Readonly<Record<string, unknown>>;
}

export interface ModelAssetInfo {
  readonly meshes: number;
  readonly triangles: number;
  readonly materials: number;
  readonly textures: number;
  readonly animations: number;
  readonly skinned: boolean;
}

/**
 * A parsed glTF, held once in the cache. `template` is never added to a
 * scene; call `instantiate()` for a deep clone that shares geometry, materials
 * and textures with the template (so instances are cheap and disposal happens
 * once, here, when the cache evicts the asset).
 */
export class ModelAsset implements CachedAsset {
  readonly kind = 'model' as const;
  readonly template: THREE.Group;
  readonly animations: readonly THREE.AnimationClip[];
  /** Name, duration and extras of every clip, in `animations` order. */
  readonly clips: readonly ModelClipInfo[];
  /** Nodes that carry any glTF extras. */
  readonly nodes: readonly ModelNodeExtras[];
  /** Nodes with at least one `spark.*` extra. */
  readonly sparkNodes: readonly ModelNodeExtras[];
  /** Nodes whose name starts with `COL_`. */
  readonly collisionNodes: readonly ModelNodeExtras[];
  readonly info: ModelAssetInfo;
  readonly textureBytes: number;
  readonly geometryBytes: number;

  private instances = 0;
  private disposed = false;

  constructor(
    readonly url: string,
    gltf: GLTF,
  ) {
    this.template = gltf.scene;
    this.animations = gltf.animations;
    this.clips = gltf.animations.map((clip) => {
      const extras = readExtras(clip as unknown as THREE.Object3D) ?? {};
      return { name: clip.name, duration: clip.duration, extras, spark: sparkSubset(extras) };
    });

    const nodes: ModelNodeExtras[] = [];
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    let meshes = 0;
    let triangles = 0;
    let skinned = false;

    const visit = (object: THREE.Object3D, path: string): void => {
      const extras = readExtras(object);
      if (extras || object.name.startsWith(COLLISION_PREFIX)) {
        nodes.push({
          name: object.name,
          path,
          type: object.type,
          extras: extras ?? {},
          spark: extras ? sparkSubset(extras) : {},
          collision: object.name.startsWith(COLLISION_PREFIX),
        });
      }
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        meshes++;
        if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
        geometries.add(mesh.geometry);
        triangles += countTriangles(mesh.geometry);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          materials.add(material);
          for (const texture of materialTextures(material)) textures.add(texture);
        }
      }
      for (const child of object.children) visit(child, `${path}/${child.name || child.type}`);
    };
    visit(this.template, this.template.name || 'root');

    this.nodes = nodes;
    this.sparkNodes = nodes.filter((n) => Object.keys(n.spark).length > 0);
    this.collisionNodes = nodes.filter((n) => n.collision);

    let geometryBytes = 0;
    for (const geometry of geometries) geometryBytes += estimateGeometryBytes(geometry);
    let textureBytes = 0;
    for (const texture of textures) textureBytes += estimateTextureBytes(texture);
    this.geometryBytes = geometryBytes;
    this.textureBytes = textureBytes;
    this.info = {
      meshes,
      triangles,
      materials: materials.size,
      textures: textures.size,
      animations: this.animations.length,
      skinned,
    };
  }

  /** A clip by name, or undefined. */
  getClip(name: string): THREE.AnimationClip | undefined {
    return this.animations.find((clip) => clip.name === name);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Number of instances created so far (diagnostic only; instances are not tracked). */
  get instanceCount(): number {
    return this.instances;
  }

  /**
   * Deep clone of the template. Skinned models go through `SkeletonUtils.clone`
   * so bones and skeletons are rebound; everything else uses `Object3D.clone`.
   * The instance shares GPU resources with the template: remove it from the
   * scene when done, but do not dispose its geometry or materials.
   */
  instantiate(options: InstantiateOptions = {}): THREE.Object3D {
    if (this.disposed) throw new Error(`ModelAsset: instantiate() after dispose (${this.url})`);
    const instance = this.info.skinned ? cloneSkinned(this.template) : this.template.clone(true);
    const hideCollision = options.hideCollision ?? true;
    instance.traverse((object) => {
      if (options.castShadow !== undefined) object.castShadow = options.castShadow;
      if (options.receiveShadow !== undefined) object.receiveShadow = options.receiveShadow;
      if (hideCollision && object.name.startsWith(COLLISION_PREFIX)) object.visible = false;
    });
    if (options.name !== undefined) instance.name = options.name;
    this.instances++;
    return instance;
  }

  /** Release every geometry, material, texture and skeleton the template owns. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const seenMaterials = new Set<THREE.Material>();
    const seenTextures = new Set<THREE.Texture>();
    this.template.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const skinnedMesh = object as THREE.SkinnedMesh;
      if (skinnedMesh.isSkinnedMesh) skinnedMesh.skeleton.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (seenMaterials.has(material)) continue;
        seenMaterials.add(material);
        for (const texture of materialTextures(material)) {
          if (seenTextures.has(texture)) continue;
          seenTextures.add(texture);
          texture.dispose();
        }
        material.dispose();
      }
    });
    this.template.clear();
  }
}

// ---- helpers ---------------------------------------------------------------

const SPARK_PREFIX = 'spark.';

function readExtras(object: THREE.Object3D): Record<string, unknown> | null {
  const userData = object.userData as Record<string, unknown>;
  const keys = Object.keys(userData).filter((k) => k !== 'gltfExtensions');
  if (keys.length === 0) return null;
  const extras: Record<string, unknown> = {};
  for (const key of keys) extras[key] = userData[key];
  return extras;
}

function sparkSubset(extras: Record<string, unknown>): Record<string, unknown> {
  const spark: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extras)) {
    if (key.startsWith(SPARK_PREFIX)) spark[key.slice(SPARK_PREFIX.length)] = value;
  }
  return spark;
}

function countTriangles(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  if (!position) return 0;
  const count = geometry.index ? geometry.index.count : position.count;
  const start = geometry.drawRange.start;
  const range = Math.min(geometry.drawRange.count, count - start);
  return Math.floor(range / 3);
}

/** Every texture slot a material may own, without enumerating the material classes. */
export function materialTextures(material: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) out.push(value as THREE.Texture);
  }
  return out;
}

export function estimateGeometryBytes(geometry: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) {
    const array = (attribute as THREE.BufferAttribute).array as ArrayBufferView | undefined;
    if (array) bytes += array.byteLength;
  }
  if (geometry.index) bytes += geometry.index.array.byteLength;
  for (const targets of Object.values(geometry.morphAttributes)) {
    for (const attribute of targets ?? []) bytes += (attribute.array as ArrayBufferView).byteLength;
  }
  return bytes;
}

export function estimateTextureBytes(texture: THREE.Texture): number {
  const compressed = texture as THREE.CompressedTexture;
  if (compressed.isCompressedTexture && Array.isArray(compressed.mipmaps)) {
    let bytes = 0;
    for (const mip of compressed.mipmaps) {
      const data = (mip as { data?: ArrayBufferView }).data;
      if (data) bytes += data.byteLength;
    }
    return bytes;
  }
  const image = texture.image as { width?: number; height?: number; data?: ArrayBufferView } | null | undefined;
  if (!image) return 0;
  if (image.data && typeof image.data.byteLength === 'number') {
    return Math.round(image.data.byteLength * (texture.generateMipmaps ? 4 / 3 : 1));
  }
  const width = image.width ?? 0;
  const height = image.height ?? 0;
  return Math.round(width * height * 4 * (texture.generateMipmaps ? 4 / 3 : 1));
}
