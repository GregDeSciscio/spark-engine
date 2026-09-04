import * as THREE from 'three/webgpu';
import type { EntityWorld } from '../ecs/EntityWorld';
import type { System } from '../ecs/System';
import type { PhysicsWorld } from './PhysicsWorld';

/**
 * Draws every collider as Rapier's debug wireframe through one `LineSegments`.
 * Add `object` to the scene and register the renderer as a late-stage system
 * (or call `update()` yourself). Costs nothing while disabled.
 */
export class PhysicsDebugRenderer implements System {
  readonly name = 'PhysicsDebugRenderer';
  readonly stage = 'late' as const;
  readonly order = 900;

  readonly object: THREE.LineSegments;

  private readonly physics: PhysicsWorld;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.LineBasicMaterial;
  private enabled = false;
  private capacity = 0;
  private disposed = false;

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
    this.material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true, transparent: true, opacity: 0.9 });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.name = 'PhysicsDebug';
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 1000;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.object.visible = enabled;
    if (enabled) this.update();
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /** Rebuild the line buffers from the current physics state. */
  update(): void {
    if (this.disposed || !this.enabled) return;
    const buffers = this.physics.raw.debugRender();
    const vertices = buffers.vertices;
    const vertexCount = vertices.length / 3;

    if (vertexCount > this.capacity) {
      this.capacity = Math.max(vertexCount, Math.ceil(this.capacity * 1.5));
      const position = new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3);
      const color = new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3);
      position.setUsage(THREE.DynamicDrawUsage);
      color.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('position', position);
      this.geometry.setAttribute('color', color);
    }

    const position = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    (position.array as Float32Array).set(vertices);
    // Rapier colours are RGBA; the attribute is RGB.
    const rgba = buffers.colors;
    const rgb = color.array as Float32Array;
    for (let i = 0, j = 0; i < vertexCount; i++, j += 4) {
      rgb[i * 3] = rgba[j] ?? 1;
      rgb[i * 3 + 1] = rgba[j + 1] ?? 1;
      rgb[i * 3 + 2] = rgba[j + 2] ?? 1;
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.geometry.setDrawRange(0, vertexCount);
    this.geometry.computeBoundingSphere();
  }

  run(_world: EntityWorld): void {
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
