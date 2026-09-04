import * as THREE from 'three/webgpu';
import { Renderable, Transform } from '../ecs/components/Transform';
import type { EntityWorld } from '../ecs/EntityWorld';
import type { System } from '../ecs/System';
import { Cullable } from './components';
import { FRUSTUM_FLOATS, extractFrustumPlanes, sphereInFrustum } from './Frustum';
import type { SpatialIndex } from './SpatialIndex';

export interface CullingSystemOptions {
  /**
   * Optional broad phase. Entities present in the index are tested per cell
   * (cells fully inside the frustum skip per-entity tests); entities that are
   * not in the index fall back to a per-entity sphere test.
   */
  spatial?: SpatialIndex | undefined;
  /** Multiplier on every `Cullable.maxDistance`; pass `quality.drawDistance`. Default 1. */
  drawDistance?: number | undefined;
}

export interface CullingStats {
  /** Entities with Cullable + Renderable + Transform considered this frame. */
  candidates: number;
  visible: number;
  culled: number;
  /** Visibility flags that actually changed this frame. */
  changed: number;
  /** Broad-phase candidates the spatial index returned (0 without an index). */
  broadPhase: number;
}

/**
 * Pure culling math, exported for tests: is a sphere inside the frustum and
 * within `maxDistance` (0 = unlimited) of the camera at `(cx, cy, cz)`?
 */
export function isVisible(
  planes: ArrayLike<number>,
  cx: number,
  cy: number,
  cz: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  maxDistance: number,
): boolean {
  if (maxDistance > 0) {
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    const reach = maxDistance + radius;
    if (dx * dx + dy * dy + dz * dz > reach * reach) return false;
  }
  return sphereInFrustum(planes, x, y, z, radius);
}

/**
 * Frustum + distance culling for entities that opt in with `Cullable`. Runs in
 * the late stage before RenderSync / InstancedRenderSync and writes
 * `Renderable.visible` (only when it changes, so static batches see a minimal
 * dirty set). Entities without `Cullable` are never touched.
 *
 * No allocation per frame: the frustum lives in a Float32Array, the broad-phase
 * candidate list is reused, and the camera matrices are read in place.
 */
export class CullingSystem implements System {
  readonly name = 'CullingSystem';
  readonly stage = 'late' as const;
  readonly order = 900;

  /** Current frustum planes (6 × 4 floats), refreshed each run. */
  readonly planes = new Float32Array(FRUSTUM_FLOATS);

  private camera: THREE.Camera | null = null;
  private spatial: SpatialIndex | undefined;
  private drawDistance: number;
  private readonly projView = new THREE.Matrix4();
  private readonly candidates: number[] = [];
  private frame = 0;
  private readonly statsValue: CullingStats = { candidates: 0, visible: 0, culled: 0, changed: 0, broadPhase: 0 };

  constructor(options: CullingSystemOptions = {}) {
    this.spatial = options.spatial;
    this.drawDistance = options.drawDistance ?? 1;
  }

  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
  }

  setSpatialIndex(spatial: SpatialIndex | undefined): void {
    this.spatial = spatial;
  }

  setDrawDistance(scale: number): void {
    this.drawDistance = scale;
  }

  getDrawDistance(): number {
    return this.drawDistance;
  }

  stats(): CullingStats {
    return this.statsValue;
  }

  run(world: EntityWorld): void {
    const camera = this.camera;
    const s = this.statsValue;
    s.candidates = s.visible = s.culled = s.changed = s.broadPhase = 0;
    if (!camera) return;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    extractFrustumPlanes(this.projView.elements, this.planes);
    const e = camera.matrixWorld.elements;
    const cx = e[12] as number;
    const cy = e[13] as number;
    const cz = e[14] as number;
    // Frame stamp for the broad phase; never 0 so a fresh Cullable row is "not seen".
    this.frame = (this.frame + 1) >>> 0 || 1;
    const frame = this.frame;
    const scale = this.drawDistance;
    const planes = this.planes;
    const c = world.store(Cullable);
    const t = world.store(Transform);
    const r = world.store(Renderable);

    const spatial = this.spatial;
    if (spatial) {
      const candidates = this.candidates;
      const n = spatial.queryFrustum(planes, candidates);
      s.broadPhase = n;
      for (let i = 0; i < n; i++) {
        const eid = candidates[i] as number;
        const maxDistance = (c.maxDistance[eid] as number) * scale;
        if (maxDistance > 0) {
          const dx = (t.x[eid] as number) - cx;
          const dy = (t.y[eid] as number) - cy;
          const dz = (t.z[eid] as number) - cz;
          const reach = maxDistance + (c.radius[eid] as number);
          if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        }
        c.stamp[eid] = frame;
      }
    }

    const list = world.query(Cullable, Renderable, Transform);
    let visible = 0;
    let changed = 0;
    for (let i = 0; i < list.length; i++) {
      const eid = list[i] as number;
      let v: number;
      if (spatial && spatial.has(eid)) {
        v = c.stamp[eid] === frame ? 1 : 0;
      } else {
        v = isVisible(
          planes,
          cx,
          cy,
          cz,
          t.x[eid] as number,
          t.y[eid] as number,
          t.z[eid] as number,
          c.radius[eid] as number,
          (c.maxDistance[eid] as number) * scale,
        )
          ? 1
          : 0;
      }
      visible += v;
      if (r.visible[eid] !== v) {
        r.visible[eid] = v;
        changed++;
      }
    }
    s.candidates = list.length;
    s.visible = visible;
    s.culled = list.length - visible;
    s.changed = changed;
  }
}
