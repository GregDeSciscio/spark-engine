import { defineComponentType } from '../Component';

/**
 * World-space transform. Rotation is a quaternion. Every renderable, physical
 * or otherwise positioned entity has one.
 */
export const Transform = defineComponentType(
  'Transform',
  {
    x: 'f32',
    y: 'f32',
    z: 'f32',
    qx: 'f32',
    qy: 'f32',
    qz: 'f32',
    qw: 'f32',
    sx: 'f32',
    sy: 'f32',
    sz: 'f32',
  },
  { qw: 1, sx: 1, sy: 1, sz: 1 },
);

/** Linear velocity in world units per second. Consumed by simple movers; physics-driven entities do not use it. */
export const Velocity = defineComponentType('Velocity', { x: 'f32', y: 'f32', z: 'f32' });

/** Tags an entity as renderable through the RenderSync system; the Object3D lives in its side table. */
export const Renderable = defineComponentType('Renderable', { visible: 'u8' }, { visible: 1 });
