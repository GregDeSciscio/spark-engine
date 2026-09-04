import { defineComponentType } from '../ecs/Component';

/**
 * Opts an entity into `CullingSystem`. Numbers only (ADR-003).
 *
 * - `radius`: bounding-sphere radius in world units around the Transform position
 * - `maxDistance`: distance culling threshold (scaled by `quality.drawDistance`); 0 = unlimited
 * - `stamp`: frame stamp written by the culling system; internal
 */
export const Cullable = defineComponentType('Cullable', { radius: 'f32', maxDistance: 'f32', stamp: 'u32' }, { radius: 1 });

/** Unassigned LOD level: the system picks one on its next run. */
export const LOD_UNASSIGNED = 255;

/**
 * Membership in an `LODSystem` group. `group` is the id returned by
 * `LODSystem.defineGroup`; `level` is the current level (0 = nearest).
 */
export const LOD = defineComponentType('LOD', { group: 'u16', level: 'u8' }, { level: LOD_UNASSIGNED });

/**
 * A spawn point placed by `LevelLoader` from a `spark.type = 'spawn'` node.
 * `team` is the index into the loader's team list (0 when unspecified);
 * `index` is the spawn's ordinal within its level.
 */
export const SpawnPoint = defineComponentType('SpawnPoint', { team: 'u8', index: 'u16' });

/** A trigger volume placed by `LevelLoader` (`spark.type = 'trigger'`); the sensor body lives in physics. `id` is the ordinal within its level. */
export const TriggerVolume = defineComponentType('TriggerVolume', { id: 'u16' });

/** A chunk-streamed entity: which chunk it belongs to (packed key from `StreamingPlanner`). */
export const Streamed = defineComponentType('Streamed', { chunk: 'u32' });
