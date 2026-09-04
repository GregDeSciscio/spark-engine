// @spark/engine public API. Apps import from here and nowhere deeper.

export { Engine, type EngineEvents, type EngineInitOptions, type EngineState } from './core/Engine';
export {
  configFromSearch,
  resolveConfig,
  DEFAULT_CONFIG,
  QUALITY_PRESETS,
  type BackendPreference,
  type EngineConfig,
  type PartialEngineConfig,
  type QualityPreset,
} from './core/Config';
export { Clock } from './core/Clock';
export { GameLoop, type LoopCallbacks, type LoopOptions } from './core/Loop';
export { EventEmitter, type EventMap, type Listener } from './core/Events';
export { Logger, type LogLevel, type LogRecord } from './core/Logger';
export { Random } from './core/Random';
export { DisposeBag, type Disposable } from './core/Disposable';

export {
  SparkRenderer,
  RendererInitError,
  detectWebGPU,
  type ActiveBackend,
  type RendererCapabilities,
  type RenderFrameStats,
} from './rendering/Renderer';
export { QUALITY_SETTINGS, getQualitySettings, type QualitySettings } from './rendering/QualityPresets';

export * from './ecs/index';

// ---- physics (Milestone 4) ----
export * from './physics/index';

// ---- assets (Milestone 3) ----
export * from './assets/index';

// ---- vfx (Milestone 8) ----
export * from './vfx/index';

// ---- animation (Milestone 6) ----
export * from './animation/index';

export { Input, type PointerButton } from './input/Input';
export { World } from './world/World';
export type { SceneContext, SceneDefinition, SceneInstance } from './world/Scene';
export { DebugStats, type DebugSnapshot } from './debug/DebugStats';
export { exposeForCapture, type CaptureAPI } from './debug/CaptureHook';

// ---- rendering (Milestone 2) ----
export {
  RenderPipeline,
  POST_EFFECT_NAMES,
  type PostEffectName,
  type PostEffectState,
  type RenderPipelineStats,
} from './rendering/RenderPipeline';
export {
  DynamicResolutionController,
  DEFAULT_DYNAMIC_RESOLUTION,
  type DynamicResolutionOptions,
} from './rendering/DynamicResolution';
export {
  CameraRig,
  ISOMETRIC_PRESET,
  THIRD_PERSON_PRESET,
  damp,
  orbitOffset,
  decayTrauma,
  shakeAmount,
  type CameraRigOptions,
  type CameraRigPreset,
} from './rendering/CameraRig';
export { applyRoomEnvironment, applySceneEnvironment, loadHDREnvironment } from './rendering/Environment';
