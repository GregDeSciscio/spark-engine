import type { Disposable } from '../core/Disposable';
import { Logger } from '../core/Logger';
import type { SceneContext, SceneDefinition, SceneInstance } from './Scene';

/**
 * Owns the active scene and drives its lifecycle. Exactly one scene is live at
 * a time; loading a new one disposes the previous after the new one is ready,
 * so a failed load leaves the old scene intact.
 */
export class World implements Disposable {
  private readonly log = new Logger('world');
  private current: SceneInstance | null = null;
  private currentName: string | null = null;
  private loading: Promise<SceneInstance> | null = null;
  private disposed = false;

  get scene(): SceneInstance | null {
    return this.current;
  }

  get sceneName(): string | null {
    return this.currentName;
  }

  get isLoading(): boolean {
    return this.loading !== null;
  }

  async load(definition: SceneDefinition, context: SceneContext): Promise<SceneInstance> {
    if (this.disposed) throw new Error('World: cannot load a scene into a disposed world');
    if (this.loading) {
      throw new Error(`World: scene "${definition.name}" requested while another scene is still loading`);
    }
    this.log.info(`loading scene "${definition.name}"`);
    const promise = Promise.resolve(definition.create(context));
    this.loading = promise;
    let instance: SceneInstance;
    try {
      instance = await promise;
    } finally {
      this.loading = null;
    }
    if (this.disposed) {
      instance.dispose();
      throw new Error('World: disposed while a scene was loading');
    }
    const previous = this.current;
    this.current = instance;
    this.currentName = definition.name;
    previous?.dispose();
    const { width, height } = context.renderer.size;
    instance.resize?.(width, height);
    this.log.info(`scene "${definition.name}" ready`);
    return instance;
  }

  fixedUpdate(fixedDt: number): void {
    this.current?.fixedUpdate?.(fixedDt);
  }

  update(dt: number, alpha: number): void {
    this.current?.update?.(dt, alpha);
  }

  lateUpdate(dt: number): void {
    this.current?.lateUpdate?.(dt);
  }

  resize(width: number, height: number): void {
    this.current?.resize?.(width, height);
  }

  unload(): void {
    const previous = this.current;
    this.current = null;
    this.currentName = null;
    previous?.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unload();
  }
}
