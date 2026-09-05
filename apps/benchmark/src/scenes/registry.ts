import type { PartialEngineConfig, SceneDefinition } from '@spark/engine';
import { bootstrapScene } from './bootstrap';
import { entitiesScene } from './entities';
import { alleyScene } from './alley';
import { physicsScene } from './physics';
import { assetsScene } from './assets';
import { animationScene } from './animation';
import { vfxScene } from './vfx';
import { STREAMING_ENTITY_CAPACITY, streamingScene } from './streaming';
import { hudScene } from './hud';
import { lightsScene } from './lights';

/**
 * The showcase app's URL for the launcher card. In development the showcase
 * runs on its own dev server (`pnpm dev:showcase`); a build expects both apps
 * deployed side by side. `VITE_SHOWCASE_URL` overrides either.
 */
const SHOWCASE_URL: string = (import.meta.env.VITE_SHOWCASE_URL as string | undefined) ?? (import.meta.env.DEV ? 'http://localhost:5174/' : '../showcase/');

/** A card in the launcher: a scene of this app, or a link to another app (the showcase). */
export interface SceneEntry {
  /** The scene this card launches, or null when `href` points at another app. */
  readonly definition: SceneDefinition | null;
  /** Identity for the card and its thumbnail (`public/thumbs/<key>.jpg`); a scene's name for scene cards. */
  readonly key: string;
  /** External destination for cards without a scene. */
  readonly href?: string;
  /** Display name for the menu card. */
  readonly title: string;
  /** One short line on what the card shows. Controls live in the scene and the README, not here. */
  readonly blurb: string;
  /** The scene to lead with. Exactly one entry sets this. */
  readonly featured?: boolean;
}

/**
 * Every scene, in the order the menu shows them. Pairing the definition with
 * its copy here keeps the two from drifting: a new scene cannot be registered
 * without the text the launcher needs.
 */
const entries: readonly SceneEntry[] = [
  {
    definition: null,
    key: 'showcase',
    href: SHOWCASE_URL,
    title: 'The Showcase',
    blurb: 'A demo built with the engine: one operator on a neon street in the rain, hostiles, gunplay, a generated soundscape.',
    featured: true,
  },
  { definition: alleyScene, key: alleyScene.name, title: 'Rainy Alley', blurb: 'Wet brick and asphalt, puddle ripples, volumetrics, screen-space reflections, GPU rain.' },
  { definition: hudScene, key: hudScene.name, title: 'Audio & UI', blurb: 'HUD, name plates, damage numbers, spatial audio and adaptive music.' },
  { definition: streamingScene, key: streamingScene.name, title: 'Streaming District', blurb: 'A 960 m city streamed in chunks around a flying camera, with LOD and culling.' },
  { definition: physicsScene, key: physicsScene.name, title: 'Physics Arena', blurb: '300 rigid bodies, a ramp, a sensor volume and a character controller.' },
  { definition: vfxScene, key: vfxScene.name, title: 'GPU Particles', blurb: 'Embers, steam, spark bursts and a 100k-streak rain volume.' },
  { definition: animationScene, key: animationScene.name, title: 'Skeletal Animation', blurb: 'Blend trees, root motion, an additive attack layer, a crowd of sixty.' },
  { definition: lightsScene, key: lightsScene.name, title: 'Clustered Lights', blurb: '256 moving point lights over 1,600 instanced props, clustered on the GPU.' },
  { definition: entitiesScene, key: entitiesScene.name, title: 'Entities', blurb: 'Thousands of ECS entities in one instanced draw.' },
  { definition: assetsScene, key: assetsScene.name, title: 'Assets', blurb: 'GLB loading through the asset pipeline.' },
  { definition: bootstrapScene, key: bootstrapScene.name, title: 'Bootstrap', blurb: 'The smoke test: a PBR sphere grid.' },
];

const sceneEntries = entries.filter((entry): entry is SceneEntry & { definition: SceneDefinition } => entry.definition !== null);

const scenes: Record<string, SceneDefinition> = Object.fromEntries(sceneEntries.map((entry) => [entry.definition.name, entry.definition]));

/** Per-scene engine config a scene needs before the engine exists (URL params still win). */
export const ENGINE_HINTS: Record<string, Partial<Omit<PartialEngineConfig, 'container'>>> = {
  [streamingScene.name]: { entityCapacity: STREAMING_ENTITY_CAPACITY },
};

export const SCENE_ENTRIES = entries;

export const SCENE_NAMES: readonly string[] = sceneEntries.map((entry) => entry.definition.name);

export function getScene(name: string): SceneDefinition | undefined {
  return scenes[name];
}
