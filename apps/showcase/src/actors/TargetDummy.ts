import * as THREE from 'three/webgpu';
import {
  Transform,
  type AnimationGraphDef,
  type AnimationWorld,
  type Entity,
  type EntityWorld,
  type ModelAsset,
  type PhysicsWorld,
  type RenderSync,
  type WorldLabels,
} from '@spark/engine';
import { OPERATOR } from './Operator';
import type { Damageable } from '../combat/Damageable';
import type { HitZone } from '../combat/weapons';

/**
 * A stand-in enemy that only exists to be shot: a fixed capsule on the
 * `target` layer with a mannequin on it, a health bar, hit and death
 * reactions, and a respawn so the range never empties. The real enemy
 * replaces this once navigation and perception exist
 * (`docs/design/mission-shape.md`).
 */

const DUMMY_GRAPH: AnimationGraphDef = {
  params: { dead: 0 },
  layers: [
    {
      name: 'base',
      entry: 'idle',
      states: [
        { name: 'idle', clip: 'idle' },
        { name: 'hit', clip: 'hit', transitions: [{ to: 'idle', exitTime: 1, duration: 0.15 }] },
        { name: 'death', clip: 'death', transitions: [{ to: 'idle', conditions: [{ trigger: 'respawn' }], duration: 0.3 }] },
      ],
      anyState: [
        { to: 'death', conditions: [{ trigger: 'die' }], duration: 0.1 },
        { to: 'hit', conditions: [{ trigger: 'hit' }, { param: 'dead', op: '==', value: 0 }], duration: 0.08, allowSelf: true },
      ],
    },
  ],
};

const MAX_HEALTH = 100;
const RESPAWN_SECONDS = 4;

export interface TargetDummyDeps {
  readonly entities: EntityWorld;
  readonly physics: PhysicsWorld;
  readonly animation: AnimationWorld;
  readonly renderSync: RenderSync;
  readonly scene: THREE.Scene;
  readonly model: ModelAsset;
  readonly labels: WorldLabels;
}

export class TargetDummy implements Damageable {
  readonly eid: Entity;
  readonly name: string;
  health = MAX_HEALTH;
  dead = false;
  kills = 0;

  private readonly deps: TargetDummyDeps;
  private readonly root: THREE.Group;
  private readonly feetY: number;
  private respawnAt = -1;

  constructor(deps: TargetDummyDeps, name: string, position: THREE.Vector3, yaw: number) {
    this.deps = deps;
    this.name = name;
    this.feetY = position.y;
    const { entities, physics, animation, renderSync, scene, model, labels } = deps;
    const halfHeight = OPERATOR.height / 2 - OPERATOR.radius;
    this.eid = entities.create([Transform, { x: position.x, y: position.y + OPERATOR.height / 2, z: position.z, qy: Math.sin(yaw / 2), qw: Math.cos(yaw / 2) }]);
    physics.addBody(this.eid, { type: 'fixed', shape: { kind: 'capsule', halfHeight, radius: OPERATOR.radius }, layer: 'target', events: false });

    this.root = new THREE.Group();
    const visual = model.instantiate({ castShadow: true, receiveShadow: true });
    visual.position.y = -OPERATOR.height / 2;
    this.root.add(visual);
    scene.add(this.root);
    renderSync.attach(entities, this.eid, this.root);
    animation.attach(this.eid, visual, model.animations, DUMMY_GRAPH, { rootMotion: { mode: 'none' } });
    labels.attach(this.eid, { kind: 'healthbar', text: name, offsetY: 2.05 });
  }

  /** Height of a world-space hit as a fraction of the standing height. */
  heightFraction(y: number): number {
    return (y - this.feetY) / OPERATOR.height;
  }

  /** Apply damage. Returns true when this hit killed the dummy. */
  hit(zone: HitZone, damage: number, now: number): boolean {
    if (this.dead) return false;
    const { animation, labels } = this.deps;
    this.health = Math.max(0, this.health - damage);
    labels.setValue(this.eid, this.health / MAX_HEALTH);
    if (this.health === 0) {
      this.dead = true;
      this.kills += 1;
      this.respawnAt = now + RESPAWN_SECONDS;
      animation.setParam(this.eid, 'dead', 1);
      animation.setTrigger(this.eid, 'die');
      return true;
    }
    animation.setTrigger(this.eid, 'hit');
    void zone;
    return false;
  }

  fixedUpdate(now: number): void {
    if (this.dead && this.respawnAt >= 0 && now >= this.respawnAt) {
      const { animation, labels } = this.deps;
      this.dead = false;
      this.respawnAt = -1;
      this.health = MAX_HEALTH;
      labels.setValue(this.eid, 1);
      animation.setParam(this.eid, 'dead', 0);
      animation.setTrigger(this.eid, 'respawn');
    }
  }

  dispose(): void {
    const { entities, animation, scene, labels } = this.deps;
    labels.detach(this.eid);
    animation.detach(this.eid);
    scene.remove(this.root);
    entities.destroy(this.eid);
  }
}
