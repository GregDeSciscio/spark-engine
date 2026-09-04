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
  type GodraysOptions,
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
  focusDistanceAlongView,
  type CameraRigOptions,
  type CameraRigPreset,
  type FocusSink,
} from './rendering/CameraRig';
export { applyRoomEnvironment, applySceneEnvironment, loadHDREnvironment } from './rendering/Environment';
// ---- rendering (Milestone 7) ----
export {
  Decals,
  DecalPool,
  decalOrientation,
  prepareDecalMaterial,
  type DecalHandle,
  type DecalOptions,
  type DecalsOptions,
} from './rendering/Decals';
export {
  createHeightFog,
  heightFogDensity,
  heightFogFactor,
  DEFAULT_HEIGHT_FOG,
  type HeightFog,
  type HeightFogParams,
} from './rendering/HeightFog';
export {
  VolumeFogNode,
  VolumeFogSettings,
  intersectRayBox,
  DEFAULT_VOLUME_FOG,
  type VolumeFogParams,
  type VolumeFogSpot,
} from './rendering/VolumeFog';

// ---- world (Milestone 9) ----
export { Cullable, LOD, LOD_UNASSIGNED, SpawnPoint, Streamed, TriggerVolume } from './world/components';
export {
  FRUSTUM_FLOATS,
  FrustumResult,
  aabbInFrustum,
  extractFrustumPlanes,
  raySlabXZ,
  raySphere,
  sphereInFrustum,
  type FrustumResultValue,
} from './world/Frustum';
export { SpatialIndex, type SpatialIndexOptions, type SpatialIndexStats } from './world/SpatialIndex';
export { CullingSystem, isVisible, type CullingStats, type CullingSystemOptions } from './world/CullingSystem';
export { LODSystem, selectLOD, type LODGroupDefinition, type LODStats } from './world/LODSystem';
export { StreamingPlanner, type StreamingPlannerOptions } from './world/StreamingPlanner';
export {
  StreamingManager,
  type ChunkDescriptor,
  type ChunkPlacement,
  type ChunkSource,
  type StreamedAssetDefinition,
  type StreamedAssetLevel,
  type StreamedModelFactory,
  type StreamingBudget,
  type StreamingEvents,
  type StreamingManagerOptions,
  type StreamingStats,
} from './world/StreamingManager';
export {
  LevelLoader,
  collectLevelNodes,
  parseLevelNodes,
  type LevelEntityDescriptor,
  type LevelLoaderOptions,
  type LevelNode,
  type LevelPlacement,
  type LoadedLevel,
} from './world/LevelLoader';
