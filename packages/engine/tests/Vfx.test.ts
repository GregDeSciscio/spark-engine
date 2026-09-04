import { describe, expect, it } from 'vitest';
import {
  CURVE_SAMPLES,
  LiveEstimator,
  SpawnAccumulator,
  bakeColorCurve,
  bakeCurve,
  hash01,
  particleHashBase,
  particleRandom,
  resolveEmitterDescriptor,
  sampleColorCurve,
  sampleCurve,
  spawnCountForStep,
} from '../src/vfx/descriptor';
import { PARTICLE_PRESETS, PARTICLE_PRESET_NAMES, isParticlePresetName } from '../src/vfx/presets';

describe('resolveEmitterDescriptor', () => {
  it('fills defaults and returns a fully specified sprite descriptor', () => {
    const d = resolveEmitterDescriptor();
    expect(d.capacity).toBe(256);
    expect(d.rate).toBe(20);
    expect(d.lifetime).toEqual([1, 2]);
    expect(d.shape).toEqual({ kind: 'point' });
    expect(d.space).toBe('world');
    expect(d.render.kind).toBe('sprite');
    if (d.render.kind === 'sprite') {
      expect(d.render.blend).toBe('alpha');
      expect(d.render.shape).toBe('disc');
      expect(d.render.softness).toBe(0);
      expect(d.render.texture).toBeNull();
      expect(d.render.fog).toBe(true);
    }
    expect(d.noise).toEqual({ strength: 0, frequency: 1, speed: 0 });
    expect(d.wrap).toBeNull();
    expect(d.prewarm).toBe(false);
  });

  it('merges partial sprite render and noise blocks over the defaults without mutating the input', () => {
    const input = { render: { blend: 'additive' as const }, noise: { strength: 2 } };
    const d = resolveEmitterDescriptor(input);
    expect(d.render).toMatchObject({ kind: 'sprite', blend: 'additive', shape: 'disc', fog: true });
    expect(d.noise).toEqual({ strength: 2, frequency: 1, speed: 0 });
    expect(input).toEqual({ render: { blend: 'additive' }, noise: { strength: 2 } });
  });

  it('rejects invalid values with a message naming the field', () => {
    expect(() => resolveEmitterDescriptor({ capacity: 0 })).toThrow(/capacity/);
    expect(() => resolveEmitterDescriptor({ capacity: 1.5 })).toThrow(/capacity/);
    expect(() => resolveEmitterDescriptor({ capacity: 5_000_000 })).toThrow(/capacity/);
    expect(() => resolveEmitterDescriptor({ rate: -1 })).toThrow(/rate/);
    expect(() => resolveEmitterDescriptor({ lifetime: [2, 1] })).toThrow(/lifetime/);
    expect(() => resolveEmitterDescriptor({ lifetime: [0, 0] })).toThrow(/lifetime/);
    expect(() => resolveEmitterDescriptor({ spread: 1.5 })).toThrow(/spread/);
    expect(() => resolveEmitterDescriptor({ drag: -0.1 })).toThrow(/drag/);
    expect(() => resolveEmitterDescriptor({ gravity: Number.NaN })).toThrow(/gravity/);
    expect(() => resolveEmitterDescriptor({ wind: [0, 1] as unknown as [number, number, number] })).toThrow(/wind/);
    expect(() => resolveEmitterDescriptor({ shape: { kind: 'cone', radius: 1, angle: 4 } })).toThrow(/angle/);
    expect(() => resolveEmitterDescriptor({ shape: { kind: 'sphere', radius: -1 } })).toThrow(/radius/);
    expect(() => resolveEmitterDescriptor({ shape: { kind: 'blob' } as never })).toThrow(/shape kind/);
    expect(() => resolveEmitterDescriptor({ space: 'screen' as never })).toThrow(/space/);
    expect(() => resolveEmitterDescriptor({ sizeOverLife: [] })).toThrow(/sizeOverLife/);
    expect(() => resolveEmitterDescriptor({ sizeOverLife: [[0.5, 1], [0.2, 1]] })).toThrow(/sorted/);
    expect(() => resolveEmitterDescriptor({ sizeOverLife: [[1.2, 1]] })).toThrow(/outside/);
    expect(() => resolveEmitterDescriptor({ colorOverLife: [[0, 1, 1, 1]] as never })).toThrow(/5 numbers/);
    expect(() => resolveEmitterDescriptor({ render: { blend: 'screen' as never } })).toThrow(/blend/);
    expect(() => resolveEmitterDescriptor({ render: { softness: -1 } })).toThrow(/softness/);
    expect(() => resolveEmitterDescriptor({ render: { kind: 'mesh', align: 'none' } as never })).toThrow(/geometry/);
  });

  it('accepts every preset', () => {
    expect(PARTICLE_PRESET_NAMES).toEqual(['rain', 'sparks', 'smoke', 'steam', 'embers', 'muzzleFlash']);
    for (const name of PARTICLE_PRESET_NAMES) {
      expect(isParticlePresetName(name)).toBe(true);
      const d = resolveEmitterDescriptor(PARTICLE_PRESETS[name]);
      expect(d.capacity).toBeGreaterThan(0);
      expect(d.lifetime[1]).toBeGreaterThan(0);
    }
    expect(isParticlePresetName('lava')).toBe(false);
    const rain = resolveEmitterDescriptor(PARTICLE_PRESETS.rain);
    expect(rain.capacity).toBe(100_000);
    expect(rain.wrap).not.toBeNull();
    expect(rain.prewarm).toBe(true);
    expect(rain.rate).toBe(0);
  });
});

describe('curve sampling', () => {
  it('interpolates linearly between sorted keys and clamps the ends', () => {
    const keys = [
      [0, 0],
      [0.5, 1],
      [1, 0.25],
    ] as const;
    expect(sampleCurve(keys, -1)).toBe(0);
    expect(sampleCurve(keys, 0)).toBe(0);
    expect(sampleCurve(keys, 0.25)).toBeCloseTo(0.5);
    expect(sampleCurve(keys, 0.5)).toBe(1);
    expect(sampleCurve(keys, 0.75)).toBeCloseTo(0.625);
    expect(sampleCurve(keys, 1)).toBe(0.25);
    expect(sampleCurve(keys, 2)).toBe(0.25);
    expect(sampleCurve([[0.3, 4]], 0)).toBe(4);
    expect(sampleCurve([[0.3, 4]], 1)).toBe(4);
    expect(sampleCurve([], 0.5)).toBe(1);
  });

  it('handles coincident key times by taking the later key', () => {
    const keys = [
      [0, 1],
      [0.5, 1],
      [0.5, 0],
      [1, 0],
    ] as const;
    expect(sampleCurve(keys, 0.49)).toBeCloseTo(1);
    expect(sampleCurve(keys, 0.5)).toBe(1);
    expect(sampleCurve(keys, 0.51)).toBeCloseTo(0);
  });

  it('samples colour keys per channel', () => {
    const keys = [
      [0, 1, 0, 0, 0],
      [1, 0, 0, 1, 1],
    ] as const;
    expect(sampleColorCurve(keys, 0.5)).toEqual([0.5, 0, 0.5, 0.5]);
    expect(sampleColorCurve(keys, -3)).toEqual([1, 0, 0, 0]);
    expect(sampleColorCurve(keys, 3)).toEqual([0, 0, 1, 1]);
    expect(sampleColorCurve([], 0.2)).toEqual([1, 1, 1, 1]);
  });

  it('bakes evenly spaced samples for the GPU', () => {
    const baked = bakeCurve([
      [0, 0],
      [1, 1],
    ]);
    expect(baked.length).toBe(CURVE_SAMPLES);
    for (let i = 0; i < CURVE_SAMPLES; i++) expect(baked[i]).toBeCloseTo(i / (CURVE_SAMPLES - 1));
    const color = bakeColorCurve(
      [
        [0, 0, 0, 0, 1],
        [1, 2, 4, 6, 0],
      ],
      3,
    );
    expect(Array.from(color)).toEqual([0, 0, 0, 1, 1, 2, 3, 0.5, 2, 4, 6, 0]);
    expect(bakeCurve([[0, 7]], 1)).toEqual(new Float32Array([7]));
  });
});

describe('deterministic hashing', () => {
  it('is a pure function of the seed with values in [0, 1)', () => {
    const seen = new Set<number>();
    let sum = 0;
    const n = 20_000;
    for (let s = 0; s < n; s++) {
      const a = hash01(s);
      expect(a).toBe(hash01(s));
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
      seen.add(a);
      sum += a;
    }
    // Uniform-ish: mean near 0.5 and essentially no collisions among consecutive seeds.
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
    expect(seen.size).toBeGreaterThan(n - 5);
    // uint32 wrap: seeds are taken modulo 2^32, so negative and large inputs are well defined.
    expect(hash01(-1)).toBe(hash01(0xffffffff));
    expect(hash01(2 ** 32 + 5)).toBe(hash01(5));
  });

  it('matches the PCG reference for known inputs', () => {
    // Values computed from the reference formula (state = seed * 747796405 + 2891336453; ...)
    // with 32-bit wrapping arithmetic; they pin the exact bit pattern the shader produces.
    const ref = (seed: number): number => {
      const state = (Math.imul(seed >>> 0, 747796405) + 2891336453) >>> 0;
      const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
      return (((word >>> 22) ^ word) >>> 0) / 2 ** 32;
    };
    for (const seed of [0, 1, 2, 42, 1234567, 0x7fffffff, 0xdeadbeef]) expect(hash01(seed)).toBe(ref(seed));
    expect(hash01(0)).not.toBe(hash01(1));
  });

  it('derives independent streams per particle, generation and seed', () => {
    const base = particleHashBase(7, 3, 99);
    expect(base).toBe(particleHashBase(7, 3, 99));
    expect(particleHashBase(7, 3, 99)).not.toBe(particleHashBase(8, 3, 99));
    expect(particleHashBase(7, 3, 99)).not.toBe(particleHashBase(7, 4, 99));
    expect(particleHashBase(7, 3, 99)).not.toBe(particleHashBase(7, 3, 100));
    expect(particleRandom(7, 3, 99, 0)).toBe(hash01(base));
    expect(particleRandom(7, 3, 99, 5)).toBe(hash01((base + 5) >>> 0));
    expect(particleRandom(7, 3, 99, 0)).not.toBe(particleRandom(7, 3, 99, 1));
    // Same inputs on a fresh call chain: the spawn is reproducible.
    const a = Array.from({ length: 13 }, (_, k) => particleRandom(100, 2, 5, k));
    const b = Array.from({ length: 13 }, (_, k) => particleRandom(100, 2, 5, k));
    expect(a).toEqual(b);
  });
});

describe('spawn rate accounting', () => {
  it('produces integer spawns per fixed step with fractional carry', () => {
    const dt = 1 / 60;
    let carry = 0;
    let total = 0;
    const perStep: number[] = [];
    for (let i = 0; i < 60; i++) {
      const r = spawnCountForStep(100, dt, carry);
      carry = r.carry;
      total += r.count;
      perStep.push(r.count);
    }
    // 100/s at 60 Hz: 1.666.. per step, so steps alternate 1,2 and sum to exactly 100 per second.
    expect(total).toBe(100);
    expect(new Set(perStep)).toEqual(new Set([1, 2]));
    expect(carry).toBeCloseTo(0, 6);
  });

  it('carries sub-unit rates until a whole particle accrues', () => {
    let carry = 0;
    const counts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = spawnCountForStep(0.3, 1, carry);
      carry = r.carry;
      counts.push(r.count);
    }
    expect(counts).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(spawnCountForStep(0, 1, 0.4)).toEqual({ count: 0, carry: 0.4 });
    expect(spawnCountForStep(5, 0, 0.4)).toEqual({ count: 0, carry: 0.4 });
  });

  it('SpawnAccumulator queues steps and bursts and flushes them as one ring window', () => {
    const acc = new SpawnAccumulator(10);
    expect(() => new SpawnAccumulator(0)).toThrow(/capacity/);
    expect(acc.step(60, 1 / 60)).toBe(1);
    expect(acc.step(60, 1 / 60)).toBe(1);
    acc.burst(3);
    acc.burst(-2);
    acc.burst(0.9);
    expect(acc.pendingCount).toBe(5);
    expect(acc.flush()).toEqual({ start: 0, count: 5 });
    expect(acc.pendingCount).toBe(0);
    expect(acc.ringCursor).toBe(5);
    // Windows wrap around the ring.
    acc.burst(7);
    expect(acc.flush()).toEqual({ start: 5, count: 7 });
    expect(acc.ringCursor).toBe(2);
    // More than capacity in one flush clamps to the pool size.
    acc.burst(25);
    expect(acc.flush()).toEqual({ start: 2, count: 10 });
    expect(acc.ringCursor).toBe(2);
    expect(acc.flush()).toEqual({ start: 2, count: 0 });
    acc.reset();
    expect(acc.ringCursor).toBe(0);
  });

  it('LiveEstimator forgets spawns once their maximum lifetime has passed', () => {
    const live = new LiveEstimator();
    live.record(0, 10, 2);
    live.record(1, 5, 2);
    expect(live.estimate(0.5, 100)).toBe(15);
    expect(live.estimate(2, 100)).toBe(5);
    expect(live.estimate(3, 100)).toBe(0);
    live.record(4, 500, 1);
    expect(live.estimate(4.5, 64)).toBe(64);
    live.clear();
    expect(live.estimate(4.5, 64)).toBe(0);
  });
});
