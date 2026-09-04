import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  cameraFar,
  cameraNear,
  cos,
  cross,
  exp,
  float,
  floor,
  hash,
  instanceIndex,
  instancedArray,
  int,
  length,
  linearDepth,
  mat3,
  max,
  min,
  mix,
  modelViewMatrix,
  mx_noise_vec3,
  normalLocal,
  PI2,
  positionGeometry,
  pow,
  rotate,
  saturate,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  transformNormalToView,
  uint,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  viewportLinearDepth,
} from 'three/tsl';
import { Logger } from '../core/Logger';
import { defineComponentType } from '../ecs/Component';
import { Transform } from '../ecs/components/Transform';
import type { Entity, EntityWorld } from '../ecs/EntityWorld';
import { SideTable } from '../ecs/SideTable';
import type { System } from '../ecs/System';
import type { SparkRenderer } from '../rendering/Renderer';
import {
  CURVE_SAMPLES,
  HASH_GENERATION_MUL,
  HASH_INDEX_MUL,
  LiveEstimator,
  SpawnAccumulator,
  bakeColorCurve,
  bakeCurve,
  resolveEmitterDescriptor,
  type ParticleEmitterDescriptor,
  type ParticleEmitterDescriptorInput,
} from './descriptor';
import { PARTICLE_PRESETS, isParticlePresetName, type ParticlePresetName } from './presets';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/**
 * Numeric emitter state (ADR-003). The GPU objects live in the system's side
 * table; the emitter's pose comes from `Transform`.
 *
 * - `enabled`: 0 stops continuous emission (bursts still queue; live particles finish their life)
 * - `rateScale`: multiplies the descriptor rate
 * - `time`: emitter simulation time in seconds, advanced by the fixed step (written by the system)
 */
export const ParticleEmitter = defineComponentType(
  'ParticleEmitter',
  { enabled: 'u8', rateScale: 'f32', time: 'f32' },
  { enabled: 1, rateScale: 1, time: 0 },
);

/** Fixed-stage order of the particle system: after physics sync (110), before late-stage render sync. */
export const VFX_ORDER = { simulate: 500 } as const;

export interface EmitterHandle {
  readonly eid: Entity;
  /** Add this to the three scene. Removed from its parent automatically when the emitter goes away. */
  readonly object: THREE.Object3D;
  readonly descriptor: ParticleEmitterDescriptor;
}

export interface ParticleStats {
  /** GPU particles run on this backend. False on WebGL2 (ADR-001). */
  available: boolean;
  emitters: number;
  enabled: number;
  /** Sum of every emitter's capacity: the particles the GPU simulates each dispatch. */
  capacity: number;
  /** CPU estimate of particles currently alive (spawns not yet past their maximum lifetime). */
  live: number;
  /** Last resolved compute-pass GPU time in ms, or null when timestamps are unavailable (fixed clock, WebGL2). */
  computeMs: number | null;
  /** Compute dispatches so far. One per rendered frame that ran at least one fixed step. */
  dispatches: number;
}

interface EmitterUniforms {
  dt: THREE.UniformNode<'float', number>;
  time: THREE.UniformNode<'float', number>;
  seed: THREE.UniformNode<'uint', number>;
  spawnStart: THREE.UniformNode<'uint', number>;
  spawnCount: THREE.UniformNode<'uint', number>;
  origin: THREE.UniformNode<'vec3', THREE.Vector3>;
  rotation: THREE.UniformNode<'vec4', THREE.Vector4>;
  direction: THREE.UniformNode<'vec3', THREE.Vector3>;
  wind: THREE.UniformNode<'vec3', THREE.Vector3>;
  gravity: THREE.UniformNode<'float', number>;
  drag: THREE.UniformNode<'float', number>;
  spread: THREE.UniformNode<'float', number>;
  /** (strength, frequency, speed) */
  noise: THREE.UniformNode<'vec3', THREE.Vector3>;
  speed: THREE.UniformNode<'vec2', THREE.Vector2>;
  lifetime: THREE.UniformNode<'vec2', THREE.Vector2>;
  size: THREE.UniformNode<'vec2', THREE.Vector2>;
  rotationSpeed: THREE.UniformNode<'vec2', THREE.Vector2>;
  /** sphere: (radius, shell); box: size; cone: (radius, angle) */
  shape: THREE.UniformNode<'vec3', THREE.Vector3>;
  wrapSize: THREE.UniformNode<'vec3', THREE.Vector3>;
}

interface EmitterRuntime {
  eid: Entity;
  descriptor: ParticleEmitterDescriptor;
  uniforms: EmitterUniforms;
  buffers: THREE.BufferAttribute[];
  computeInit: THREE.ComputeNode;
  computeUpdate: THREE.ComputeNode;
  object: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  /** Owned only for sprite emitters; mesh emitters use the caller's material. */
  ownedMaterial: THREE.Material | null;
  accumulator: SpawnAccumulator;
  live: LiveEstimator;
  simTime: number;
  pendingDt: number;
}

const _quat = new THREE.Quaternion();

/**
 * GPU-simulated particle emitters (Milestone 8, kickoff §11). WebGPU only:
 * on the WebGL2 backend the system reports `available === false`, spawns
 * nothing and logs one `info` line (ADR-001: off, not emulated).
 *
 * Each emitter owns storage buffers sized to its capacity and one TSL compute
 * node that (re)spawns particles by ring window and integrates the survivors.
 * Every random attribute comes from `hash(index, generation, seed)`; the only
 * time the shader sees is the emitter's own simulation-time uniform, advanced
 * by the engine's fixed step. Same seed + same fixed steps = same particles.
 *
 * Dispatch is once per rendered frame: fixed steps accumulate `dt` and spawn
 * counts, and the first fixed step of each frame submits one compute pass
 * for every emitter (`renderer.compute([...])`).
 */
export class ParticleSystem implements System {
  readonly name = 'ParticleSystem';
  readonly stage = 'fixed' as const;
  readonly order = VFX_ORDER.simulate;

  readonly available: boolean;

  private readonly log = new Logger('vfx');
  private readonly renderer: SparkRenderer;
  private readonly world: EntityWorld;
  private readonly emitters: SideTable<EmitterRuntime>;
  private readonly baseSeed: number;
  private noticeLogged = false;
  private lastDispatchFrame = -1;
  private dispatchCount = 0;
  private computeMs: number | null = null;
  private disposed = false;

  /** The system registered on `world` by the engine. Throws if none. */
  static from(world: EntityWorld): ParticleSystem {
    const system = world.systems.list('fixed').find((s) => s.name === 'ParticleSystem');
    if (!system) throw new Error('ParticleSystem: not registered on this world (Engine.initialize() registers it)');
    return system as ParticleSystem;
  }

  constructor(world: EntityWorld, renderer: SparkRenderer, options: { seed?: number } = {}) {
    this.world = world;
    this.renderer = renderer;
    this.baseSeed = (options.seed ?? 1) >>> 0;
    this.available = renderer.capabilities.backend === 'webgpu';
    this.emitters = new SideTable<EmitterRuntime>(world, (runtime) => this.release(runtime));
  }

  // ---- public API ----------------------------------------------------------

  /**
   * Create a GPU emitter on `eid` (adds `ParticleEmitter`, and `Transform` if
   * missing). Returns null on the WebGL2 backend. The caller adds
   * `handle.object` to its three scene.
   */
  spawnEmitter(
    eid: Entity,
    preset: ParticlePresetName | ParticleEmitterDescriptorInput,
    overrides?: ParticleEmitterDescriptorInput,
  ): EmitterHandle | null {
    if (!this.available) {
      if (!this.noticeLogged) {
        this.noticeLogged = true;
        this.log.info(`GPU particles unavailable on backend "${this.renderer.capabilities.backend}"; emitters are off (ADR-001)`);
      }
      return null;
    }
    if (this.disposed) throw new Error('ParticleSystem: disposed');
    const input: ParticleEmitterDescriptorInput =
      typeof preset === 'string'
        ? { ...(isParticlePresetName(preset) ? (PARTICLE_PRESETS[preset] as ParticleEmitterDescriptorInput) : unknownPreset(preset)), ...overrides }
        : { ...preset, ...overrides };
    const descriptor = resolveEmitterDescriptor(input);
    if (!this.world.exists(eid)) throw new Error(`ParticleSystem: entity ${eid} does not exist`);
    if (this.emitters.has(eid)) this.emitters.delete(eid);
    if (!this.world.has(eid, Transform)) this.world.add(eid, Transform);
    this.world.add(eid, ParticleEmitter, { enabled: 1, rateScale: 1, time: 0 });

    const runtime = this.build(eid, descriptor);
    this.emitters.set(eid, runtime);
    this.syncPose(runtime);
    this.renderer.three.compute(runtime.computeInit);
    if (descriptor.prewarm) runtime.live.record(0, descriptor.capacity, descriptor.lifetime[1]);
    this.log.debug(`emitter ${eid}: capacity=${descriptor.capacity} render=${descriptor.render.kind}`);
    return { eid, object: runtime.object, descriptor };
  }

  /** Queue `count` immediate spawns for the next dispatch. No-op when unavailable. */
  burst(eid: Entity, count: number): void {
    const runtime = this.emitters.get(eid);
    if (!runtime) return;
    runtime.accumulator.burst(count);
  }

  setEnabled(eid: Entity, enabled: boolean): void {
    if (!this.world.has(eid, ParticleEmitter)) return;
    this.world.store(ParticleEmitter).enabled[eid] = enabled ? 1 : 0;
  }

  isEnabled(eid: Entity): boolean {
    return this.world.has(eid, ParticleEmitter) && (this.world.store(ParticleEmitter).enabled[eid] ?? 0) !== 0;
  }

  hasEmitter(eid: Entity): boolean {
    return this.emitters.has(eid);
  }

  /** Release the emitter's GPU objects and remove the component. The entity survives. */
  removeEmitter(eid: Entity): void {
    this.emitters.delete(eid);
    if (this.world.has(eid, ParticleEmitter)) this.world.remove(eid, ParticleEmitter);
  }

  stats(): ParticleStats {
    let capacity = 0;
    let live = 0;
    let enabled = 0;
    const store = this.emitters.size > 0 ? this.world.store(ParticleEmitter) : null;
    this.emitters.forEach((runtime, eid) => {
      capacity += runtime.descriptor.capacity;
      live += runtime.descriptor.wrap ? runtime.descriptor.capacity : runtime.live.estimate(runtime.simTime, runtime.descriptor.capacity);
      if (store && (store.enabled[eid] ?? 0) !== 0) enabled++;
    });
    return {
      available: this.available,
      emitters: this.emitters.size,
      enabled,
      capacity,
      live,
      computeMs: this.computeMs,
      dispatches: this.dispatchCount,
    };
  }

  // ---- system ------------------------------------------------------------------

  run(world: EntityWorld, dt: number): void {
    if (!this.available || this.disposed || this.emitters.size === 0) return;
    const store = world.store(ParticleEmitter);
    // three publishes the frame id in beginFrame() (see SparkRenderer), so it
    // changes exactly once per rendered frame: the first fixed step after a
    // render dispatches, later steps in the same frame only accumulate.
    const frame = this.renderer.three.info.frame;
    const dispatchNow = frame !== this.lastDispatchFrame;
    const list: THREE.ComputeNode[] = [];

    for (const eid of world.query(ParticleEmitter, Transform)) {
      const runtime = this.emitters.get(eid);
      if (!runtime) continue;
      const enabled = (store.enabled[eid] ?? 0) !== 0;
      runtime.simTime += dt;
      runtime.pendingDt += dt;
      store.time[eid] = runtime.simTime;
      if (enabled) runtime.accumulator.step(runtime.descriptor.rate * (store.rateScale[eid] ?? 1), dt);
      this.syncPose(runtime);
      if (!dispatchNow) continue;
      const { start, count } = runtime.accumulator.flush();
      const u = runtime.uniforms;
      u.spawnStart.value = start;
      u.spawnCount.value = count;
      u.dt.value = runtime.pendingDt;
      u.time.value = runtime.simTime;
      runtime.pendingDt = 0;
      if (count > 0) runtime.live.record(runtime.simTime, count, runtime.descriptor.lifetime[1]);
      list.push(runtime.computeUpdate);
    }

    if (!dispatchNow) return;
    this.lastDispatchFrame = frame;
    if (list.length === 0) return;
    this.renderer.three.compute(list);
    this.dispatchCount++;
    this.sampleComputeTime();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.emitters.dispose();
    this.log.debug('disposed');
  }

  // ---- internals -----------------------------------------------------------------

  private syncPose(runtime: EmitterRuntime): void {
    const t = this.world.store(Transform);
    const eid = runtime.eid;
    const x = t.x[eid] ?? 0;
    const y = t.y[eid] ?? 0;
    const z = t.z[eid] ?? 0;
    _quat.set(t.qx[eid] ?? 0, t.qy[eid] ?? 0, t.qz[eid] ?? 0, t.qw[eid] ?? 1).normalize();
    if (runtime.descriptor.space === 'local') {
      runtime.object.position.set(x, y, z);
      runtime.object.quaternion.copy(_quat);
      runtime.uniforms.origin.value.set(0, 0, 0);
      runtime.uniforms.rotation.value.set(0, 0, 0, 1);
    } else {
      runtime.uniforms.origin.value.set(x, y, z);
      runtime.uniforms.rotation.value.set(_quat.x, _quat.y, _quat.z, _quat.w);
    }
  }

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

  private release(runtime: EmitterRuntime): void {
    runtime.object.removeFromParent();
    runtime.computeInit.dispose();
    runtime.computeUpdate.dispose();
    runtime.geometry.dispose();
    runtime.ownedMaterial?.dispose();
    // Storage buffers are plain attributes to three; the renderer frees the
    // GPU buffer when its attribute cache entry is deleted.
    const attributes = (this.renderer.three as unknown as { _attributes?: { delete(attribute: THREE.BufferAttribute): unknown } })._attributes;
    for (const buffer of runtime.buffers) {
      try {
        attributes?.delete(buffer);
      } catch {
        // Already gone (renderer disposed first). Nothing to free.
      }
    }
    runtime.live.clear();
  }

  private build(eid: Entity, desc: ParticleEmitterDescriptor): EmitterRuntime {
    const capacity = desc.capacity;
    const seed = (this.baseSeed ^ Math.imul(desc.seed >>> 0, 0x9e3779b1) ^ Math.imul(eid, 0x85ebca6b)) >>> 0;

    const dir = new THREE.Vector3();
    if (desc.direction !== 'shape') dir.set(desc.direction[0], desc.direction[1], desc.direction[2]);
    if (dir.lengthSq() > 0) dir.normalize();
    const shapeParams = new THREE.Vector3();
    switch (desc.shape.kind) {
      case 'sphere':
        shapeParams.set(desc.shape.radius, desc.shape.shell ? 1 : 0, 0);
        break;
      case 'box':
        shapeParams.set(desc.shape.size[0], desc.shape.size[1], desc.shape.size[2]);
        break;
      case 'cone':
        shapeParams.set(desc.shape.radius, desc.shape.angle, 0);
        break;
      case 'point':
        break;
    }
    const u: EmitterUniforms = {
      dt: uniform(0),
      time: uniform(0),
      seed: uniform(seed, 'uint'),
      spawnStart: uniform(0, 'uint'),
      spawnCount: uniform(0, 'uint'),
      origin: uniform(new THREE.Vector3()),
      rotation: uniform(new THREE.Vector4(0, 0, 0, 1)),
      direction: uniform(dir),
      wind: uniform(new THREE.Vector3(desc.wind[0], desc.wind[1], desc.wind[2])),
      gravity: uniform(desc.gravity),
      drag: uniform(desc.drag),
      spread: uniform(desc.spread),
      noise: uniform(new THREE.Vector3(desc.noise.strength, desc.noise.frequency, desc.noise.speed)),
      speed: uniform(new THREE.Vector2(desc.speed[0], desc.speed[1])),
      lifetime: uniform(new THREE.Vector2(desc.lifetime[0], desc.lifetime[1])),
      size: uniform(new THREE.Vector2(desc.size[0], desc.size[1])),
      rotationSpeed: uniform(new THREE.Vector2(desc.rotation[0], desc.rotation[1])),
      shape: uniform(shapeParams),
      wrapSize: uniform(desc.wrap ? new THREE.Vector3(desc.wrap.size[0], desc.wrap.size[1], desc.wrap.size[2]) : new THREE.Vector3(1, 1, 1)),
    };

    // ---- storage --------------------------------------------------------------
    const positionBuffer = instancedArray(capacity, 'vec3');
    const velocityBuffer = instancedArray(capacity, 'vec3');
    /** (age, lifetime) */
    const lifeBuffer = instancedArray(capacity, 'vec2');
    /** (size, spin, generation, initial roll) */
    const attrBuffer = instancedArray(capacity, 'vec4');
    const buffers = [positionBuffer.value, velocityBuffer.value, lifeBuffer.value, attrBuffer.value] as THREE.BufferAttribute[];

    const capacityU = uint(capacity);
    const useNoise = desc.noise.strength !== 0;
    const useDrag = desc.drag > 0;
    const worldSpace = desc.space === 'world';

    /** v rotated by the emitter quaternion (world-space emitters only). */
    const rotateByEmitter = (v: V3): V3 => {
      if (!worldSpace) return v;
      const q = u.rotation;
      const qv = q.xyz;
      const t = cross(qv, cross(qv, v).add(v.mul(q.w))).mul(2);
      return v.add(t);
    };

    const unitVector = (a: F, b: F): V3 => {
      const z = a.mul(2).sub(1);
      const s = sqrt(max(z.mul(z).oneMinus(), 0));
      const phi = b.mul(PI2);
      return vec3(s.mul(cos(phi)), z, s.mul(sin(phi)));
    };

    /**
     * (Re)spawn particle `i`. `prewarm` starts it partway through its life,
     * advanced ballistically (drag and noise ignored) unless the emitter wraps.
     */
    const spawn = (i: THREE.Node<'uint'>, prewarm: boolean): void => {
      const attr = attrBuffer.element(i);
      const generation = attr.z.add(1).toVar();
      const base = i
        .mul(uint(HASH_INDEX_MUL))
        .add(generation.toUint().mul(uint(HASH_GENERATION_MUL)))
        .add(u.seed)
        .toVar();
      const r = (k: number): F => hash(base.add(uint(k)));

      let localPos: V3;
      let shapeDir: V3;
      switch (desc.shape.kind) {
        case 'sphere': {
          const n = unitVector(r(0), r(1));
          const radial = desc.shape.shell ? float(1) : pow(r(2), 1 / 3);
          localPos = n.mul(u.shape.x.mul(radial));
          shapeDir = n;
          break;
        }
        case 'box': {
          localPos = vec3(r(0), r(1), r(2)).sub(0.5).mul(u.shape);
          shapeDir = vec3(0, 1, 0);
          break;
        }
        case 'cone': {
          const rad = u.shape.x.mul(sqrt(r(0)));
          const ang = r(1).mul(PI2);
          localPos = vec3(rad.mul(cos(ang)), 0, rad.mul(sin(ang)));
          const a = u.shape.y.mul(sqrt(r(2)));
          const phi = r(3).mul(PI2);
          shapeDir = vec3(sin(a).mul(cos(phi)), cos(a), sin(a).mul(sin(phi)));
          break;
        }
        case 'point':
        default:
          localPos = vec3(0, 0, 0);
          shapeDir = vec3(0, 1, 0);
          break;
      }

      const baseDir = desc.direction === 'shape' ? shapeDir : u.direction;
      const mixed = mix(baseDir, unitVector(r(4), r(5)), u.spread);
      const len = length(mixed);
      const direction = select(len.greaterThan(1e-5), mixed.div(max(len, 1e-5)), vec3(0, 1, 0));
      const speed = mix(u.speed.x, u.speed.y, r(6));
      const lifetime = mix(u.lifetime.x, u.lifetime.y, r(7));
      const size = mix(u.size.x, u.size.y, r(8));
      const spin = mix(u.rotationSpeed.x, u.rotationSpeed.y, r(9)).mul(select(r(10).lessThan(0.5), -1, 1));
      const roll = r(11).mul(PI2);

      const velocity = rotateByEmitter(direction.mul(speed)).toVar();
      const position = u.origin.add(rotateByEmitter(localPos)).toVar();
      const age = prewarm ? r(12).mul(lifetime).toVar() : float(0).toVar();
      if (prewarm && !desc.wrap) {
        const g = vec3(0, u.gravity, 0);
        position.addAssign(velocity.mul(age).add(g.mul(age.mul(age).mul(0.5))));
        velocity.addAssign(g.mul(age));
      }
      positionBuffer.element(i).assign(position);
      velocityBuffer.element(i).assign(velocity);
      lifeBuffer.element(i).assign(vec2(age, lifetime));
      attr.assign(vec4(size, spin, generation, roll));
    };

    const computeInit = Fn(() => {
      const i = instanceIndex;
      if (desc.prewarm) {
        spawn(i, true);
      } else {
        // Dead until the ring reaches it: age past lifetime, generation 0.
        positionBuffer.element(i).assign(vec3(0, 0, 0));
        velocityBuffer.element(i).assign(vec3(0, 0, 0));
        lifeBuffer.element(i).assign(vec2(1, 0));
        attrBuffer.element(i).assign(vec4(0, 0, 0, 0));
      }
    })().compute(capacity);

    const computeUpdate = Fn(() => {
      const i = instanceIndex;
      const offset = select(i.greaterThanEqual(u.spawnStart), i.sub(u.spawnStart), i.add(capacityU).sub(u.spawnStart));
      If(offset.lessThan(u.spawnCount), () => {
        spawn(i, false);
      }).Else(() => {
        const life = lifeBuffer.element(i);
        const age = life.x.toVar();
        const lifetime = life.y;
        If(age.lessThan(lifetime), () => {
          const dt = u.dt;
          const position = positionBuffer.element(i).toVar();
          const velocity = velocityBuffer.element(i).toVar();
          velocity.addAssign(vec3(0, u.gravity.mul(dt), 0));
          if (useNoise) {
            const p = position.mul(u.noise.y).add(u.time.mul(u.noise.z));
            velocity.addAssign(mx_noise_vec3(p).mul(u.noise.x.mul(dt)));
          }
          if (useDrag) {
            const k = exp(u.drag.mul(dt).negate()).oneMinus();
            velocity.assign(mix(velocity, u.wind, k));
          }
          position.addAssign(velocity.mul(dt));
          if (desc.wrap) {
            const rel = position.sub(u.origin);
            const wrapped = rel.sub(u.wrapSize.mul(floor(rel.div(u.wrapSize).add(0.5))));
            position.assign(u.origin.add(wrapped));
          }
          positionBuffer.element(i).assign(position);
          velocityBuffer.element(i).assign(velocity);
          lifeBuffer.element(i).assign(vec2(age.add(dt), lifetime));
        });
      });
    })().compute(capacity);

    // ---- rendering -------------------------------------------------------------
    const sizeLut = uniformArray<'vec4'>(
      Array.from(bakeCurve(desc.sizeOverLife, CURVE_SAMPLES), (v) => new THREE.Vector4(v, 0, 0, 0)),
      'vec4',
    );
    const colorSamples = bakeColorCurve(desc.colorOverLife, CURVE_SAMPLES);
    const colorLut = uniformArray<'vec4'>(
      Array.from({ length: CURVE_SAMPLES }, (_, k) =>
        new THREE.Vector4(colorSamples[k * 4] ?? 1, colorSamples[k * 4 + 1] ?? 1, colorSamples[k * 4 + 2] ?? 1, colorSamples[k * 4 + 3] ?? 1),
      ),
      'vec4',
    );
    const sampleLut = (lut: THREE.UniformArrayNode<'vec4'>, t: F): V4 => {
      const x = t.mul(CURVE_SAMPLES - 1);
      const i0 = floor(x);
      const f = x.sub(i0);
      const a = int(i0);
      const b = int(min(i0.add(1), CURVE_SAMPLES - 1));
      return mix(lut.element(a), lut.element(b), f);
    };

    const i = instanceIndex;
    const center = positionBuffer.element(i);
    const velocityAttr = velocityBuffer.element(i);
    const life = lifeBuffer.element(i);
    const attr = attrBuffer.element(i);
    const age = life.x;
    const lifetime = life.y;
    const lifeT = saturate(age.div(max(lifetime, 1e-6)));
    const aliveF = select(age.lessThan(lifetime), float(1), float(0));
    let size = attr.x.mul(sampleLut(sizeLut, lifeT).x).mul(aliveF);
    let lifeColor = varying(sampleLut(colorLut, lifeT), 'v_particleColor');
    if (desc.render.kind === 'sprite' && desc.render.nearFade > 0) {
      // Near-camera fall-off: shrink and fade sprites inside `nearFade` metres of the lens.
      const viewDistance = length(modelViewMatrix.mul(vec4(center, 1)).xyz);
      const near = smoothstep(0, desc.render.nearFade, viewDistance);
      size = size.mul(near);
      lifeColor = varying(vec4(lifeColor.xyz, lifeColor.w.mul(near)), 'v_particleColorNear');
    }

    let material: THREE.NodeMaterial;
    let ownedMaterial: THREE.Material | null = null;
    let sourceGeometry: THREE.BufferGeometry;

    if (desc.render.kind === 'sprite') {
      const render = desc.render;
      const sprite = new ParticleSpriteMaterial();
      ownedMaterial = sprite;
      material = sprite;
      sourceGeometry = new ParticleQuadGeometry();
      sprite.positionNode = center;
      const corner = positionGeometry.xy;
      const mvCenter = modelViewMatrix.mul(vec4(center, 1)).xyz;
      let offset: V2;
      if (render.shape === 'streak') {
        const vView = modelViewMatrix.mul(vec4(velocityAttr, 0)).xyz;
        const d2 = vView.xy;
        const ln = length(d2);
        const axis = select(ln.greaterThan(1e-4), d2.div(max(ln, 1e-4)), vec2(0, 1));
        const perp = vec2(axis.y.negate(), axis.x);
        const streakLength = size.add(length(vView).mul(render.stretch).mul(aliveF));
        offset = perp.mul(corner.x.mul(size)).add(axis.mul(corner.y.mul(streakLength)));
      } else {
        const roll = attr.w.add(attr.y.mul(age));
        offset = rotate(corner, roll).mul(size);
      }
      sprite.viewPositionNode = mvCenter.add(vec3(offset, 0));

      let mask: F;
      if (render.shape === 'streak') {
        const sx = abs(uv().x.mul(2).sub(1)).oneMinus();
        const sy = abs(uv().y.mul(2).sub(1)).oneMinus();
        mask = smoothstep(0, 1, sx).mul(smoothstep(0, 0.6, sy));
      } else {
        const d = length(uv().sub(0.5)).mul(2);
        mask = smoothstep(0.3, 1.0, d).oneMinus();
      }
      let rgba: V4 = vec4(lifeColor.xyz, lifeColor.w.mul(mask));
      if (render.texture) {
        const tex = texture(render.texture, uv());
        rgba = rgba.mul(tex);
      }
      if (render.softness > 0) {
        const sceneDepth = viewportLinearDepth as unknown as F;
        const fragDepth = linearDepth() as unknown as F;
        const range = cameraFar.sub(cameraNear);
        const fade = saturate(sceneDepth.sub(fragDepth).mul(range).div(render.softness));
        rgba = vec4(rgba.xyz, rgba.w.mul(fade));
      }
      sprite.colorNode = rgba;
      sprite.transparent = true;
      sprite.depthWrite = render.depthWrite;
      sprite.depthTest = true;
      sprite.blending = render.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending;
      sprite.side = THREE.DoubleSide;
      sprite.fog = render.fog;
      sprite.name = `ParticleSprite:${eid}`;
    } else {
      const render = desc.render;
      material = render.material;
      sourceGeometry = render.geometry;
      let local: V3 = positionGeometry.mul(size);
      let normal: V3 = normalLocal;
      if (render.align === 'velocity') {
        const vl = length(velocityAttr);
        const up = select(vl.greaterThan(1e-5), velocityAttr.div(max(vl, 1e-5)), vec3(0, 1, 0));
        const ref = select(abs(up.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
        const xAxis = cross(ref, up);
        const xn = xAxis.div(max(length(xAxis), 1e-5));
        const zAxis = cross(up, xn);
        const basis = mat3(xn, up, zAxis);
        local = basis.mul(local);
        normal = basis.mul(normal);
      }
      material.positionNode = center.add(local);
      material.normalNode = transformNormalToView(normal);
      const baseColor = (material.colorNode as unknown as V4 | null) ?? null;
      material.colorNode = baseColor ? vec4(baseColor).mul(lifeColor) : lifeColor;
    }

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = sourceGeometry.index;
    for (const [name, attribute] of Object.entries(sourceGeometry.attributes)) geometry.setAttribute(name, attribute);
    geometry.instanceCount = capacity;
    const object = new THREE.Mesh(geometry, material);
    object.name = `ParticleEmitter:${eid}`;
    object.frustumCulled = false;
    object.castShadow = false;
    object.receiveShadow = false;
    object.matrixAutoUpdate = true;
    if (desc.render.kind === 'sprite') {
      // The quad geometry is owned by the emitter; dispose it with the instanced copy.
      const quad = sourceGeometry;
      geometry.addEventListener('dispose', () => quad.dispose());
    }

    return {
      eid,
      descriptor: desc,
      uniforms: u,
      buffers,
      computeInit,
      computeUpdate,
      object,
      geometry,
      ownedMaterial,
      accumulator: new SpawnAccumulator(capacity),
      live: new LiveEstimator(),
      simTime: 0,
      pendingDt: 0,
    };
  }
}

function unknownPreset(name: string): never {
  throw new Error(`ParticleSystem: unknown preset "${name}"`);
}

/** Unit quad centred on the origin, corners at ±0.5, UV 0..1. */
class ParticleQuadGeometry extends THREE.PlaneGeometry {
  constructor() {
    super(1, 1, 1, 1);
  }
}

/**
 * Unlit sprite material whose view-space position is assembled per instance
 * from the particle buffers (camera-facing quad, optional velocity stretch).
 * `positionNode` carries the particle centre so `positionWorld`, fog and the
 * velocity MRT all see the particle rather than the quad's local corner.
 */
class ParticleSpriteMaterial extends THREE.MeshBasicNodeMaterial {
  viewPositionNode: THREE.Node | null = null;

  override setupPositionView(builder: THREE.NodeBuilder): THREE.Node {
    return this.viewPositionNode ?? super.setupPositionView(builder);
  }
}
