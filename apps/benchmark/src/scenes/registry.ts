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

/** A scene plus the human-facing copy the launcher menu needs. */
export interface SceneEntry {
  readonly definition: SceneDefinition;
  /** Display name for the menu card. */
  readonly title: string;
  /** One sentence on what the scene demonstrates. */
  readonly blurb: string;
  /** Controls line, or null for scenes that take no input. */
  readonly controls: string | null;
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
    definition: alleyScene,
    title: 'Rainy Alley',
    blurb:
      'Procedural brick and wet asphalt with puddle ripples, projected decals, volumetric fog and godrays, screen-space reflections, GPU rain, and an animated hero.',
    controls: 'WASD move · Shift walk · Space attack — or leave it alone and the hero walks itself',
    featured: true,
  },
  {
    definition: hudScene,
    title: 'Audio & UI',
    blurb:
      'Health and stamina HUD, floating name plates and health bars, damage numbers, footsteps, spatial neon buzz, a rain bed, and music that follows the player.',
    controls: 'WASD move · Shift walk · Space attack · Esc menu · drag to orbit',
  },
  {
    definition: streamingScene,
    title: 'Streaming District',
    blurb:
      'A 960 m procedural city streamed in 24 m chunks around a flying camera, with LOD swaps, frustum culling, and a loaded level at the origin plaza.',
    controls: 'WASD steer (A/D turn, W/S throttle) · Q/E altitude · F3 physics wireframe — hands off flies itself',
  },
  {
    definition: physicsScene,
    title: 'Physics Arena',
    blurb:
      'Rapier at the fixed step: 300 dynamic boxes and spheres in a seeded pile, a ramp, a sensor volume, a character controller, and pointer hover highlighting.',
    controls: 'WASD move · Space jump · hover to highlight · F3 physics wireframe',
  },
  {
    definition: vfxScene,
    title: 'GPU Particles',
    blurb:
      'A dark yard with fire embers, steam vents, seeded spark bursts, and a 100k-streak rain volume. Live particle counts on screen.',
    controls: 'Space muzzle flash',
  },
  {
    definition: animationScene,
    title: 'Skeletal Animation',
    blurb:
      'An idle/walk/run blend tree with root motion, an additive upper-body attack layered over locomotion, and a crowd of sixty mannequins.',
    controls: 'WASD move · Shift walk · Space attack · H hit · K die · R respawn · drag to orbit',
  },
  {
    definition: lightsScene,
    title: 'Clustered Lights',
    blurb:
      'Benchmark B: 256 moving coloured point lights over a field of 1,600 instanced props under a shadowed sun, culled per screen cluster on the GPU. ?lights=N to change the count.',
    controls: null,
  },
  {
    definition: entitiesScene,
    title: 'Entities',
    blurb: 'A few thousand ECS entities orbiting on fixed-step systems, drawn as a single instanced call.',
    controls: null,
  },
  {
    definition: assetsScene,
    title: 'Assets',
    blurb: 'GLB loading through the asset pipeline: 200 crates instantiated from one cached template.',
    controls: null,
  },
  {
    definition: bootstrapScene,
    title: 'Bootstrap',
    blurb: 'The smoke test — a PBR sphere grid sweeping roughness against metalness under one shadowed light.',
    controls: null,
  },
];

const scenes: Record<string, SceneDefinition> = Object.fromEntries(
  entries.map((entry) => [entry.definition.name, entry.definition]),
);

/** Per-scene engine config a scene needs before the engine exists (URL params still win). */
export const ENGINE_HINTS: Record<string, Partial<Omit<PartialEngineConfig, 'container'>>> = {
  [streamingScene.name]: { entityCapacity: STREAMING_ENTITY_CAPACITY },
};

export const SCENE_ENTRIES = entries;

export const SCENE_NAMES: readonly string[] = entries.map((entry) => entry.definition.name);

export function getScene(name: string): SceneDefinition | undefined {
  return scenes[name];
}
