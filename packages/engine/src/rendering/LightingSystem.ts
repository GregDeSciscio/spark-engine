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
 *    rest are switched off (`visible = false`; restored when they make the
 *    cut again). Directional, hemisphere, ambient, rect-area and every
 *    shadow-casting light is pinned: it is never budgeted, because on either
 *    tier it is a term of the material shaders and toggling it would
 *    recompile them.
 * 2. **Clustered path (WebGPU only, ADR-001).** On WebGPU the scene's lights
 *    node is a `SparkClusteredLightsNode`: unshadowed point and spot lights
 *    are culled per screen cluster on the GPU and looped over in the shader,
 *    so the lit shaders no longer grow with the light count and changing the
 *    local light set changes buffers, never programs. The cluster grid follows
 *    the preset (`clusterGridForPreset`) and is fixed for the attached scene.
 *    On the WebGL2 tier nothing is clustered: the budget just caps how many
 *    local lights are unrolled (`COMPAT_LIGHT_CAP`, 8) so the compat shaders
 *    stay compact, and the selection is re-evaluated at a low cadence with
 *    hysteresis so a moving camera does not thrash the program cache.
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

/** Frames between budget re-evaluations on the unrolled tier (each change is a shader recompile there). */
const UNROLLED_REEVALUATE_FRAMES = 120;
/** A candidate must beat the weakest active light by this factor to swap in (clustered tier: cheap, mild). */
const CLUSTERED_HYSTERESIS = 1.25;
const UNROLLED_HYSTERESIS = 2;

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
  /** Registered from the scene graph on attach; released on detach. */
  adopted: boolean;
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
      if (light.isLight === true && !this.entries.has(light)) this.entries.set(light, { light, culled: false, adopted: true });
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
    this.dirty = true;
    this.applyBudget(true);
  }

  /** Forget the attached scene: adopted lights are released, culled lights restored, the clustered node removed. */
  detach(): void {
    for (const entry of this.entries.values()) {
      if (entry.culled) {
        entry.light.visible = true;
        entry.culled = false;
      }
    }
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
      this.entries.set(light, { light, culled: false, adopted: false });
      this.dirty = true;
    }
    return () => this.unregister(light);
  }

  unregister(light: THREE.Light): void {
    const entry = this.entries.get(light);
    if (!entry) return;
    if (entry.culled) light.visible = true;
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
   * Select the local lights within budget. Clustered tier: every frame (the
   * selection changes a buffer). Unrolled tier: only when the registered set
   * changed, or every `UNROLLED_REEVALUATE_FRAMES`, with stronger hysteresis.
   */
  private applyBudget(force: boolean): void {
    const clusteredPath = this.node !== null;
    const reevaluate = force || this.dirty || clusteredPath || this.frames % UNROLLED_REEVALUATE_FRAMES === 0;
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
      if (!light.visible && !entry.culled) continue;
      candidates.push(entry);
    }

    if (reevaluate) {
      this.dirty = false;
      const camera = this.camera;
      if (camera) _cameraPosition.setFromMatrixPosition(camera.matrixWorld);
      else _cameraPosition.set(0, 0, 0);
      const importance = this.importance;
      const active = this.active;
      importance.length = candidates.length;
      active.length = candidates.length;
      for (let i = 0; i < candidates.length; i++) {
        const entry = candidates[i] as Entry;
        const light = entry.light as THREE.PointLight;
        _lightPosition.setFromMatrixPosition(light.matrixWorld);
        importance[i] = lightImportance(light.intensity, _lightPosition.distanceTo(_cameraPosition), light.distance);
        active[i] = !entry.culled;
      }
      const selected = selectLights(importance, budget, active, clusteredPath ? CLUSTERED_HYSTERESIS : UNROLLED_HYSTERESIS);
      for (let i = 0; i < candidates.length; i++) {
        const entry = candidates[i] as Entry;
        const keep = selected[i] as boolean;
        if (keep === !entry.culled) continue;
        entry.culled = !keep;
        entry.light.visible = keep;
      }
    }

    let culled = 0;
    for (const entry of candidates) if (entry.culled) culled++;
    const activeLocal = candidates.length - culled;
    this.stats = {
      registered: this.entries.size,
      active: pinned + activeLocal,
      clustered: clusteredPath ? activeLocal : 0,
      unrolled: pinned + (clusteredPath ? 0 : activeLocal),
      culled,
      budget,
      clusteredPath,
      grid: this.node?.grid ?? null,
      computeMs: clusteredPath ? this.computeMs : null,
    };
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
