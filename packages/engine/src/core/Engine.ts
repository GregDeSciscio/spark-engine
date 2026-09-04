import { Clock } from './Clock';
import { resolveConfig, type EngineConfig, type PartialEngineConfig } from './Config';
import type { Disposable } from './Disposable';
import { EventEmitter } from './Events';
import { GameLoop } from './Loop';
import { Logger } from './Logger';
import { Random } from './Random';
import { AssetManager } from '../assets/AssetManager';
import { DebugStats } from '../debug/DebugStats';
import { EntityWorld } from '../ecs/EntityWorld';
import { Input } from '../input/Input';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { createPhysicsSystems } from '../physics/systems';
import { getQualitySettings, type QualitySettings } from '../rendering/QualityPresets';
import { SparkRenderer } from '../rendering/Renderer';
import type { SceneDefinition, SceneInstance } from '../world/Scene';
import { World } from '../world/World';

export type EngineState = 'created' | 'initializing' | 'ready' | 'running' | 'disposed';

export interface EngineEvents extends Record<string, unknown> {
  initialized: { backend: string };
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
  private statsInstance: DebugStats | null = null;
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

  /** Ref-counted asset loading (GLB/Meshopt/KTX2/HDR, Milestone 3). */
  get assets(): AssetManager {
    if (!this.assetsInstance) throw new Error('Engine: assets are not available before initialize()');
    return this.assetsInstance;
  }

  get stats(): DebugStats | null {
    return this.statsInstance;
  }

  getQuality(): QualitySettings {
    return this.quality;
  }

  setQuality(preset: EngineConfig['preset']): void {
    this.quality = getQualitySettings(preset);
    this.rendererInstance?.setQuality(this.quality);
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
    this.statsInstance = new DebugStats(container, this.config.debugOverlay);
    this.lastSize = { ...this.rendererInstance.size };
    this.stateValue = 'ready';
    this.logger.info(`initialized (backend=${this.rendererInstance.capabilities.backend}, preset=${this.config.preset})`);
    this.events.emit('initialized', { backend: this.rendererInstance.capabilities.backend });
  }

  async loadScene(definition: SceneDefinition): Promise<SceneInstance> {
    const renderer = this.renderer;
    const instance = await this.world.load(definition, {
      config: this.config,
      quality: this.quality,
      renderer,
      entities: this.entities,
      input: this.input,
      physics: this.physics,
      assets: this.assets,
      random: this.random.fork(),
      logger: new Logger(`scene:${definition.name}`),
    });
    // Warm-up frame: the first render of a scene compiles every material and
    // pass pipeline (several seconds on a dense scene, during which rAF stalls).
    // Taking that hit here, before the caller starts the loop, keeps the stall
    // out of frame pacing and out of the dynamic-resolution controller's view.
    if (this.stateValue === 'ready') this.step();
    this.events.emit('sceneLoaded', { name: definition.name });
    return instance;
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
    });
    this.events.emit('frame', { frame: this.clock.frame, dt });
  }

  dispose(): void {
    if (this.stateValue === 'disposed') return;
    this.loop.stop();
    this.world.dispose();
    this.entities.dispose();
    // After entities: destroying them releases their bodies from the live world.
    this.physicsInstance?.dispose();
    this.physicsInstance = null;
    this.statsInstance?.dispose();
    this.statsInstance = null;
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
