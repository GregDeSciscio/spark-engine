import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../src/core/Random';
import { Transform } from '../src/ecs/components/Transform';
import { EntityWorld } from '../src/ecs/EntityWorld';
import { SharedBudget, budgetsOf, type BudgetMember } from '../src/destruction/Budget';
import { buildBuilding } from '../src/destruction/core/building';
import { findConnections } from '../src/destruction/core/connections';
import { buildStructure } from '../src/destruction/core/structure';
import { Destruction } from '../src/destruction/Destruction';
import { StrainWorkerPool, WorkerStrainHost } from '../src/destruction/strain/StrainHost';
import { StrainRunner, type StrainAnswer, type StrainEnvelope, type StrainStep } from '../src/destruction/strain/StrainRunner';
import { PhysicsWorld, initRapier } from '../src/physics/PhysicsWorld';
import { createPhysicsSystems } from '../src/physics/systems';

/**
 * Several structures in one scene (readiness gap 2): they draw on one body
 * budget and one link budget per physics world, and solve on one worker.
 */

const DT = 1 / 60;

describe('SharedBudget', () => {
  const member = (count: number, wanted: number): BudgetMember => ({ budgetCount: count, budgetWanted: wanted });

  it('one member alone sheds exactly what a budget of its own would', () => {
    const b = new SharedBudget();
    const m = member(400, 360);
    b.join(m);
    expect(b.excess(m)).toBe(40);
    expect(b.excess(m, 1.25)).toBe(0);
    // Debris's hard cap (1.5 times the budget) on 600 bodies: down to floor(540).
    const big = member(600, 360);
    const solo = new SharedBudget();
    solo.join(big);
    expect(solo.excess(big, 1.5)).toBe(600 - Math.floor(360 * 1.5));
    expect(solo.full()).toBe(true);
  });

  it('several members share the largest limit and shed in proportion to what they hold', () => {
    const b = new SharedBudget();
    const a = member(300, 360);
    const c = member(100, 200);
    b.join(a);
    b.join(c);
    expect(b.limit).toBe(360);
    expect(b.total).toBe(400);
    expect(b.full()).toBe(true);
    // 40 over: a holds three quarters of it all.
    expect(b.excess(a)).toBe(30);
    expect(b.excess(c)).toBe(10);
    b.leave(a);
    expect(b.limit).toBe(200);
    expect(b.excess(c)).toBe(0);
  });
});

describe('two structures in one physics world', () => {
  beforeAll(async () => {
    await initRapier();
  });

  it('share one set of effects and sounds: defined once, kept while any structure lives, hosted by one', async () => {
    // One set per structure made 22 particle emitters each and defined the same sounds again, so a
    // checkpoint that rebuilt a level's buildings regenerated every emitter, and disposing one building
    // undefined the sounds of the rest.
    const entities = new EntityWorld({ capacity: 4096 });
    const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
    const defined = new Map<string, number>();
    const audio = {
      defineSound: (d: { name: string }) => defined.set(d.name, (defined.get(d.name) ?? 0) + 1),
      undefineSound: (name: string) => defined.delete(name),
      playAt: () => {},
      ambience: { play: () => {}, stop: () => {} },
    } as unknown as NonNullable<ConstructorParameters<typeof Destruction>[0]['audio']>;
    const sounds = { takes: { boom: ['b.mp3'], thud: ['t.mp3'] }, air: { url: 'air.wav', volume: 0.1 } };
    const make = (x: number): Destruction => new Destruction({ entities, physics, audio, random: new Random(7) }, { pieces: buildBuilding({ x }).pieces }, { sounds });
    const a = make(-30);
    const b = make(0);
    const c = make(30);
    // Defined once, not three times.
    expect([...defined.values()].every((n) => n === 1)).toBe(true);
    expect(defined.has('destruction-boom')).toBe(true);
    // One structure hosts the effects (their flash light); the others carry none of them.
    const hosted = (d: Destruction): number => {
      let n = 0;
      d.object.traverse((o) => {
        if ((o as { isPointLight?: boolean }).isPointLight) n++;
      });
      return n;
    };
    expect([hosted(a), hosted(b), hosted(c)]).toEqual([1, 0, 0]);
    // The host goes: the next one takes them, and the sounds stay for the rest.
    a.dispose();
    expect(hosted(b)).toBe(1);
    expect(defined.has('destruction-boom')).toBe(true);
    b.dispose();
    expect(hosted(c)).toBe(1);
    // A blast still works on the last one, and it takes the effects and sounds with it.
    expect(c.explode({ x: 31, y: 1, z: -3.8 }, 1.6)).toBeGreaterThan(0);
    c.dispose();
    expect(defined.size).toBe(0);
    entities.dispose();
    physics.dispose();
  });

  it("scale their default budgets by the quality preset's debrisBudget, but not budgets a game sets", async () => {
    const entities = new EntityWorld({ capacity: 4096 });
    const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
    const pieces = buildBuilding().pieces;
    const low = new Destruction({ entities, physics, random: new Random(7), quality: { debrisBudget: 0.5 } }, { pieces });
    expect(low.debris.options.maxBodies).toBe(180);
    expect(low.hinges.options.maxLinks).toBe(130);
    expect(budgetsOf(physics).bodies.limit).toBe(180);
    const set = new Destruction({ entities, physics, random: new Random(7), quality: { debrisBudget: 0.5 } }, { pieces: buildBuilding({ x: 30 }).pieces }, { debris: { maxBodies: 300 } });
    expect(set.debris.options.maxBodies).toBe(300);
    expect(new Destruction({ entities, physics, random: new Random(7) }, { pieces: buildBuilding({ x: -30 }).pieces }).debris.options.maxBodies).toBe(360);
    entities.dispose();
    physics.dispose();
  });

  it('draw on one body and link budget, and leave it when they go', async () => {
    const entities = new EntityWorld({ capacity: 4096 });
    const physics = await PhysicsWorld.create({ entities, fixedStepHz: 60 });
    for (const s of createPhysicsSystems(physics)) entities.addSystem(s);
    const ground = entities.create([Transform, { y: -0.5 }]);
    physics.addBody(ground, { type: 'fixed', shape: { kind: 'box', hx: 80, hy: 0.5, hz: 80 }, events: false });
    const budgets = budgetsOf(physics);
    const make = (x: number): Destruction => {
      const d = new Destruction({ entities, physics, random: new Random(7) }, { pieces: buildBuilding({ x, z: -4, width: 12, depth: 8, floors: 3 }).pieces }, { debris: { maxBodies: 40 } });
      for (const s of d.systems()) entities.addSystem(s);
      return d;
    };
    const a = make(-30);
    const b = make(10);
    expect(budgets.bodies.size).toBe(2);
    expect(budgets.links.size).toBe(2);
    expect(budgets.bodies.limit).toBe(40);

    // Both lose their ground storey: alone, each would keep up to 40 loose bodies (60 past the hard cap).
    for (const d of [a, b]) d.remove(d.pieces.filter((p) => p.max[1] < 3.0 && p.kind !== 'slab' && !(p.centroid[0] < p.min[0] + 1.5 && p.centroid[2] < -2.5)).map((p) => p.id));
    let peak = 0;
    for (let f = 0; f < 240; f++) {
      entities.runStage('fixed', DT);
      entities.runStage('late', DT);
      peak = Math.max(peak, a.stats().bodies + b.stats().bodies);
    }
    // Together they keep under the one hard cap (1.5 × 40, a step's new bodies over it at most) and settle back within the limit.
    expect(a.stats().debris.created + b.stats().debris.created).toBeGreaterThan(80);
    expect(peak).toBeLessThan(40 * 1.5 + 90);
    expect(a.stats().bodies + b.stats().bodies).toBeLessThanOrEqual(40);
    expect(budgets.bodies.total).toBe(a.stats().bodies + b.stats().bodies);

    a.dispose();
    expect(budgets.bodies.size).toBe(1);
    b.dispose();
    expect(budgets.bodies.size).toBe(0);
    expect(budgets.links.size).toBe(0);
    entities.dispose();
    physics.dispose();
  }, 60_000);
});

/** A stand-in for the module worker that speaks the same protocol, one runner per structure, answering a turn later. */
class FakeWorker {
  static made: FakeWorker[] = [];
  onmessage: ((e: { data: StrainAnswer }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly runners = new Map<number, StrainRunner>();
  readonly dropped: number[] = [];
  terminated = false;
  /** Fail on the next step request. */
  breakOnStep = false;

  constructor() {
    FakeWorker.made.push(this);
  }

  postMessage(env: StrainEnvelope): void {
    if ('drop' in env) {
      this.dropped.push(env.id);
      this.runners.delete(env.id);
      return;
    }
    if (env.msg.type === 'init') this.runners.set(env.id, new StrainRunner());
    if (env.msg.type === 'step' && this.breakOnStep) {
      queueMicrotask(() => this.onerror?.({ message: 'boom', preventDefault() {} }));
      return;
    }
    const reply = this.runners.get(env.id)!.handle(env.msg);
    if (reply) queueMicrotask(() => !this.terminated && this.onmessage?.({ data: { id: env.id, reply } }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe('StrainWorkerPool', () => {
  const saved = (globalThis as { Worker?: unknown }).Worker;
  afterEach(() => {
    (globalThis as { Worker?: unknown }).Worker = saved;
    FakeWorker.made = [];
  });
  const data = () => {
    const pieces = buildBuilding().pieces;
    return buildStructure(pieces, findConnections(pieces));
  };
  const turn = () => new Promise((r) => setTimeout(r, 0));

  it('runs every structure of a world on one worker, answers each its own, and goes with the last', async () => {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    const pool = new StrainWorkerPool();
    const a = new WorkerStrainHost(pool);
    const b = new WorkerStrainHost(pool);
    const init: string[] = [];
    a.init(data(), () => init.push('a'));
    b.init(data(), () => init.push('b'));
    await turn();
    expect(FakeWorker.made).toHaveLength(1);
    expect(init).toEqual(['a', 'b']);
    // A blow to one structure only: its step breaks things, the other's stays stable.
    const hurt = data();
    a.remove(Array.from({ length: 40 }, (_, i) => i));
    let stepA: StrainStep | null = null;
    let stepB: StrainStep | null = null;
    a.step(false, [], (s) => (stepA = s));
    b.step(false, [], (s) => (stepB = s));
    await turn();
    expect(stepA!.liveNodes).toBeLessThanOrEqual(hurt.nodeCount - 40);
    expect(stepB!.liveNodes).toBe(hurt.nodeCount);
    expect(stepB!.stable).toBe(true);
    a.dispose();
    expect(FakeWorker.made[0]!.dropped).toEqual([1]);
    expect(pool.running).toBe(true);
    b.dispose();
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    expect(pool.running).toBe(false);
  });

  it('a worker that fails moves every structure on it to the main thread, with one warning, mid-step', async () => {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    const pool = new StrainWorkerPool();
    const a = new WorkerStrainHost(pool);
    const b = new WorkerStrainHost(pool);
    const warnings: string[] = [];
    a.onFallback = b.onFallback = (reason) => warnings.push(reason);
    a.init(data(), () => {});
    b.init(data(), () => {});
    await turn();
    FakeWorker.made[0]!.breakOnStep = true;
    a.remove([0, 1, 2]);
    let answered = 0;
    a.step(false, [], () => answered++);
    b.step(false, [], () => answered++);
    await turn();
    // Both steps in flight were answered by the replay; one warning for both.
    expect(answered).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(a.mode).toBe('inline');
    expect(b.mode).toBe('inline');
    // A structure that joins later solves inline from the start, quietly.
    const c = new WorkerStrainHost(pool);
    let ready = false;
    c.init(data(), () => (ready = true));
    expect(ready).toBe(true);
    expect(c.mode).toBe('inline');
    expect(FakeWorker.made).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });
});
