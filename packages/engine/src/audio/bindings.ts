import type { AnimationEvent, AnimationWorld } from '../animation/Animator';
import type { Entity } from '../ecs/EntityWorld';
import type { PhysicsPair, PhysicsWorld } from '../physics/PhysicsWorld';
import type { SoundPlayAtOptions, Voice } from './AudioSystem';

/** The minimum an event binding needs from the audio system. */
export interface EventAudioSink {
  playAt(sound: string, target: Entity | { x: number; y: number; z: number }, options?: SoundPlayAtOptions): Voice;
  play(sound: string, options?: SoundPlayAtOptions): Voice;
}

export interface AnimationBindingOptions {
  /** Play at the entity's Transform (default true) or flat on the bus. */
  readonly spatial?: boolean | undefined;
  /** Gain multiplier applied to every bound sound. Default 1. */
  readonly volume?: number | undefined;
  /** Only events passing this play (e.g. the player entity only, or `foot === 'L'`). */
  readonly filter?: ((event: AnimationEvent) => boolean) | undefined;
}

/**
 * Animation event name → sound name. One line in a scene wires every
 * `footstep` marker of every animator to a sound. Returns the unsubscribe.
 */
export function bindAnimationEvents(
  audio: EventAudioSink,
  animation: AnimationWorld,
  map: Readonly<Record<string, string>>,
  options: AnimationBindingOptions = {},
): () => void {
  const spatial = options.spatial ?? true;
  const volume = options.volume ?? 1;
  return animation.events.on('event', (event) => {
    const sound = map[event.name];
    if (!sound) return;
    if (options.filter && !options.filter(event)) return;
    if (spatial) audio.playAt(sound, event.eid, { volume });
    else audio.play(sound, { volume });
  });
}

export type PhysicsEventName = 'triggerEnter' | 'triggerExit' | 'collisionStart' | 'collisionEnd';

export interface PhysicsBindingOptions {
  /**
   * Relative speed (m/s) between the two bodies below which a contact is
   * silent. Named for the intent (an impulse threshold); Rapier contact-force
   * events are not wired, so the relative linear velocity stands in. Default 1.
   */
  readonly minImpulse?: number | undefined;
  /** Relative speed at which the sound reaches full volume. Default `minImpulse * 6`. */
  readonly maxImpulse?: number | undefined;
  /** Play spatially at body `a` (default true). */
  readonly spatial?: boolean | undefined;
  /** Only pairs passing this play (e.g. restrict to a layer or the player). */
  readonly filter?: ((pair: PhysicsPair, event: PhysicsEventName) => boolean) | undefined;
}

/**
 * Physics pair event → sound name, with a relative-speed threshold so resting
 * contacts stay quiet and hard hits play louder. Returns the unsubscribe.
 */
export function bindPhysicsEvents(
  audio: EventAudioSink,
  physics: PhysicsWorld,
  map: Partial<Readonly<Record<PhysicsEventName, string>>>,
  options: PhysicsBindingOptions = {},
): () => void {
  const min = options.minImpulse ?? 1;
  const max = options.maxImpulse ?? min * 6;
  const spatial = options.spatial ?? true;
  const offs: Array<() => void> = [];
  const va = { x: 0, y: 0, z: 0 };
  const vb = { x: 0, y: 0, z: 0 };
  for (const name of Object.keys(map) as PhysicsEventName[]) {
    const sound = map[name];
    if (!sound) continue;
    offs.push(
      physics.events.on(name, (pair) => {
        if (options.filter && !options.filter(pair, name)) return;
        let volume = 1;
        if (name === 'collisionStart' || name === 'collisionEnd') {
          const speed = relativeSpeed(physics, pair, va, vb);
          volume = impactVolume(speed, min, max);
          if (volume <= 0) return;
        }
        if (spatial) audio.playAt(sound, pair.a, { volume });
        else audio.play(sound, { volume });
      }),
    );
  }
  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}

/** 0 below `min`, then a curve to 1 at `max`, with a floor so soft hits are still audible. */
export function impactVolume(speed: number, min: number, max: number): number {
  if (!(speed >= min)) return 0;
  if (max <= min) return 1;
  const t = Math.min(1, (speed - min) / (max - min));
  return 0.3 + 0.7 * Math.sqrt(t);
}

function relativeSpeed(physics: PhysicsWorld, pair: PhysicsPair, va: { x: number; y: number; z: number }, vb: { x: number; y: number; z: number }): number {
  try {
    physics.getVelocity(pair.a, va);
  } catch {
    va.x = va.y = va.z = 0;
  }
  try {
    physics.getVelocity(pair.b, vb);
  } catch {
    vb.x = vb.y = vb.z = 0;
  }
  return Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z);
}
