import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { Logger } from '../src/core/Logger';
import { World } from '../src/world/World';
import type { SceneContext, SceneDefinition, SceneInstance } from '../src/world/Scene';

/**
 * Scene lifecycle. The rule the engine promises is that exactly one scene is
 * live and a failed load leaves the previous one running — a scene swap that
 * disposes first and builds second would take the game down every time an
 * asset 404s.
 */

const context = { renderer: { size: { width: 1280, height: 720 } } } as unknown as SceneContext;

interface Recorded extends SceneInstance {
  readonly log: string[];
  readonly resized: [number, number][];
}

function scene(name: string, log: string[] = []): Recorded {
  const resized: [number, number][] = [];
  return {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    log,
    resized,
    fixedUpdate: (dt) => log.push(`${name}:fixed:${dt}`),
    update: (dt, alpha) => log.push(`${name}:update:${dt}:${alpha}`),
    lateUpdate: (dt) => log.push(`${name}:late:${dt}`),
    resize: (w, h) => resized.push([w, h]),
    dispose: () => log.push(`${name}:dispose`),
  };
}

function definition(name: string, instance: SceneInstance | Promise<SceneInstance> | (() => never)): SceneDefinition {
  return { name, create: typeof instance === 'function' ? instance : () => instance };
}

describe('World', () => {
  beforeEach(() => {
    Logger.setLevel('silent');
    Logger.clearRecords();
  });

  afterEach(() => {
    Logger.setLevel('info');
    Logger.clearRecords();
    vi.restoreAllMocks();
  });

  it('loads a scene, names it, and sizes it to the renderer', async () => {
    const world = new World();
    const first = scene('a');
    expect(world.scene).toBeNull();
    expect(world.sceneName).toBeNull();
    const loaded = await world.load(definition('a', first), context);
    expect(loaded).toBe(first);
    expect(world.scene).toBe(first);
    expect(world.sceneName).toBe('a');
    expect(first.resized).toEqual([[1280, 720]]);
  });

  it('disposes the previous scene only once the new one is built', async () => {
    const log: string[] = [];
    const world = new World();
    const first = scene('a', log);
    await world.load(definition('a', first), context);
    let builtWhilePreviousAlive = false;
    const second = scene('b', log);
    await world.load(
      {
        name: 'b',
        create: () => {
          builtWhilePreviousAlive = world.scene === first;
          return second;
        },
      },
      context,
    );
    expect(builtWhilePreviousAlive).toBe(true);
    expect(log).toEqual(['a:dispose']);
    expect(world.scene).toBe(second);
    expect(world.sceneName).toBe('b');
  });

  it('leaves the running scene intact when a load fails', async () => {
    const log: string[] = [];
    const world = new World();
    const first = scene('a', log);
    await world.load(definition('a', first), context);
    await expect(
      world.load(
        {
          name: 'broken',
          create: () => Promise.reject(new Error('street.glb: 404')),
        },
        context,
      ),
    ).rejects.toThrow('street.glb: 404');
    expect(world.scene).toBe(first);
    expect(world.sceneName).toBe('a');
    expect(log).toEqual([]);
    // And the world is not wedged: it can load again.
    expect(world.isLoading).toBe(false);
    await world.load(definition('c', scene('c', log)), context);
    expect(world.sceneName).toBe('c');
    expect(log).toEqual(['a:dispose']);
  });

  it('refuses a second load while one is still in flight', async () => {
    const world = new World();
    let release: ((instance: SceneInstance) => void) | null = null;
    const pending = new Promise<SceneInstance>((resolve) => {
      release = resolve;
    });
    const first = world.load(definition('slow', pending), context);
    expect(world.isLoading).toBe(true);
    await expect(world.load(definition('other', scene('other')), context)).rejects.toThrow(/still loading/);
    release?.(scene('slow'));
    await first;
    expect(world.isLoading).toBe(false);
    expect(world.sceneName).toBe('slow');
  });

  it('drives only the live scene, and passes the loop through unchanged', async () => {
    const log: string[] = [];
    const world = new World();
    const first = scene('a', log);
    await world.load(definition('a', first), context);
    log.length = 0;
    world.fixedUpdate(0.02);
    world.update(0.016, 0.5);
    world.lateUpdate(0.016);
    world.resize(800, 600);
    expect(log).toEqual(['a:fixed:0.02', 'a:update:0.016:0.5', 'a:late:0.016']);
    expect(first.resized.at(-1)).toEqual([800, 600]);
  });

  it('does nothing when there is no scene', () => {
    const world = new World();
    expect(() => {
      world.fixedUpdate(0.02);
      world.update(0.016, 0);
      world.lateUpdate(0.016);
      world.resize(100, 100);
      world.unload();
    }).not.toThrow();
  });

  it('tolerates a scene that implements none of the optional hooks', async () => {
    const world = new World();
    const bare: SceneInstance = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), dispose: () => {} };
    await world.load(definition('bare', bare), context);
    expect(() => {
      world.fixedUpdate(0.02);
      world.update(0.016, 0);
      world.lateUpdate(0.016);
      world.resize(640, 480);
    }).not.toThrow();
  });

  it('unloads and disposes on request', async () => {
    const log: string[] = [];
    const world = new World();
    await world.load(definition('a', scene('a', log)), context);
    world.unload();
    expect(world.scene).toBeNull();
    expect(world.sceneName).toBeNull();
    expect(log).toEqual(['a:dispose']);
    world.unload();
    expect(log).toEqual(['a:dispose']);
  });

  it('refuses to load into a disposed world, and disposes a scene that lands too late', async () => {
    const log: string[] = [];
    const world = new World();
    await world.load(definition('a', scene('a', log)), context);
    world.dispose();
    expect(log).toEqual(['a:dispose']);
    world.dispose();
    expect(log).toEqual(['a:dispose']);
    await expect(world.load(definition('b', scene('b', log)), context)).rejects.toThrow(/disposed world/);

    // A scene still building when the world goes away is disposed, not leaked.
    const racy = new World();
    let release: ((instance: SceneInstance) => void) | null = null;
    const pending = new Promise<SceneInstance>((resolve) => {
      release = resolve;
    });
    const inFlight = racy.load(definition('late', pending), context);
    racy.dispose();
    const late = scene('late', log);
    release?.(late);
    await expect(inFlight).rejects.toThrow(/disposed while a scene was loading/);
    expect(log).toEqual(['a:dispose', 'late:dispose']);
  });
});
