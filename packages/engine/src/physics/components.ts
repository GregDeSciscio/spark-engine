import { defineComponentType } from '../ecs/Component';

/** Numeric codes stored in `RigidBody.type`. */
export const BODY_TYPE = {
  dynamic: 0,
  fixed: 1,
  kinematicPosition: 2,
} as const;

export type BodyType = keyof typeof BODY_TYPE;

/**
 * Marks an entity as physically simulated. Numbers only (ADR-003): the Rapier
 * body and collider live in `PhysicsWorld`'s side tables.
 *
 * - `type`: one of `BODY_TYPE`
 * - `sleeping`: 1 when Rapier has put the body to sleep (written by PhysicsSync)
 */
export const RigidBody = defineComponentType('RigidBody', { type: 'u8', sleeping: 'u8' });

/**
 * Per-entity state for `CharacterController`: accumulated vertical velocity
 * and the grounded flag from the last move. Added by `attach()`.
 */
/** `air`: seconds since the character was last grounded (0 while grounded). Debounces Rapier's per-step grounded flag. */
export const Character = defineComponentType('Character', { vy: 'f32', grounded: 'u8', air: 'f32' });
