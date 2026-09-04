import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop, clamp, directPointLight, dot, float, int, ivec2, log, positionView, screenCoordinate, smoothstep, textureLoad, uniform, vec4 } from 'three/tsl';
import ClusteredLightsNode from 'three/addons/tsl/lighting/ClusteredLightsNode.js';
import type { QualityPreset } from '../core/Config';

/**
 * Clustered (Forward+) lighting on three's `ClusteredLightsNode` (r185 addon;
 * kickoff §8 phase 3, §10; WebGPU only). The view frustum is a grid of
 * screen tiles × exponential depth slices; a compute pass assigns each
 * cluster the lights whose spheres touch it, and a lit fragment loops over
 * its cluster's list instead of every light in the scene being unrolled into
 * its shader. Shader size is therefore independent of the light count, and
 * adding, removing, moving or re-colouring a clustered light changes a data
 * texture and a storage buffer, never a program.
 *
 * What the r185 node does and does not do (verified in the installed copy):
 * - only **point lights without shadows** take the clustered path; every
 *   other light (directional, hemisphere, ambient, rect area, any shadow
 *   caster, any spot) stays on the per-light "material" path and is hashed
 *   into the program key as before;
 * - the grid is sized from `renderer.getDrawingBufferSize()` at `tileSize`
 *   pixels and rebuilt (a new compute node, so a new cache key for every lit
 *   material) whenever that size changes; the fragment side divides the
 *   fragment coordinate by the same constant, which is only right when the
 *   pass target is the drawing buffer (not at a render scale below 1);
 * - a light with `distance === 0` is never assigned to a cluster (the sphere
 *   test uses the distance as the radius);
 * - the light list is capped at `maxLights` (a data texture row) and at
 *   `maxLightsPerCluster` per cluster; overflow in a cluster silently drops
 *   the lights sorted furthest along view z.
 *
 * `SparkClusteredLightsNode` keeps the node's compute and cluster logic and
 * changes what the engine needs:
 * - **spot lights** without shadows and without a projection map join the
 *   clustered path (sphere-bounded by `distance` for assignment, cone
 *   attenuated in the fragment loop exactly as `SpotLightNode` does);
 * - the grid is **fixed per preset** (`clusterGridForPreset`, sized for a
 *   1080p reference) and the fragment tile size is a uniform derived from the
 *   current pass target, so render-scale and window-size changes never touch
 *   the compute node or the program cache and dynamic resolution stays correct;
 * - `distance === 0` lights are clustered with the camera far plane as radius;
 * - the light list is clamped to capacity (`LightingSystem` keeps it under
 *   budget before it gets here).
 */
export interface ClusterGrid {
  readonly tilesX: number;
  readonly tilesY: number;
  readonly zSlices: number;
  readonly maxLightsPerCluster: number;
}

export interface ClusterPresetSettings {
  /** Tile size in pixels at the 1080p reference; tiles scale with the target. */
  readonly tile: number;
  readonly zSlices: number;
  readonly maxLightsPerCluster: number;
}

/** Cluster grid per quality preset. */
export const CLUSTER_PRESETS: Record<QualityPreset, ClusterPresetSettings> = {
  low: { tile: 96, zSlices: 12, maxLightsPerCluster: 16 },
  medium: { tile: 64, zSlices: 16, maxLightsPerCluster: 16 },
  high: { tile: 32, zSlices: 24, maxLightsPerCluster: 32 },
  ultra: { tile: 32, zSlices: 32, maxLightsPerCluster: 48 },
  cinematic: { tile: 32, zSlices: 32, maxLightsPerCluster: 64 },
};

/** Reference resolution the tile size is quoted at. */
export const CLUSTER_REFERENCE = { width: 1920, height: 1080 } as const;

/** Slots in the clustered light list (data texture width). The preset budget selects which lights fill them. */
export const CLUSTERED_LIGHT_CAPACITY = 256;

/** Tile size (pixels) the underlying node sizes its buffers with; the shading side uses a uniform instead. */
const NODE_TILE_SIZE = 32;

/** Pure: the grid a preset gets (`tilesX × tilesY × zSlices`), sized at `reference`. */
export function clusterGridForPreset(preset: QualityPreset, reference: { width: number; height: number } = CLUSTER_REFERENCE): ClusterGrid {
  const s = CLUSTER_PRESETS[preset];
  return {
    tilesX: Math.max(1, Math.ceil(reference.width / s.tile)),
    tilesY: Math.max(1, Math.ceil(reference.height / s.tile)),
    zSlices: s.zSlices,
    maxLightsPerCluster: s.maxLightsPerCluster,
  };
}

export function clusterCount(grid: ClusterGrid): number {
  return grid.tilesX * grid.tilesY * grid.zSlices;
}

/** Bytes of the per-cluster light-index storage buffer (ivec4 chunks). */
export function clusterStorageBytes(grid: ClusterGrid): number {
  return clusterCount(grid) * Math.ceil(grid.maxLightsPerCluster / 4) * 16;
}

/** Pure: which lights the clustered path takes. Everything else stays a per-light shader term. */
export function isClusterableLight(light: THREE.Light): boolean {
  if (light.castShadow) return false;
  if ((light as THREE.PointLight).isPointLight) return true;
  const spot = light as THREE.SpotLight & { colorNode?: unknown };
  if (spot.isSpotLight) return spot.map === null && spot.colorNode === undefined;
  return false;
}

/** The r185 node's private surface the subclass drives (not in the typings). */
interface ClusteredInternals {
  _allLights: THREE.Light[];
  _bufferSize: THREE.Vector2 | null;
  _lightsTexture: THREE.DataTexture;
  _zSliceRangesTexture: THREE.DataTexture;
  _zSliceRangesData: Float32Array | null;
  _lightViewZ: Float32Array;
  _lightSortOrder: number[];
  _lightsCount: THREE.UniformNode<'int', number>;
  _cameraNear: THREE.UniformNode<'float', number>;
  _cameraFar: THREE.UniformNode<'float', number>;
  _cameraViewMatrix: THREE.UniformNode<'mat4', THREE.Matrix4>;
  _screenClusterIndex: THREE.Node;
  getTile(element: THREE.Node): THREE.Node<'int'>;
}

interface ClusteredLightData {
  position: THREE.Node<'vec3'>;
  viewPosition: THREE.Node<'vec3'>;
  distance: THREE.Node<'float'>;
  color: THREE.Node<'vec3'>;
  decay: THREE.Node<'float'>;
  /** View-space unit vector pointing from the cone toward the light (the `lightTargetDirection` convention). */
  direction: THREE.Node<'vec3'>;
  coneCos: THREE.Node<'float'>;
  penumbraCos: THREE.Node<'float'>;
}

const baseProto = ClusteredLightsNode.prototype as unknown as {
  create(this: unknown, width: number, height: number): void;
  updateBefore(this: unknown, frame: THREE.NodeFrame): void;
};

/** Cone cosines written for a point light: any `angleCos` in [-1, 1] passes `smoothstep` at 1. */
const POINT_CONE_COS = -2;
const POINT_PENUMBRA_COS = -1.5;

const _v = new THREE.Vector3();
const _target = new THREE.Vector3();
const _size = new THREE.Vector2();

export class SparkClusteredLightsNode extends ClusteredLightsNode {
  static get type(): string {
    return 'SparkClusteredLightsNode';
  }

  readonly grid: ClusterGrid;
  /** Tiles per pass-target pixel: `(tilesX / width, tilesY / height)`, refreshed every render from the current target. */
  private readonly _invTile = uniform(new THREE.Vector2(1, 1)).setName('clusteredInvTile');
  private readonly _radius: Float32Array;

  constructor(capacity: number, grid: ClusterGrid) {
    super(capacity, NODE_TILE_SIZE, grid.zSlices, grid.maxLightsPerCluster);
    this.grid = grid;
    this._radius = new Float32Array(capacity);
    // Build the buffers and the compute node now, so the node's cache key
    // (which includes the compute node) is the same for the first lit material
    // built and every one after it.
    this.create(grid.tilesX * NODE_TILE_SIZE, grid.tilesY * NODE_TILE_SIZE);
  }

  private get internals(): ClusteredInternals {
    return this as unknown as ClusteredInternals;
  }

  /** Lights currently taking the clustered path (after `setLights`). */
  get clusteredCount(): number {
    return this.clusteredLights.length;
  }

  /** Lights currently unrolled into the material shaders. */
  get materialCount(): number {
    return this.materialLights.length;
  }

  override setLights(lights: THREE.Light[]): this {
    const i = this.internals;
    i._allLights = lights;
    const { materialLights, clusteredLights } = this;
    materialLights.length = 0;
    clusteredLights.length = 0;
    for (const light of lights) {
      if (isClusterableLight(light)) clusteredLights.push(light);
      else materialLights.push(light);
    }
    return THREE.LightsNode.prototype.setLights.call(this, materialLights) as this;
  }

  /** The grid is fixed: the base implementation re-creates everything when the drawing buffer changes size. */
  updateProgram(): void {
    if (this.internals._bufferSize === null) this.create(this.grid.tilesX * NODE_TILE_SIZE, this.grid.tilesY * NODE_TILE_SIZE);
  }

  create(width: number, height: number): void {
    baseProto.create.call(this, width, height);
    const i = this.internals;
    // Four rows per light: position + radius, colour × intensity + decay,
    // spot direction + cone cosine, penumbra cosine.
    i._lightsTexture.dispose();
    const data = new Float32Array(this.maxLights * 4 * 4);
    const texture = new THREE.DataTexture(data, this.maxLights, 4, THREE.RGBAFormat, THREE.FloatType);
    texture.name = 'ClusteredLights';
    i._lightsTexture = texture;

    // Fragment → cluster index with resolution-independent tiles. The cluster
    // grid (and so the compute node) is constant; only `_invTile` follows the
    // pass target.
    const { tilesX, tilesY, zSlices } = this.grid;
    const clusterIndex = Fn(() => {
      const tile = screenCoordinate.mul(this._invTile).floor();
      const tx = int(clamp(tile.x, float(0), float(tilesX - 1))) as unknown as THREE.Node<'int'>;
      const ty = int(clamp(tile.y, float(0), float(tilesY - 1))) as unknown as THREE.Node<'int'>;
      const viewDepth = positionView.z.negate();
      const invLogFarOverNear = float(1).div(log(i._cameraFar.div(i._cameraNear)));
      const sliceFloat = log(viewDepth.div(i._cameraNear)).mul(invLogFarOverNear).mul(float(zSlices));
      const zSlice = int(clamp(sliceFloat.floor(), float(0), float(zSlices - 1))) as unknown as THREE.Node<'int'>;
      return tx.add(ty.mul(int(tilesX))).add(zSlice.mul(int(tilesX * tilesY)));
    });
    i._screenClusterIndex = clusterIndex().toVar();
  }

  getLightData(index: THREE.Node | number): ClusteredLightData {
    const i = this.internals;
    const idx = int(index as number);
    const texture = i._lightsTexture;
    const dataA = textureLoad(texture, ivec2(idx, int(0))) as unknown as THREE.Node<'vec4'>;
    const dataB = textureLoad(texture, ivec2(idx, int(1))) as unknown as THREE.Node<'vec4'>;
    const dataC = textureLoad(texture, ivec2(idx, int(2))) as unknown as THREE.Node<'vec4'>;
    const dataD = textureLoad(texture, ivec2(idx, int(3))) as unknown as THREE.Node<'vec4'>;
    const position = dataA.xyz;
    const viewPosition = i._cameraViewMatrix.mul(vec4(position, 1.0)).xyz;
    const direction = i._cameraViewMatrix.mul(vec4(dataC.xyz, 0.0)).xyz;
    return {
      position,
      viewPosition,
      distance: dataA.w,
      color: dataB.rgb,
      decay: dataB.w,
      direction,
      coneCos: dataC.w,
      penumbraCos: dataD.x,
    };
  }

  /** Upload the clustered lights sorted along view z, plus the per-slice index ranges the compute pass culls with. */
  updateLightsTexture(camera: THREE.Camera): void {
    const i = this.internals;
    const texture = i._lightsTexture;
    const data = texture.image.data as Float32Array;
    const lineSize = this.maxLights * 4;
    const clustered = this.clusteredLights;
    const count = Math.min(clustered.length, this.maxLights);
    const far = (camera as THREE.PerspectiveCamera).far ?? 1000;
    const near = (camera as THREE.PerspectiveCamera).near ?? 0.1;
    i._lightsCount.value = count;

    const viewZ = i._lightViewZ;
    const order = i._lightSortOrder;
    const radius = this._radius;
    for (let n = 0; n < count; n++) {
      const light = clustered[n] as THREE.PointLight | THREE.SpotLight;
      _v.setFromMatrixPosition(light.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      viewZ[n] = _v.z;
      order[n] = n;
      radius[n] = light.distance > 0 ? light.distance : far;
    }
    order.length = count;
    order.sort((a, b) => (viewZ[a] as number) - (viewZ[b] as number));

    for (let n = 0; n < count; n++) {
      const src = order[n] as number;
      const light = clustered[src] as THREE.PointLight | THREE.SpotLight;
      const offset = n * 4;
      _v.setFromMatrixPosition(light.matrixWorld);
      data[offset] = _v.x;
      data[offset + 1] = _v.y;
      data[offset + 2] = _v.z;
      data[offset + 3] = radius[src] as number;
      data[lineSize + offset] = light.color.r * light.intensity;
      data[lineSize + offset + 1] = light.color.g * light.intensity;
      data[lineSize + offset + 2] = light.color.b * light.intensity;
      data[lineSize + offset + 3] = light.decay;
      const spot = light as THREE.SpotLight;
      if (spot.isSpotLight) {
        _target.setFromMatrixPosition(spot.target.matrixWorld);
        _v.sub(_target).normalize();
        data[2 * lineSize + offset] = _v.x;
        data[2 * lineSize + offset + 1] = _v.y;
        data[2 * lineSize + offset + 2] = _v.z;
        data[2 * lineSize + offset + 3] = Math.cos(spot.angle);
        data[3 * lineSize + offset] = Math.cos(spot.angle * (1 - spot.penumbra));
      } else {
        data[2 * lineSize + offset] = 0;
        data[2 * lineSize + offset + 1] = 0;
        data[2 * lineSize + offset + 2] = 1;
        data[2 * lineSize + offset + 3] = POINT_CONE_COS;
        data[3 * lineSize + offset] = POINT_PENUMBRA_COS;
      }
    }
    texture.needsUpdate = true;

    const zRanges = i._zSliceRangesData;
    if (zRanges === null) return;
    const NZ = this.zSlices;
    for (let z = 0; z < NZ; z++) {
      const sliceNear = -(near * Math.pow(far / near, z / NZ));
      const sliceFar = -(near * Math.pow(far / near, (z + 1) / NZ));
      let rangeStart = count;
      let rangeEnd = 0;
      for (let n = 0; n < count; n++) {
        const src = order[n] as number;
        const vz = viewZ[src] as number;
        const r = radius[src] as number;
        if (vz + r >= sliceFar && vz - r <= sliceNear) {
          if (n < rangeStart) rangeStart = n;
          if (n + 1 > rangeEnd) rangeEnd = n + 1;
        }
      }
      if (rangeStart >= count) {
        rangeStart = 0;
        rangeEnd = 0;
      }
      zRanges[z * 4] = rangeStart;
      zRanges[z * 4 + 1] = rangeEnd;
    }
    i._zSliceRangesTexture.needsUpdate = true;
  }

  override updateBefore(frame: THREE.NodeFrame): undefined {
    const renderer = frame.renderer;
    if (!renderer || !frame.camera) return undefined;
    const target = renderer.getRenderTarget();
    let width: number;
    let height: number;
    if (target) {
      width = target.width;
      height = target.height;
    } else {
      renderer.getDrawingBufferSize(_size);
      width = _size.x;
      height = _size.y;
    }
    this._invTile.value.set(this.grid.tilesX / Math.max(1, width), this.grid.tilesY / Math.max(1, height));
    baseProto.updateBefore.call(this, frame);
    return undefined;
  }

  override setupLights(builder: THREE.NodeBuilder, lightNodes: THREE.LightingNode[]): void {
    this.updateProgram();
    const context = builder.context as { reflectedLight: { directDiffuse: THREE.Node; directSpecular: THREE.Node } };
    (context.reflectedLight.directDiffuse as unknown as { toStack(): void }).toStack();
    (context.reflectedLight.directSpecular as unknown as { toStack(): void }).toStack();
    // The per-light (material) path for everything that is not clustered.
    THREE.LightsNode.prototype.setupLights.call(this, builder, lightNodes);

    const i = this.internals;
    const lightsNode = (builder as unknown as { lightsNode: THREE.LightsNode }).lightsNode;
    Fn(() => {
      Loop(this.maxLightsPerCluster, ({ i: slot }) => {
        const lightIndex = i.getTile(slot as THREE.Node);
        If(lightIndex.equal(int(0)), () => {
          Break();
        });
        const { color, decay, viewPosition, distance, direction, coneCos, penumbraCos } = this.getLightData(lightIndex.sub(int(1)));
        const lightVector = viewPosition.sub(positionView);
        // Same early-out as the base node: skip the BRDF beyond the light's radius.
        If(dot(lightVector, lightVector).lessThanEqual(distance.mul(distance)), () => {
          // r185's `directPointLight` takes `lightVector` (the typings still say `lightViewPosition`).
          const params = { color, lightVector, cutoffDistance: distance, decayExponent: decay } as unknown as Parameters<typeof directPointLight>[0];
          const { lightDirection, lightColor } = directPointLight(params);
          const spot = smoothstep(coneCos, penumbraCos, dot(lightDirection as THREE.Node<'vec3'>, direction));
          lightsNode.setupDirectLight(builder, this, { lightDirection, lightColor: (lightColor as THREE.Node<'vec3'>).mul(spot) });
        });
      });
    }, 'void')();
  }

  /** Release the GPU resources. The node is not usable afterwards. */
  override dispose(): void {
    const i = this.internals;
    i._lightsTexture.dispose();
    i._zSliceRangesTexture.dispose();
    super.dispose();
  }
}
