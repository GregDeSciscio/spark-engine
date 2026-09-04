import type { System } from '../ecs/System';
import type { PhysicsWorld } from './PhysicsWorld';

/** Fixed-stage orders. Gameplay systems that apply forces or move kinematics use order < 90. */
export const PHYSICS_ORDER = {
  kinematicPush: 90,
  step: 100,
  sync: 110,
} as const;

/**
 * The three fixed-stage systems that drive a PhysicsWorld:
 *
 * - `PhysicsKinematicPush` (90): Transform → kinematic bodies' next pose
 * - `PhysicsStep` (100): one Rapier step at the fixed dt, then events
 * - `PhysicsSync` (110): simulated poses → Transform, sleeping flag
 */
export function createPhysicsSystems(physics: PhysicsWorld): readonly System[] {
  return [
    {
      name: 'PhysicsKinematicPush',
      stage: 'fixed',
      order: PHYSICS_ORDER.kinematicPush,
      run: () => physics.pushKinematics(),
    },
    {
      name: 'PhysicsStep',
      stage: 'fixed',
      order: PHYSICS_ORDER.step,
      run: (_world, dt) => physics.step(dt),
    },
    {
      name: 'PhysicsSync',
      stage: 'fixed',
      order: PHYSICS_ORDER.sync,
      run: () => physics.syncTransforms(),
    },
  ];
}
