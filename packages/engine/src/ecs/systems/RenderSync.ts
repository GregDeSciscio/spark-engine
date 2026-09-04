import type * as THREE from 'three/webgpu';
import { Renderable, Transform } from '../components/Transform';
import type { Entity, EntityWorld } from '../EntityWorld';
import { SideTable } from '../SideTable';
import type { System } from '../System';

/**
 * Bridges entities to three.js: an entity with Transform + Renderable and an
 * Object3D registered in `RenderSync.objects` has its object's transform
 * overwritten from component data every frame (late stage, before render).
 *
 * Object3Ds are resources, so they live in a SideTable and are removed from
 * their parent when the entity is destroyed. Geometry/material ownership stays
 * with whoever created them (usually the scene), not with the entity.
 */
export class RenderSync implements System {
  readonly name = 'RenderSync';
  readonly stage = 'late' as const;
  readonly order = 1000;

  readonly objects: SideTable<THREE.Object3D>;

  constructor(world: EntityWorld) {
    this.objects = new SideTable<THREE.Object3D>(world, (object) => {
      object.removeFromParent();
    });
  }

  /** Attach an Object3D to an entity. Adds Renderable if missing. */
  attach(world: EntityWorld, eid: Entity, object: THREE.Object3D): void {
    if (!world.has(eid, Renderable)) world.add(eid, Renderable);
    this.objects.set(eid, object);
  }

  run(world: EntityWorld): void {
    const t = world.store(Transform);
    const r = world.store(Renderable);
    for (const eid of world.query(Transform, Renderable)) {
      const object = this.objects.get(eid);
      if (!object) continue;
      object.position.set(t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0);
      object.quaternion.set(t.qx[eid] ?? 0, t.qy[eid] ?? 0, t.qz[eid] ?? 0, t.qw[eid] ?? 1);
      object.scale.set(t.sx[eid] ?? 1, t.sy[eid] ?? 1, t.sz[eid] ?? 1);
      object.visible = (r.visible[eid] ?? 1) !== 0;
    }
  }

  dispose(): void {
    this.objects.dispose();
  }
}
