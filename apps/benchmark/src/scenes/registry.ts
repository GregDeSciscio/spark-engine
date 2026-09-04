import type { PartialEngineConfig, SceneDefinition } from '@spark/engine';
import { bootstrapScene } from './bootstrap';
import { entitiesScene } from './entities';
import { alleyScene } from './alley';
import { physicsScene } from './physics';
import { assetsScene } from './assets';
import { animationScene } from './animation';
import { vfxScene } from './vfx';
import { STREAMING_ENTITY_CAPACITY, streamingScene } from './streaming';

const scenes: Record<string, SceneDefinition> = {
  [bootstrapScene.name]: bootstrapScene,
  [entitiesScene.name]: entitiesScene,
  [alleyScene.name]: alleyScene,
  [physicsScene.name]: physicsScene,
  [assetsScene.name]: assetsScene,
  [animationScene.name]: animationScene,
  [vfxScene.name]: vfxScene,
  [streamingScene.name]: streamingScene,
};

/** Per-scene engine config a scene needs before the engine exists (URL params still win). */
export const ENGINE_HINTS: Record<string, Partial<Omit<PartialEngineConfig, 'container'>>> = {
  [streamingScene.name]: { entityCapacity: STREAMING_ENTITY_CAPACITY },
};

export const SCENE_NAMES: readonly string[] = Object.keys(scenes);

export function getScene(name: string): SceneDefinition | undefined {
  return scenes[name];
}
