import { defineComponentType } from '../ecs/Component';

/**
 * Marks a destructible structure's entity: the owner of every chunk's
 * collider, so a raycast against the structure reports this entity and the
 * chunk as its `part`. Numbers only (ADR-003); the runtime is
 * `Destruction.of(entities, eid)`. Written once per fixed step.
 *
 * - `chunks`: pieces the structure was built from
 * - `standing`: chunks still part of it (as of the last strain step)
 * - `loose`: debris bodies alive
 */
export const Destructible = defineComponentType('Destructible', { chunks: 'u32', standing: 'u32', loose: 'u32' });
