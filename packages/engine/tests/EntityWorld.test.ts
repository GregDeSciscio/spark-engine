import { describe, expect, it } from 'vitest';
import { defineComponentType } from '../src/ecs/Component';
import { EntityWorld, not, or } from '../src/ecs/EntityWorld';
import { SideTable } from '../src/ecs/SideTable';
import { Transform, Velocity } from '../src/ecs/components/Transform';

const Health = defineComponentType('Health', { hp: 'f32', max: 'f32' }, { hp: 100, max: 100 });
const Enemy = defineComponentType('Enemy', { tier: 'u8' });

describe('EntityWorld', () => {
  it('creates entities with component data and defaults', () => {
    const w = new EntityWorld({ capacity: 64 });
    const e = w.create([Transform, { x: 1, y: 2 }], Health);
    const t = w.store(Transform);
    const h = w.store(Health);
    expect(t.x[e]).toBe(1);
    expect(t.y[e]).toBe(2);
    expect(t.qw[e]).toBe(1); // default
    expect(t.sx[e]).toBe(1);
    expect(h.hp[e]).toBe(100);
    expect(w.has(e, Transform)).toBe(true);
    expect(w.has(e, Enemy)).toBe(false);
    expect(w.count).toBe(1);
    w.dispose();
  });

  it('queries with and/not/or', () => {
    const w = new EntityWorld({ capacity: 64 });
    const a = w.create(Transform, Health);
    const b = w.create(Transform, Health, Enemy);
    const c = w.create(Transform, Velocity);
    expect([...w.query(Transform)].sort()).toEqual([a, b, c].sort());
    expect([...w.query(Transform, Health)].sort()).toEqual([a, b].sort());
    expect([...w.query(Health, not(Enemy))]).toEqual([a]);
    expect([...w.query(Transform, or(Enemy, Velocity))].sort()).toEqual([b, c].sort());
    w.dispose();
  });

  it('destroy removes the entity and clears side tables', () => {
    const w = new EntityWorld({ capacity: 64 });
    const released: string[] = [];
    const names = new SideTable<string>(w, (v) => released.push(v));
    const e = w.create(Transform);
    names.set(e, 'goblin');
    const destroyed: number[] = [];
    w.onDestroy((eid) => destroyed.push(eid));
    w.destroy(e);
    expect(w.exists(e)).toBe(false);
    expect(names.has(e)).toBe(false);
    expect(released).toEqual(['goblin']);
    expect(destroyed).toEqual([e]);
    expect(w.query(Transform).length).toBe(0);
    w.dispose();
  });

  it('re-adding a component resets its row to defaults', () => {
    const w = new EntityWorld({ capacity: 64 });
    const e = w.create([Health, { hp: 5 }]);
    const h = w.store(Health);
    expect(h.hp[e]).toBe(5);
    w.remove(e, Health);
    expect(w.has(e, Health)).toBe(false);
    w.add(e, Health);
    expect(h.hp[e]).toBe(100);
    w.dispose();
  });

  it('fires add/remove observers', () => {
    const w = new EntityWorld({ capacity: 64 });
    const added: number[] = [];
    const removed: number[] = [];
    const offAdd = w.onAdd(Enemy, (eid) => added.push(eid));
    w.onRemove(Enemy, (eid) => removed.push(eid));
    const e = w.create(Enemy);
    w.destroy(e);
    offAdd();
    w.create(Enemy);
    expect(added).toEqual([e]);
    expect(removed).toEqual([e]);
    w.dispose();
  });

  it('runs systems in stage order', () => {
    const w = new EntityWorld({ capacity: 64 });
    const log: string[] = [];
    w.addSystem({ name: 'b', stage: 'update', order: 2, run: () => log.push('b') });
    w.addSystem({ name: 'a', stage: 'update', order: 1, run: () => log.push('a') });
    w.addSystem({ name: 'f', stage: 'fixed', run: () => log.push('f') });
    w.runStage('fixed', 1 / 60);
    w.runStage('update', 1 / 60);
    expect(log).toEqual(['f', 'a', 'b']);
    expect(() => w.addSystem({ name: 'a', stage: 'update', run: () => undefined })).toThrow();
    expect(w.systems.remove('a')).toBe(true);
    w.runStage('update', 1 / 60);
    expect(log).toEqual(['f', 'a', 'b', 'b']);
    w.dispose();
  });

  it('rejects two different types with the same name', () => {
    const w = new EntityWorld({ capacity: 64 });
    const A = defineComponentType('Dup', { v: 'f32' });
    const B = defineComponentType('Dup', { v: 'f32' });
    w.store(A);
    expect(() => w.store(B)).toThrow();
    w.dispose();
  });

  it('enforces capacity', () => {
    const w = new EntityWorld({ capacity: 3 });
    w.create();
    w.create();
    w.create();
    expect(() => w.create()).toThrow();
    w.dispose();
  });

  it('a mover system integrates velocity into transform', () => {
    const w = new EntityWorld({ capacity: 64 });
    w.addSystem({
      name: 'Mover',
      stage: 'fixed',
      run(world, dt) {
        const t = world.store(Transform);
        const v = world.store(Velocity);
        for (const eid of world.query(Transform, Velocity)) {
          t.x[eid] = (t.x[eid] ?? 0) + (v.x[eid] ?? 0) * dt;
        }
      },
    });
    const e = w.create(Transform, [Velocity, { x: 60 }]);
    w.runStage('fixed', 1 / 60);
    w.runStage('fixed', 1 / 60);
    expect(w.store(Transform).x[e]).toBeCloseTo(2);
    w.dispose();
  });
});
