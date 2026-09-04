import type * as THREE from 'three/webgpu';
import type { AssetManager } from '../assets/AssetManager';
import type { Disposable } from '../core/Disposable';
import type { EngineConfig } from '../core/Config';
import type { Logger } from '../core/Logger';
import type { Random } from '../core/Random';
import type { EntityWorld } from '../ecs/EntityWorld';
import type { Input } from '../input/Input';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { SparkRenderer } from '../rendering/Renderer';
import type { QualitySettings } from '../rendering/QualityPresets';

/** Everything a scene needs from the engine, handed over at creation. */
export interface SceneContext {
  readonly config: EngineConfig;
  readonly quality: QualitySettings;
  readonly renderer: SparkRenderer;
  /** Shared entity world. Scenes should destroy what they spawn in `dispose()`. */
  readonly entities: EntityWorld;
  readonly input: Input;
  /** Shared physics world (Rapier, fixed step). Scenes remove the bodies they add by destroying their entities. */
  readonly physics: PhysicsWorld;
  /** Engine-owned asset cache. Scenes `release()` what they `load*()` in `dispose()`. */
  readonly assets: AssetManager;
  /** A fresh, seeded stream for this scene. Same seed → same scene. */
  readonly random: Random;
  readonly logger: Logger;
}

/**
 * A live scene. The engine drives the lifecycle; the instance owns its three
 * objects and must release them in `dispose()`.
 */
export interface SceneInstance extends Disposable {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  fixedUpdate?(fixedDt: number): void;
  update?(dt: number, alpha: number): void;
  lateUpdate?(dt: number): void;
  /** Called when the viewport size changes. Cameras update their aspect here. */
  resize?(width: number, height: number): void;
}

export interface SceneDefinition {
  readonly name: string;
  create(context: SceneContext): Promise<SceneInstance> | SceneInstance;
}
