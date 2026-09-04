import * as THREE from 'three/webgpu';
import { Transform } from '../ecs/components/Transform';
import type { EntityWorld } from '../ecs/EntityWorld';
import type { System } from '../ecs/System';
import { Cullable } from '../world/components';
import { sphereOutline, sphereOutlineFloats } from './InspectorModel';

const RING_SEGMENTS = 16;

/**
 * Bounding-sphere outlines for every `Cullable` entity (kickoff §24 "bounding
 * boxes"), drawn as one `LineSegments` from a growable pool. Add `object` to
 * the scene and register the renderer as a late system; costs nothing while
 * disabled. The culling radius is what the culling system tests, so what you
 * see is what gets culled.
 */
export class BoundsDebugRenderer implements System {
  readonly name = 'BoundsDebugRenderer';
  readonly stage = 'late' as const;
  readonly order = 950;

  readonly object: THREE.LineSegments;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.LineBasicMaterial;
  private enabled = false;
  /** Spheres the position buffer can hold. */
  private capacity = 0;
  private disposed = false;

  constructor() {
    this.material = new THREE.LineBasicMaterial({ color: 0x4dff9a, transparent: true, opacity: 0.85, depthTest: true, fog: false });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.name = 'BoundsDebug';
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 1000;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    // Visible only once an update has written vertices (see update()).
    this.object.visible = false;
  }

  /** Rebuild the line buffer from the current Transform + Cullable rows. */
  update(world: EntityWorld): void {
    if (this.disposed || !this.enabled) return;
    const entities = world.query(Transform, Cullable);
    const floatsPerSphere = sphereOutlineFloats(RING_SEGMENTS);
    if (entities.length > this.capacity || !this.geometry.getAttribute('position')) {
      this.capacity = Math.max(entities.length, Math.ceil(this.capacity * 1.5), 64);
      const position = new THREE.BufferAttribute(new Float32Array(this.capacity * floatsPerSphere), 3);
      position.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('position', position);
    }
    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = position.array as Float32Array;
    const t = world.store(Transform);
    const c = world.store(Cullable);
    let offset = 0;
    for (const eid of entities) {
      offset = sphereOutline(t.x[eid] ?? 0, t.y[eid] ?? 0, t.z[eid] ?? 0, c.radius[eid] ?? 1, RING_SEGMENTS, out, offset);
    }
    position.needsUpdate = true;
    this.geometry.setDrawRange(0, offset / 3);
    this.geometry.computeBoundingSphere();
    // A zero-vertex draw is a WebGPU validation warning; skip the object instead.
    this.object.visible = offset > 0;
  }

  run(world: EntityWorld): void {
    this.update(world);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
