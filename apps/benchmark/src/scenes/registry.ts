import type { SceneDefinition } from '@spark/engine';
import { bootstrapScene } from './bootstrap';
import { entitiesScene } from './entities';
import { alleyScene } from './alley';
import { physicsScene } from './physics';
import { assetsScene } from './assets';

const scenes: Record<string, SceneDefinition> = {
  [bootstrapScene.name]: bootstrapScene,
  [entitiesScene.name]: entitiesScene,
  [alleyScene.name]: alleyScene,
  [physicsScene.name]: physicsScene,
  [assetsScene.name]: assetsScene,
};

export const SCENE_NAMES: readonly string[] = Object.keys(scenes);

export function getScene(name: string): SceneDefinition | undefined {
  return scenes[name];
}
