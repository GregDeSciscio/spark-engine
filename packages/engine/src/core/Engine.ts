import type * as THREE from 'three/webgpu';
import { Clock } from './Clock';
import { resolveConfig, type EngineConfig, type PartialEngineConfig } from './Config';
import type { Disposable } from './Disposable';
import { EventEmitter } from './Events';
import { GameLoop } from './Loop';
import { Logger } from './Logger';
import { Random } from './Random';
import { AnimationWorld } from '../animation/Animator';
import { createAnimationSystems } from '../animation/systems';
import { AssetManager } from '../assets/AssetManager';
import { AudioSystem } from '../audio/AudioSystem';
import { DebugStats } from '../debug/DebugStats';
import { SparkInspector } from '../debug/Inspector';
import { EntityWorld } from '../ecs/EntityWorld';
import { Input } from '../input/Input';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createPhysicsSystems } from '../physics/systems';
import { ParticleSystem } from '../vfx/ParticleSystem';
import { LightingSystem } from '../rendering/LightingSystem';
import { getQualitySettings, type QualitySettings } from '../rendering/QualityPresets';
import { SparkRenderer } from '../rendering/Renderer';
import { UIHost } from '../ui/UIHost';
import type { SceneDefinition, SceneInstance } from '../world/Scene';
import { World } from '../world/World';

export type EngineState = 'created' | 'initializing' | 'ready' | 'running' | 'disposed';

/**
 * `loading` phases. `scene` is the scene's own `create()` (assets, geometry;
 * indeterminate, `total` is 0). `compile` is the shader warm-up that follows:
 * `done / total` GPU pipelines ready. `sceneLoaded` follows the last one.
 */
export type LoadingPhase = 'scene' | 'compile';

export interface LoadingProgress {
  phase: LoadingPhase;
  done: number;
  total: number;
}

export interface EngineEvents extends Record<string, unknown> {
  initialized: { backend: string };
  loading: LoadingProgress;
  sceneLoaded: { name: string };
  resize: { width: number; height: number };
  frame: { frame: number; dt: number };
  error: { error: unknown; phase: string };
}

export interface EngineInitOptions {
  /** Fixed drawing-buffer size; used by the capture tool for deterministic output. */
  fixedSize?: { width: number; height: number } | undefined;
}

/**
 * The engine root. Owns every subsystem and the frame loop. Construct, then
 * `await initialize()`, then `start()`. `dispose()` tears everything down.
 */
export class Engine implements Disposable {
  readonly config: EngineConfig;
  readonly events = new EventEmitter<EngineEvents>();
  readonly clock: Clock;
  readonly loop: GameLoop;
  readonly random: Random;
  readonly world = new World();
  /** The entity model (ADR-003). Scenes spawn into it; systems run in loop stages. */
  readonly entities: EntityWorld;
  readonly logger = new Logger('engine');

  private rendererInstance: SparkRenderer | null = null;
  private assetsInstance: AssetManager | null = null;
  private inputInstance: Input | null = null;
  private physicsInstance: PhysicsWorld | null = null;
  private animationInstance: AnimationWorld | null = null;
  private vfxInstance: ParticleSystem | null = null;
  private lightingInstance: LightingSystem | null = null;
  private audioInstance: AudioSystem | null = null;
  private uiInstance: UIHost | null = null;
  private statsInstance: DebugStats | null = null;
  private inspectorInstance: SparkInspector | null = null;
  private inspectorLoading: Promise<void> | null = null;
  private quality: QualitySettings;
  private stateValue: EngineState = 'created';
  /** Whole-frame main-thread time (input → render), the number that matters against the 16.67 ms budget. */
  private cpuMs = 0;
  /** The render call alone, so simulation cost is visible as the difference. */
  private renderMs = 0;
  private frameStart = 0;
  private lastSize = { width: 0, height: 0 };

  constructor(partial: PartialEngineConfig) {
    this.config = resolveConfig(partial);
    Logger.setLevel(this.config.logLevel);
    this.quality = getQualitySettings(this.config.preset);
    this.clock = new Clock(this.config.fixedFrameDelta);
    this.random = new Random(this.config.seed);
    this.entities = new EntityWorld({ capacity: this.config.entityCapacity });
    this.loop = new GameLoop({
      fixedStepHz: this.config.fixedStepHz,
      maxSubSteps: this.config.maxSubSteps,
      clock: this.clock,
    });
    // Scene hooks run before systems in each stage: gameplay decides, systems apply.
    this.loop.setCallbacks({
      input: () => {
        this.frameStart = performance.now();
        this.inputInstance?.update();
        // Engine-level hotkey: F2 opens/closes the inspector (kickoff §25).
        if (this.inputInstance?.wasPressed('F2')) void this.toggleInspector();
      },
      fixedUpdate: (dt) => {
        this.world.fixedUpdate(dt);
        this.entities.runStage('fixed', dt);
      },
      update: (dt, alpha) => {
        this.world.update(dt, alpha);
        this.entities.runStage('update', dt);
      },
      lateUpdate: (dt) => {
        this.world.lateUpdate(dt);
        this.entities.runStage('late', dt);
      },
      render: (dt) => this.renderFrame(dt),
    });
  }

  get state(): EngineState {
    return this.stateValue;
  }

  get renderer(): SparkRenderer {
    if (!this.rendererInstance) throw new Error('Engine: renderer is not available before initialize()');
    return this.rendererInstance;
  }

  get input(): Input {
    if (!this.inputInstance) throw new Error('Engine: input is not available before initialize()');
    return this.inputInstance;
  }

  /** Rapier physics at the fixed step (ADR-002, Milestone 4). */
  get physics(): PhysicsWorld {
    if (!this.physicsInstance) throw new Error('Engine: physics is not available before initialize()');
    return this.physicsInstance;
  }

  /** Skeletal animation: state machines, blend trees, events, root motion (Milestone 6). */
  get animation(): AnimationWorld {
    if (!this.animationInstance) throw new Error('Engine: animation is not available before initialize()');
    return this.animationInstance;
  }

  /** GPU particle emitters (Milestone 8). `vfx.available` is false on the WebGL2 tier. */
  get vfx(): ParticleSystem {
    if (!this.vfxInstance) throw new Error('Engine: vfx is not available before initialize()');
    return this.vfxInstance;
  }

  /** Light budget and, on WebGPU, clustered lighting for the live scene (`rendering/LightingSystem`). */
  get lighting(): LightingSystem {
    if (!this.lightingInstance) throw new Error('Engine: lighting is not available before initialize()');
    return this.lightingInstance;
  }

  /** Ref-counted asset loading (GLB/Meshopt/KTX2/HDR, Milestone 3). */
  get assets(): AssetManager {
    if (!this.assetsInstance) throw new Error('Engine: assets are not available before initialize()');
    return this.assetsInstance;
  }

  /** WebAudio buses, voices, spatial sound, music (Milestone 10). Unlocks on the first user gesture. */
  get audio(): AudioSystem {
    if (!this.audioInstance) throw new Error('Engine: audio is not available before initialize()');
    return this.audioInstance;
  }

  /** DOM overlay host: layers, pointer capture, projection, world-space labels (Milestone 10). */
  get ui(): UIHost {
    if (!this.uiInstance) throw new Error('Engine: ui is not available before initialize()');
    return this.uiInstance;
  }

  get stats(): DebugStats | null {
    return this.statsInstance;
  }

  /** The engine inspector once it has been opened (`?inspector=1` or F2); null while it has never been requested. */
  get inspector(): SparkInspector | null {
    return this.inspectorInstance;
  }

  /**
   * Open (loading three's Inspector addon and the engine panels on first use)
   * or close the inspector. Nothing is created until the first open; closing
   * detaches it from the renderer so it costs no per-frame work.
   */
  async setInspectorVisible(visible: boolean): Promise<void> {
    if (this.stateValue !== 'ready' && this.stateValue !== 'running') return;
    if (!this.inspectorInstance) {
      if (!visible) return;
      this.inspectorLoading ??= SparkInspector.create(this)
        .then((inspector) => {
          if (this.stateValue === 'disposed') inspector.dispose();
          else this.inspectorInstance = inspector;
        })
        .catch((error: unknown) => this.logger.warn('inspector failed to load', error))
        .finally(() => {
          this.inspectorLoading = null;
        });
      await this.inspectorLoading;
    }
    this.inspectorInstance?.setVisible(visible);
  }

  toggleInspector(): Promise<void> {
    return this.setInspectorVisible(!(this.inspectorInstance?.visible ?? false));
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  setQuality(preset: EngineConfig['preset']): void {
    this.quality = getQualitySettings(preset);
    this.rendererInstance?.setQuality(this.quality);
    this.lightingInstance?.setQuality(this.quality);
  }

  async initialize(options: EngineInitOptions = {}): Promise<void> {
    if (this.stateValue !== 'created') throw new Error(`Engine: initialize() called in state "${this.stateValue}"`);
    this.stateValue = 'initializing';
    const container = this.config.container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

    try {
      this.rendererInstance = await SparkRenderer.create({
        container,
        backend: this.config.backend,
        maxPixelRatio: this.config.maxPixelRatio,
        renderScale: this.quality.renderScale * this.config.renderScale,
        quality: this.quality,
        fixedSize: options.fixedSize,
        trackTimestamp: this.config.fixedFrameDelta === null,
      });
    } catch (error) {
      this.stateValue = 'created';
      this.events.emit('error', { error, phase: 'renderer-init' });
      throw error;
    }
    // Dynamic resolution paces against measured frame time, which is meaningless
    // on a fixed clock (capture, tests), so it is real-time only.
    this.rendererInstance.setDynamicResolutionEnabled(this.config.fixedFrameDelta === null && this.quality.dynamicResolution);

    this.assetsInstance = new AssetManager({ renderer: this.rendererInstance });
    this.inputInstance = new Input(this.rendererInstance.canvas);
    this.physicsInstance = await PhysicsWorld.create({ entities: this.entities, fixedStepHz: this.config.fixedStepHz });
    for (const system of createPhysicsSystems(this.physicsInstance)) this.entities.addSystem(system);
    this.animationInstance = new AnimationWorld(this.entities);
    for (const system of createAnimationSystems(this.animationInstance)) this.entities.addSystem(system);
    // GPU particles (Milestone 8): fixed stage after physics; off on WebGL2 (ADR-001).
    this.vfxInstance = new ParticleSystem(this.entities, this.rendererInstance, { seed: this.config.seed });
    this.entities.addSystem(this.vfxInstance);
    // Lights: preset budget on both tiers, clustered point/spot lights on WebGPU (ADR-001).
    this.lightingInstance = new LightingSystem(this.entities, this.rendererInstance, this.quality);
    this.entities.addSystem(this.lightingInstance);
    // Audio + UI (Milestone 10). Both follow the live scene camera unless a scene overrides it.
    // The audio seed derives from the config, not `this.random`, so scene streams are unchanged.
    const liveCamera = (): THREE.Camera | null => this.world.scene?.camera ?? null;
    this.audioInstance = new AudioSystem({ entities: this.entities, seed: (this.config.seed ^ 0x0a5d10) >>> 0, camera: liveCamera });
    for (const system of this.audioInstance.createSystems()) this.entities.addSystem(system);
    this.audioInstance.installGestureUnlock(window);
    this.uiInstance = new UIHost({ container, renderer: this.rendererInstance, entities: this.entities, input: this.inputInstance, camera: liveCamera });
    for (const system of this.uiInstance.createSystems()) this.entities.addSystem(system);
    this.statsInstance = new DebugStats(container, this.config.debugOverlay);
    this.lastSize = { ...this.rendererInstance.size };
    this.stateValue = 'ready';
    // `overlay=0` (every capture) also suppresses the inspector, so goldens never see it.
    if (this.config.inspector && this.config.debugOverlay) await this.setInspectorVisible(true);
    this.logger.info(`initialized (backend=${this.rendererInstance.capabilities.backend}, preset=${this.config.preset})`);
    this.events.emit('initialized', { backend: this.rendererInstance.capabilities.backend });
  }

  /**
   * Build a scene, compile every shader its first frame needs, render that
   * frame, then resolve. `loading` events report the two phases; nothing is
   * presented with half its materials missing. On a running engine the loop
   * keeps rendering the previous scene meanwhile and the new one compiles
   * synchronously on its first frame, as three does by default.
   */
  async loadScene(definition: SceneDefinition): Promise<SceneInstance> {
    const renderer = this.renderer;
    this.events.emit('loading', { phase: 'scene', done: 0, total: 0 });
    const instance = await this.world.load(definition, {
      config: this.config,
      quality: this.quality,
      renderer,
      entities: this.entities,
      input: this.input,
      physics: this.physics,
      animation: this.animation,
      vfx: this.vfx,
      lighting: this.lighting,
      assets: this.assets,
      audio: this.audio,
      ui: this.ui,
      random: this.random.fork(),
      logger: new Logger(`scene:${definition.name}`),
    });
    // Adopt the scene's lights and install the clustered lights node before
    // the first render below builds the scene's render list around it.
    this.lightingInstance?.attach(instance.scene, instance.camera);
    // Shader warm-up, then the first frame. The first render of a scene creates
    // every material × pass pipeline; created synchronously that is a multi-
    // second stall of the GPU process (rAF stops) on a dense scene. The warm-up
    // creates them asynchronously and in parallel, without drawing, and waits;
    // the frame that follows then renders in one go, before the caller starts
    // the loop, so neither frame pacing nor the dynamic-resolution controller
    // ever sees a compile (docs/performance/cold-start.md).
    // A warm-up failure is a scene failure: it is the scene's first render, and a
    // throw mid-render leaves three's render state unusable, so there is no
    // synchronous fallback to fall back to.
    if (this.stateValue === 'ready') {
      if (this.config.shaderWarmUp) {
        await renderer.warmUp(instance.scene, instance.camera, (done, total) => this.events.emit('loading', { phase: 'compile', done, total }));
      }
      if (this.stateValue === 'ready') this.step();
    }
    this.events.emit('sceneLoaded', { name: definition.name });
    return instance;
  }

  /**
   * Resolves once the next frame's GPU work has completed: on a running loop
   * that is the next `frame` event plus the queue drain, on a stopped engine
   * the drain of whatever `step()` submitted. This is when a frame is on
   * screen, so it is what "ready" should wait for.
   */
  async whenPresented(): Promise<void> {
    if (this.stateValue === 'running') {
      await new Promise<void>((resolve) => this.events.once('frame', () => resolve()));
    }
    if (this.rendererInstance) await this.rendererInstance.waitForGpu();
  }

  start(): void {
    if (this.stateValue !== 'ready') throw new Error(`Engine: start() called in state "${this.stateValue}"`);
    this.stateValue = 'running';
    this.loop.start();
  }

  stop(): void {
    if (this.stateValue !== 'running') return;
    this.loop.stop();
    this.stateValue = 'ready';
  }

  /** Advance exactly one frame. Works whether or not the loop is running. */
  step(timeMs: number = performance.now()): void {
    if (this.stateValue !== 'ready' && this.stateValue !== 'running') {
      throw new Error(`Engine: step() called in state "${this.stateValue}"`);
    }
    this.loop.step(timeMs);
  }

  private renderFrame(dt: number): void {
    const renderer = this.rendererInstance;
    if (!renderer) return;
    const start = performance.now();
    const size = renderer.size;
    if (size.width !== this.lastSize.width || size.height !== this.lastSize.height) {
      this.lastSize = { ...size };
      this.world.resize(size.width, size.height);
      this.events.emit('resize', size);
    }
    const live = this.world.scene;
    if (live) {
      try {
        renderer.render(live.scene, live.camera);
      } catch (error) {
        this.events.emit('error', { error, phase: 'render' });
        throw error;
      }
    }
    const end = performance.now();
    this.renderMs = end - start;
    this.cpuMs = end - (this.frameStart || start);
    this.statsInstance?.update(end, {
      backend: renderer.capabilities.backend,
      preset: this.quality.preset,
      frame: this.clock.frame,
      elapsed: this.clock.elapsed,
      cpuMs: this.cpuMs,
      renderMs: this.renderMs,
      systemMs: this.entities.systems.lastTimings(),
      fixedSteps: this.loop.lastFixedSteps,
      render: renderer.stats(),
      lights: this.lightingInstance?.getStats(),
    });
    this.inspectorInstance?.update(this.statsInstance?.snapshot() ?? null);
    this.events.emit('frame', { frame: this.clock.frame, dt });
  }

  dispose(): void {
    if (this.stateValue === 'disposed') return;
    this.loop.stop();
    // Before the world and entities: the inspector's overlays are systems and scene objects.
    this.inspectorInstance?.dispose();
    this.inspectorInstance = null;
    this.world.dispose();
    // Before entities: `entities.dispose()` disposes systems, and the lighting system restores three's lighting host.
    this.lightingInstance?.detach();
    this.entities.dispose();
    this.lightingInstance = null;
    // After entities: destroying them releases their bodies from the live world.
    this.physicsInstance?.dispose();
    this.physicsInstance = null;
    this.animationInstance?.dispose();
    this.animationInstance = null;
    this.statsInstance?.dispose();
    this.statsInstance = null;
    // After the world: scenes unmount their UI and stop their voices in dispose().
    this.uiInstance?.dispose();
    this.uiInstance = null;
    this.audioInstance?.dispose();
    this.audioInstance = null;
    this.inputInstance?.dispose();
    this.inputInstance = null;
    // After the world: the scene has released its references, so the cache empties here.
    this.assetsInstance?.dispose();
    this.assetsInstance = null;
    this.rendererInstance?.dispose();
    this.rendererInstance = null;
    this.events.clear();
    this.stateValue = 'disposed';
    this.logger.info('disposed');
  }
}
