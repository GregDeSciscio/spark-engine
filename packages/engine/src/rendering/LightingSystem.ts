import * as THREE from 'three/webgpu';
import { illuminanceAt, lightRecord, type IlluminanceLight, type IlluminanceOptions } from './Illuminance';
import type { Disposable } from '../core/Disposable';
import { Logger } from '../core/Logger';
import { defineComponentType } from '../ecs/Component';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import { SideTable } from '../ecs/SideTable';
import type { System } from '../ecs/System';
import { CLUSTERED_LIGHT_CAPACITY, SparkClusteredLightsNode, clusterGridForPreset, isClusterableLight, type ClusterGrid } from './ClusteredLights';
import type { QualitySettings } from './QualityPresets';
import type { SparkRenderer } from './Renderer';

/**
 * Engine-owned light management (kickoff §10, §18 "dynamic light count").
 *
 * Every light in the live scene is registered here: the ones the scene added
 * to its three scene graph are adopted when the engine attaches the scene,
 * later ones through `register()`, and entity-driven lights through the
 * `Light` component plus `attachEntity()` (their Transform is copied to the
 * three light in the `late` stage, before rendering).
 *
 * Two jobs:
 *
 * 1. **Budget.** `QualitySettings.maxDynamicLights` caps the *local* lights
 *    (point and spot lights that cast no shadow). Over budget, the lights
 *    with the highest importance (`lightImportance`: intensity over the
 *    squared gap between the camera and the light's radius) stay on and the
 *    rest are switched off. Switched off means a layer mask no camera sees,
 *    so three leaves the light out of its lights list while `visible` stays
 *    the scene's own switch (RenderSync writes `visible` from the entity
 *    every frame, and used to switch every culled level light back on).
 *    Directional, hemisphere, ambient, rect-area and every shadow-casting
 *    light is pinned: it is never budgeted, because on either tier it is a
 *    term of the material shaders and toggling it would recompile them.
 * 2. **Clustered path (WebGPU only, ADR-001).** On WebGPU the scene's lights
 *    node is a `SparkClusteredLightsNode`: unshadowed point and spot lights
 *    are culled per screen cluster on the GPU and looped over in the shader,
 *    so the lit shaders no longer grow with the light count and changing the
 *    local light set changes buffers, never programs. The cluster grid follows
 *    the preset (`clusterGridForPreset`) and is fixed for the attached scene.
 *    On the WebGL2 tier nothing is clustered, and every local light the
 *    renderer sees is unrolled into every lit shader, so a change in the set
 *    is a recompile of every lit material: on the showcase, twenty seconds of
 *    synchronous compiles each time the camera moved enough to swap one. So
 *    on that tier the real local lights are all switched off and the budget
 *    drives a fixed pool of proxy lights instead (`COMPAT_LIGHT_CAP`, 8, at
 *    most), sized once at attach: each frame the proxies copy position,
 *    colour, intensity and range from the most important real lights. The
 *    selection changes uniforms, never programs ("vary by uniform, not by
 *    graph", docs/performance/cold-start.md), so it runs every frame and a
 *    muzzle flash can take a slot for the frames it is lit.
 */

/** A light driven by an entity: `intensity` and `range` (three `distance`) are copied to the three light each frame. */
export const Light = defineComponentType('Light', { intensity: 'f32', range: 'f32' }, { intensity: 1, range: 0 });

export interface LightingStats {
  /** Lights registered with the system (scene + entity lights). */
  registered: number;
  /** Lights on this frame (visible; pinned + selected local lights). */
  active: number;
  /** Local lights taking the clustered path (WebGPU). */
  clustered: number;
  /** Lights unrolled into the material shaders (pinned lights, plus every active local light on WebGL2). */
  unrolled: number;
  /** Local lights switched off by the budget. */
  culled: number;
  /** Effective budget for local lights. */
  budget: number;
  /** Whether the clustered path is installed for the attached scene. */
  clusteredPath: boolean;
  grid: ClusterGrid | null;
  /**
   * Last resolved GPU time of the frame's compute passes in ms (three's
   * `COMPUTE` timestamp: the cluster assignment plus any other compute that
   * frame, e.g. particles), or null when unmeasurable or not clustered.
   */
  computeMs: number | null;
}

/** Unrolled local lights the compat tier accepts regardless of preset. */
export const COMPAT_LIGHT_CAP = 8;

/** A candidate must beat the weakest active light by this factor to swap in: a swap is cheap on both tiers, but a light flickering in and out of the set pops. */
const CLUSTERED_HYSTERESIS = 1.25;
const POOL_HYSTERESIS = 1.5;
/** Name and userData flag of the unrolled tier's proxy lights, for anything that walks the scene for lights. */
export const LIGHT_PROXY_NAME = 'spark:light-proxy';

/**
 * Pure: how much a local light matters to the camera. Intensity over the
 * squared distance from the camera to the light's sphere (zero inside it),
 * so a dim light at the camera beats a bright one across the map.
 */
export function lightImportance(intensity: number, distance: number, range: number): number {
  const gap = Math.max(0, distance - Math.max(0, range));
  return Math.max(0, intensity) / (1 + gap * gap);
}

/**
 * Pure: pick at most `budget` of the candidates by importance. A currently
 * active light's importance is multiplied by `hysteresis` so a challenger
 * has to be clearly better before the set changes. Ties keep the lower index.
 */
export function selectLights(importance: readonly number[], budget: number, active?: readonly boolean[], hysteresis = 1): boolean[] {
  const n = importance.length;
  const selected = new Array<boolean>(n).fill(false);
  if (budget <= 0 || n === 0) return selected;
  const order = Array.from({ length: n }, (_, i) => i);
  const score = (i: number): number => (importance[i] as number) * (active?.[i] ? hysteresis : 1);
  order.sort((a, b) => score(b) - score(a) || a - b);
  const keep = Math.min(budget, n);
  for (let k = 0; k < keep; k++) selected[order[k] as number] = true;
  return selected;
}

/** Pure: the budget a tier actually applies. */
export function effectiveLightBudget(requested: number, clustered: boolean): number {
  const cap = clustered ? CLUSTERED_LIGHT_CAPACITY : COMPAT_LIGHT_CAP;
  return Math.max(0, Math.min(Math.floor(requested), cap));
}

interface Entry {
  readonly light: THREE.Light;
  /** Switched off by the budget (as opposed to hidden by the scene). */
  culled: boolean;
  /** The light's own layer mask while the budget has it switched off. */
  mask: number;
  /** Registered from the scene graph on attach; released on detach. */
  adopted: boolean;
  /** Unrolled tier: the proxy slot this light is copied into, or -1. */
  slot: number;
}

/** Unrolled tier: the proxies the renderer sees instead of the real local lights. Sized once; never changes shape while attached. */
interface ProxyPool {
  readonly points: THREE.PointLight[];
  readonly spots: THREE.SpotLight[];
  /** The entry each slot copies this frame (null: the slot is dark). */
  readonly pointOwners: (Entry | null)[];
  readonly spotOwners: (Entry | null)[];
}

/** Switch a light off for the budget, or back on: by layer, never by `visible`. */
function setCulled(entry: Entry, culled: boolean): void {
  if (culled === entry.culled) return;
  entry.culled = culled;
  if (culled) {
    entry.mask = entry.light.layers.mask;
    entry.light.layers.mask = 0;
  } else entry.light.layers.mask = entry.mask;
}

/** Copy what a proxy needs from a real local light: its world position (and a spot's aim), colour and falloff. */
function copyLight(from: THREE.Light, to: THREE.PointLight | THREE.SpotLight): void {
  from.updateWorldMatrix(true, false);
  to.position.setFromMatrixPosition(from.matrixWorld);
  to.color.copy(from.color);
  to.intensity = from.intensity;
  const local = from as THREE.PointLight;
  to.distance = local.distance;
  to.decay = local.decay;
  const spot = from as THREE.SpotLight;
  if (spot.isSpotLight && (to as THREE.SpotLight).isSpotLight) {
    const proxy = to as THREE.SpotLight;
    proxy.angle = spot.angle;
    proxy.penumbra = spot.penumbra;
    spot.target.updateWorldMatrix(true, false);
    proxy.target.position.setFromMatrixPosition(spot.target.matrixWorld);
  }
}

interface LightingHost {
  getNode(scene: THREE.Scene): THREE.LightsNode;
}

const _cameraPosition = new THREE.Vector3();
const _lightPosition = new THREE.Vector3();
const _illumScratch = { position: new THREE.Vector3(), direction: new THREE.Vector3() };

export class LightingSystem implements System, Disposable {
  readonly name = 'Lighting';
  readonly stage = 'late' as const;
  /** After RenderSync / InstancedRenderSync: entity lights read Transform directly, but keep the render-side order. */
  readonly order = 1002;

  /** Entity → three light, for entity-driven lights (`attachEntity`). Removed from its parent and unregistered on destroy. */
  readonly lights: SideTable<THREE.Light>;

  private readonly log = new Logger('lighting');
  private readonly renderer: SparkRenderer;
  private readonly clusteredTier: boolean;
  private quality: QualitySettings;
  private budgetOverride: number | null = null;
  private readonly entries = new Map<THREE.Light, Entry>();
  private scene: THREE.Scene | null = null;
  private camera: THREE.Camera | null = null;
  private node: SparkClusteredLightsNode | null = null;
  private pool: ProxyPool | null = null;
  private hostOverridden = false;
  private frames = 0;
  private dirty = true;
  private disposed = false;
  private stats: LightingStats;
  private computeMs: number | null = null;

  private readonly illumLights: IlluminanceLight[] = [];
  // Scratch for the selection, reused across frames.
  private candidates: Entry[] = [];
  private importance: number[] = [];
  private active: boolean[] = [];

  constructor(entities: EntityWorld, renderer: SparkRenderer, quality: QualitySettings) {
    this.renderer = renderer;
    this.quality = quality;
    this.clusteredTier = renderer.capabilities.backend === 'webgpu';
    this.lights = new SideTable<THREE.Light>(entities, (light) => {
      this.unregister(light);
      light.removeFromParent();
    });
    this.stats = this.emptyStats();
  }

  // ---- scene ------------------------------------------------------------------------

  /**
   * Make `scene` the lit scene: adopt every light already in its graph, and
   * on WebGPU install the clustered lights node for it. The engine calls this
   * from `loadScene`, before the scene's first render (the node must exist
   * before three builds the scene's render list). Replaces any previous scene.
   */
  attach(scene: THREE.Scene, camera: THREE.Camera): void {
    this.detach();
    this.scene = scene;
    this.camera = camera;
    scene.traverse((object) => {
      const light = object as THREE.Light;
      if (light.isLight === true && !this.entries.has(light) && light.userData['sparkLightProxy'] !== true) this.entries.set(light, { light, culled: false, mask: light.layers.mask, adopted: true, slot: -1 });
    });
    if (this.clusteredTier) {
      const grid = clusterGridForPreset(this.quality.preset);
      this.node = new SparkClusteredLightsNode(CLUSTERED_LIGHT_CAPACITY, grid);
      const host = this.renderer.three.lighting as unknown as LightingHost;
      const proto = Object.getPrototypeOf(host) as LightingHost;
      const node = this.node;
      host.getNode = (target: THREE.Scene): THREE.LightsNode => (target === scene ? node : proto.getNode.call(host, target));
      this.hostOverridden = true;
      this.log.debug(`clustered lighting: grid ${grid.tilesX}×${grid.tilesY}×${grid.zSlices}, ${grid.maxLightsPerCluster} lights/cluster, capacity ${CLUSTERED_LIGHT_CAPACITY}`);
    }
    // The first selection reads world matrices, and nothing has rendered yet to
    // update them: a camera still at the origin picks lights the first real
    // re-evaluation then swaps out, which on the unrolled tier recompiles every
    // lit material a few frames into the scene.
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.dirty = true;
    this.applyBudget(true);
  }

  /** Forget the attached scene: adopted lights are released, culled lights restored, the clustered node removed. */
  detach(): void {
    for (const entry of this.entries.values()) {
      setCulled(entry, false);
      entry.slot = -1;
    }
    this.releasePool();
    for (const [light, entry] of this.entries) if (entry.adopted) this.entries.delete(light);
    if (this.hostOverridden) {
      delete (this.renderer.three.lighting as unknown as Partial<LightingHost>).getNode;
      this.hostOverridden = false;
    }
    this.node?.dispose();
    this.node = null;
    this.scene = null;
    this.camera = null;
    this.dirty = true;
    this.stats = this.emptyStats();
  }

  // ---- registration -----------------------------------------------------------------

  /** Track a light the scene added after attach (or one it wants budgeted). Returns the unregister function. */
  register(light: THREE.Light): () => void {
    if (!this.entries.has(light)) {
      this.entries.set(light, { light, culled: false, mask: light.layers.mask, adopted: false, slot: -1 });
      this.dirty = true;
    }
    return () => this.unregister(light);
  }

  unregister(light: THREE.Light): void {
    const entry = this.entries.get(light);
    if (!entry) return;
    setCulled(entry, false);
    this.entries.delete(light);
    this.dirty = true;
  }

  /**
   * Drive `light` from an entity: adds the `Light` component (from the light's
   * current intensity and distance) if missing, registers the light, and
   * copies Transform position + `Light` fields to it every frame. The scene
   * still adds the light to its scene graph.
   */
  attachEntity(world: EntityWorld, eid: Entity, light: THREE.Light): void {
    const local = light as THREE.PointLight;
    if (!world.has(eid, Light)) world.add(eid, Light, { intensity: light.intensity, range: local.distance ?? 0 });
    this.register(light);
    this.lights.set(eid, light);
    // Place it now: anything reading the light's position before the first frame (audio emitters,
    // fog cones) would otherwise see the origin until this system has run once.
    if (world.has(eid, Transform)) {
      const t = world.store(Transform);
      light.position.set(t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0);
      light.updateMatrixWorld(true);
    }
  }

  // ---- budget -------------------------------------------------------------------------

  /** Override the preset budget for local lights (null = preset). Clamped to the tier's capacity. */
  setBudget(budget: number | null): void {
    this.budgetOverride = budget;
    this.dirty = true;
  }

  /** The budget in force: the override or the preset's `maxDynamicLights`, capped per tier. */
  get budget(): number {
    return effectiveLightBudget(this.budgetOverride ?? this.quality.maxDynamicLights, this.clusteredTier);
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.dirty = true;
  }

  /** Whether local lights are clustered (WebGPU with a scene attached). */
  get clustered(): boolean {
    return this.node !== null;
  }

  /**
   * CPU estimate of the light arriving at `point` from every registered local
   * light (see `Illuminance.ts`). Directional and hemisphere light are not
   * registered here; pass them as `ambient`. Records are rebuilt per call, so
   * query a few points per frame, not hundreds.
   */
  illuminanceAt(point: THREE.Vector3, options: IlluminanceOptions = {}): number {
    this.illumLights.length = 0;
    for (const light of this.entries.keys()) {
      if (!light.visible) continue;
      const rec = lightRecord(light, { position: new THREE.Vector3(), direction: new THREE.Vector3() });
      if (rec) this.illumLights.push(rec);
    }
    void _illumScratch;
    return illuminanceAt(this.illumLights, point, options);
  }

  getStats(): LightingStats {
    return this.stats;
  }

  // ---- per frame ------------------------------------------------------------------------

  run(world: EntityWorld): void {
    if (this.disposed) return;
    const t = world.store(Transform);
    const l = world.store(Light);
    for (const [eid, light] of this.lights.entries()) {
      if (world.has(eid, Transform)) light.position.set(t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0);
      if (world.has(eid, Light)) {
        light.intensity = l.intensity[eid] ?? 0;
        (light as THREE.PointLight).distance = l.range[eid] ?? 0;
      }
    }
    this.frames++;
    this.applyBudget(false);
    if (this.node) this.sampleComputeTime();
  }

  /**
   * The cluster assignment is a compute dispatch per lit render call, and
   * with `trackTimestamp` on three queues a timestamp pair for every one;
   * somebody has to resolve the `COMPUTE` queries or the pool overflows (a
   * console warning after ~1000 frames). The particle system resolves them
   * only while it has emitters, so the lighting system does it whenever the
   * clustered node is live. three coalesces concurrent resolves.
   */
  private sampleComputeTime(): void {
    if (!this.renderer.capabilities.timestampQuery) return;
    const three = this.renderer.three;
    void three
      .resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE)
      .then(() => {
        const ms = three.info.compute.timestamp;
        if (typeof ms === 'number' && Number.isFinite(ms)) this.computeMs = ms;
      })
      .catch(() => {
        this.computeMs = null;
      });
  }

  /**
   * Select the local lights within budget, every frame. Clustered tier: the
   * selection switches real lights on and off, which changes a buffer.
   * Unrolled tier: the real lights stay off and the selection decides which
   * of them the proxy pool copies, which changes uniforms.
   */
  private applyBudget(force: boolean): void {
    const clusteredPath = this.node !== null;
    const budget = this.budget;
    let pinned = 0;
    const candidates = this.candidates;
    candidates.length = 0;
    for (const entry of this.entries.values()) {
      const light = entry.light;
      if (!isClusterableLight(light)) {
        if (light.visible) pinned++;
        continue;
      }
      // Hidden by the scene itself: not a candidate, not counted as culled.
      if (!light.visible) {
        setCulled(entry, false);
        continue;
      }
      candidates.push(entry);
    }

    const camera = this.camera;
    if (camera) _cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    else _cameraPosition.set(0, 0, 0);
    const importance = this.importance;
    importance.length = candidates.length;
    for (let i = 0; i < candidates.length; i++) {
      const light = (candidates[i] as Entry).light as THREE.PointLight;
      _lightPosition.setFromMatrixPosition(light.matrixWorld);
      importance[i] = lightImportance(light.intensity, _lightPosition.distanceTo(_cameraPosition), light.distance);
    }

    let lit = 0;
    if (clusteredPath || this.scene === null) {
      const active = this.active;
      active.length = candidates.length;
      for (let i = 0; i < candidates.length; i++) active[i] = !(candidates[i] as Entry).culled;
      const selected = selectLights(importance, budget, active, CLUSTERED_HYSTERESIS);
      for (let i = 0; i < candidates.length; i++) {
        setCulled(candidates[i] as Entry, !(selected[i] as boolean));
        if (selected[i]) lit++;
      }
    } else {
      if (force || this.dirty || !this.pool) this.sizePool(candidates, budget);
      lit = this.fillPool(candidates, importance);
    }
    this.dirty = false;

    const poolSize = this.pool ? this.pool.points.length + this.pool.spots.length : 0;
    this.stats = {
      registered: this.entries.size,
      active: pinned + lit,
      clustered: clusteredPath ? lit : 0,
      unrolled: pinned + (clusteredPath ? 0 : poolSize),
      culled: candidates.length - lit,
      budget,
      clusteredPath,
      grid: this.node?.grid ?? null,
      computeMs: clusteredPath ? this.computeMs : null,
    };
  }

  /**
   * Unrolled tier: give the pool one proxy per budget slot the scene can use,
   * split between point and spot lights by how many of each it has. Only a
   * change of size rebuilds it (and recompiles); attach sizes it before the
   * warm-up, so a scene whose lights are all made at load never does.
   */
  private sizePool(candidates: readonly Entry[], budget: number): void {
    const scene = this.scene;
    if (!scene) return;
    let points = 0;
    let spots = 0;
    for (const entry of candidates) {
      if ((entry.light as THREE.SpotLight).isSpotLight) spots++;
      else points++;
    }
    const pointSlots = Math.min(budget, points);
    const spotSlots = Math.min(budget - pointSlots, spots);
    if (this.pool && this.pool.points.length === pointSlots && this.pool.spots.length === spotSlots) return;
    this.releasePool();
    const tag = (light: THREE.PointLight | THREE.SpotLight): void => {
      light.name = LIGHT_PROXY_NAME;
      light.userData['sparkLightProxy'] = true;
      light.castShadow = false;
      light.intensity = 0;
      scene.add(light);
    };
    const pool: ProxyPool = {
      points: Array.from({ length: pointSlots }, () => new THREE.PointLight()),
      spots: Array.from({ length: spotSlots }, () => new THREE.SpotLight()),
      pointOwners: new Array<Entry | null>(pointSlots).fill(null),
      spotOwners: new Array<Entry | null>(spotSlots).fill(null),
    };
    for (const light of pool.points) tag(light);
    for (const light of pool.spots) {
      tag(light);
      light.target.name = `${LIGHT_PROXY_NAME}:target`;
      scene.add(light.target);
    }
    this.pool = pool;
    for (const entry of this.entries.values()) entry.slot = -1;
    if (pointSlots + spotSlots > 0) this.log.debug(`unrolled lighting: ${pointSlots} point and ${spotSlots} spot proxies for ${candidates.length} local lights`);
  }

  /** Unrolled tier: switch every real local light off and copy the most important into the proxies. Returns how many are lit through them. */
  private fillPool(candidates: readonly Entry[], importance: readonly number[]): number {
    const pool = this.pool;
    for (const entry of candidates) setCulled(entry, true);
    if (!pool) return 0;
    let lit = 0;
    const fill = (spot: boolean, proxies: (THREE.PointLight | THREE.SpotLight)[], owners: (Entry | null)[]): void => {
      const picks: number[] = [];
      for (let i = 0; i < candidates.length; i++) if ((((candidates[i] as Entry).light as THREE.SpotLight).isSpotLight === true) === spot) picks.push(i);
      const active = picks.map((i) => (candidates[i] as Entry).slot >= 0);
      const selected = selectLights(picks.map((i) => importance[i] as number), proxies.length, active, POOL_HYSTERESIS);
      // A light that stays selected keeps its slot; new ones take the freed slots.
      const incoming: Entry[] = [];
      for (let k = 0; k < picks.length; k++) {
        const entry = candidates[picks[k] as number] as Entry;
        if (!selected[k]) {
          if (entry.slot >= 0 && owners[entry.slot] === entry) owners[entry.slot] = null;
          entry.slot = -1;
        } else if (entry.slot < 0 || owners[entry.slot] !== entry) {
          entry.slot = -1;
          incoming.push(entry);
        }
      }
      for (let slot = 0; slot < owners.length && incoming.length > 0; slot++) {
        const owner = owners[slot];
        if (owner && owner.slot === slot && candidates.includes(owner)) continue;
        const entry = incoming.shift() as Entry;
        owners[slot] = entry;
        entry.slot = slot;
      }
      for (let slot = 0; slot < proxies.length; slot++) {
        const proxy = proxies[slot] as THREE.PointLight | THREE.SpotLight;
        const owner = owners[slot] ?? null;
        if (owner && owner.slot === slot && candidates.includes(owner)) {
          copyLight(owner.light, proxy);
          lit++;
        } else {
          owners[slot] = null;
          proxy.intensity = 0;
        }
      }
    };
    fill(false, pool.points, pool.pointOwners);
    fill(true, pool.spots, pool.spotOwners);
    return lit;
  }

  private releasePool(): void {
    const pool = this.pool;
    if (!pool) return;
    for (const light of [...pool.points, ...pool.spots]) {
      light.removeFromParent();
      light.dispose();
    }
    for (const light of pool.spots) light.target.removeFromParent();
    this.pool = null;
  }

  private emptyStats(): LightingStats {
    return { registered: this.entries.size, active: 0, clustered: 0, unrolled: 0, culled: 0, budget: this.budget, clusteredPath: false, grid: null, computeMs: null };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.lights.dispose();
    this.entries.clear();
  }
}
