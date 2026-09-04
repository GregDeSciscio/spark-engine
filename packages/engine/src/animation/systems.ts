import type { System } from '../ecs/System';
import type { AnimationWorld } from './Animator';

/**
 * Stage orders. Root motion lands in the fixed stage before the physics
 * kinematic push (90) so kinematic bodies follow the animated entity; the
 * animation step runs in `update` after scene hooks (gameplay sets parameters
 * first) and before `RenderSync` in `late`.
 */
export const ANIMATION_ORDER = {
  rootMotion: 80,
  step: 0,
} as const;

/**
 * - `AnimationRootMotion` (fixed, 80): pending root deltas → Transform / Velocity
 * - `AnimationSystem` (update, 0): state machines, events, mixer pose, root-motion extraction
 */
export function createAnimationSystems(animation: AnimationWorld): readonly System[] {
  return [
    {
      name: 'AnimationRootMotion',
      stage: 'fixed',
      order: ANIMATION_ORDER.rootMotion,
      run: (world, dt) => animation.applyRootMotion(world, dt),
    },
    {
      name: 'AnimationSystem',
      stage: 'update',
      order: ANIMATION_ORDER.step,
      run: (world, dt) => animation.step(world, dt),
    },
  ];
}
