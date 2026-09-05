import { describe, expect, it } from 'vitest';
import { Random } from '../src/core/Random';
import { BUS_NAMES, DEFAULT_MAX_VOICES, busGain, clamp01, effectiveGain, isBusName } from '../src/audio/Buses';
import { VoicePool } from '../src/audio/VoicePool';
import { SoundGate, resolveSoundDefinition, semitonesToRate, varyPitch, varyVolume } from '../src/audio/SoundDefinition';
import { attenuation, inaudible, resolveSpatial, DEFAULT_SPATIAL } from '../src/audio/Spatial';
import { crossfadeGains, fadeCurve, intensityGain } from '../src/audio/Crossfade';
import { MusicPlayer, type MusicVoiceSource } from '../src/audio/MusicPlayer';
import { impactVolume } from '../src/audio/bindings';
import { DeadVoice, PendingVoice, type Voice } from '../src/audio/Voice';
import { SoundBank } from '../src/audio/SoundBank';
import { EmitterPool, Scatter } from '../src/audio/Emitters';
import type { AudioSystem } from '../src/audio/AudioSystem';

const fakeBuffer = {} as AudioBuffer;

describe('bus math', () => {
  it('names the four buses and validates them', () => {
    expect(BUS_NAMES).toEqual(['music', 'sfx', 'ui', 'ambience']);
    expect(isBusName('sfx')).toBe(true);
    expect(isBusName('voice')).toBe(false);
    for (const b of BUS_NAMES) expect(DEFAULT_MAX_VOICES[b]).toBeGreaterThan(0);
  });

  it('maps perceptual volume to a squared gain, muted to exactly 0', () => {
    expect(busGain(1, false)).toBe(1);
    expect(busGain(0.5, false)).toBeCloseTo(0.25);
    expect(busGain(0, false)).toBe(0);
    expect(busGain(1, true)).toBe(0);
    expect(busGain(2, false)).toBe(1);
    expect(busGain(-1, false)).toBe(0);
  });

  it('multiplies master × bus × voice and clamps the control values', () => {
    expect(effectiveGain(1, 1, 1)).toBe(1);
    expect(effectiveGain(0.5, 0.5, 2)).toBeCloseTo(0.5);
    expect(effectiveGain(0, 1, 1)).toBe(0);
    expect(effectiveGain(1, 1, -3)).toBe(0);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('VoicePool', () => {
  it('allocates up to the cap and then steals the oldest on that bus', () => {
    const pool = new VoicePool({ music: 2, sfx: 3, ui: 1, ambience: 1 });
    const a = pool.allocate('sfx');
    const b = pool.allocate('sfx');
    const c = pool.allocate('sfx');
    expect([a.steal, b.steal, c.steal]).toEqual([null, null, null]);
    expect(pool.countOn('sfx')).toBe(3);
    const d = pool.allocate('sfx');
    expect(d.steal?.id).toBe(a.slot?.id);
    expect(d.slot).not.toBeNull();
    expect(pool.countOn('sfx')).toBe(3);
    expect(pool.has(a.slot?.id ?? -1)).toBe(false);
    expect(pool.stolenCount).toBe(1);
    // Other buses are independent.
    expect(pool.allocate('music').steal).toBeNull();
    expect(pool.countOn('music')).toBe(1);
  });

  it('steals the lowest priority first and refuses to evict something more important', () => {
    const pool = new VoicePool({ music: 1, sfx: 2, ui: 1, ambience: 1 });
    const loop = pool.allocate('sfx', 10);
    const shot = pool.allocate('sfx', 0);
    const next = pool.allocate('sfx', 0);
    expect(next.steal?.id).toBe(shot.slot?.id);
    expect(pool.has(loop.slot?.id ?? -1)).toBe(true);
    // Now only the loop (10) and `next` (0) remain; a priority-0 request steals `next`, never the loop...
    const again = pool.allocate('sfx', 0);
    expect(again.steal?.id).toBe(next.slot?.id);
    // ...and with two loops of priority 10 on the bus, a priority-0 request is refused.
    const loop2 = pool.allocate('sfx', 10);
    expect(loop2.steal?.id).toBe(again.slot?.id);
    const refused = pool.allocate('sfx', 0);
    expect(refused.slot).toBeNull();
    expect(refused.steal).toBeNull();
    expect(pool.countOn('sfx')).toBe(2);
  });

  it('releases free the slot and a zero cap refuses', () => {
    const pool = new VoicePool({ music: 0, sfx: 1, ui: 1, ambience: 1 });
    expect(pool.allocate('music').slot).toBeNull();
    const a = pool.allocate('sfx');
    expect(pool.release(a.slot?.id ?? -1)).toBe(true);
    expect(pool.release(a.slot?.id ?? -1)).toBe(false);
    expect(pool.countOn('sfx')).toBe(0);
    expect(pool.allocate('sfx').steal).toBeNull();
    expect(pool.size).toBe(1);
  });
});

describe('sound definitions', () => {
  it('fills defaults and gives loops a steal priority', () => {
    const d = resolveSoundDefinition({ name: 'tap', buffer: fakeBuffer });
    expect(d).toMatchObject({ name: 'tap', url: null, bus: 'sfx', volume: 1, volumeVariance: 0, pitchVariance: 0, cooldownMs: 0, loop: false, priority: 0 });
    expect(d.maxInstances).toBe(Number.POSITIVE_INFINITY);
    expect(resolveSoundDefinition({ name: 'hum', url: '/a.ogg', loop: true }).priority).toBe(10);
    expect(resolveSoundDefinition({ name: 'hum', url: '/a.ogg', loop: true, priority: 3 }).priority).toBe(3);
  });

  it('accepts round-robin variants and keeps url as the first of them', () => {
    const def = resolveSoundDefinition({ name: 'step', urls: ['/a.ogg', '/b.ogg', '/c.ogg'] });
    expect(def.urls).toEqual(['/a.ogg', '/b.ogg', '/c.ogg']);
    expect(def.url).toBe('/a.ogg');
    expect(resolveSoundDefinition({ name: 'one', url: '/x.ogg' }).urls).toEqual(['/x.ogg']);
    expect(resolveSoundDefinition({ name: 'buf', buffer: fakeBuffer }).urls).toEqual([]);
    expect(() => resolveSoundDefinition({ name: 'both', url: '/x.ogg', urls: ['/y.ogg'] })).toThrow(/mutually exclusive/);
    expect(() => resolveSoundDefinition({ name: 'none', urls: [] })).toThrow(/must not be empty/);
  });

  it('rejects bad definitions naming the field', () => {
    expect(() => resolveSoundDefinition({ name: '', url: '/a.ogg' })).toThrow(/name/);
    expect(() => resolveSoundDefinition({ name: 'x' })).toThrow(/url, urls or buffer/);
    expect(() => resolveSoundDefinition({ name: 'x', url: '/a', buffer: fakeBuffer })).toThrow(/mutually exclusive/);
    expect(() => resolveSoundDefinition({ name: 'x', url: '/a', bus: 'voice' as never })).toThrow(/bus/);
    expect(() => resolveSoundDefinition({ name: 'x', url: '/a', volume: -1 })).toThrow(/volume/);
    expect(() => resolveSoundDefinition({ name: 'x', url: '/a', volumeVariance: 2 })).toThrow(/volumeVariance/);
    expect(() => resolveSoundDefinition({ name: 'x', url: '/a', pitchVariance: -1 })).toThrow(/pitchVariance/);
    expect(() => resolveSoundDefinition({ name: 'x', url: '/a', cooldownMs: -5 })).toThrow(/cooldownMs/);
    expect(() => resolveSoundDefinition({ name: 'x', url: '/a', maxInstances: 0 })).toThrow(/maxInstances/);
  });

  it('varies pitch and volume deterministically from the seeded stream', () => {
    expect(semitonesToRate(12)).toBeCloseTo(2);
    expect(semitonesToRate(-12)).toBeCloseTo(0.5);
    const a = new Random(7);
    const b = new Random(7);
    const ra = Array.from({ length: 5 }, () => varyPitch(a, 1, 3));
    const rb = Array.from({ length: 5 }, () => varyPitch(b, 1, 3));
    expect(ra).toEqual(rb);
    for (const r of ra) {
      expect(r).toBeGreaterThanOrEqual(semitonesToRate(-3));
      expect(r).toBeLessThanOrEqual(semitonesToRate(3));
    }
    expect(varyPitch(a, 1.5, 0)).toBe(1.5);
    const v = varyVolume(a, 0.8, 0.25);
    expect(v).toBeGreaterThanOrEqual(0.6);
    expect(v).toBeLessThanOrEqual(1.0);
    expect(varyVolume(a, 0.8, 0)).toBe(0.8);
    expect(varyVolume(a, 0, 1)).toBe(0);
  });

  it('gates by cooldown and by instance cap', () => {
    const gate = new SoundGate(100, 2);
    expect(gate.tryStart(0)).toBe(true);
    expect(gate.tryStart(50)).toBe(false); // cooldown
    expect(gate.tryStart(100)).toBe(true);
    expect(gate.active).toBe(2);
    expect(gate.tryStart(500)).toBe(false); // cap
    gate.end();
    expect(gate.tryStart(500)).toBe(true);
    expect(gate.refusedCount).toBe(2);
    gate.reset();
    expect(gate.active).toBe(0);
    expect(gate.tryStart(0)).toBe(true);
  });

  it('a zero cooldown never gates by time', () => {
    const gate = new SoundGate(0, Number.POSITIVE_INFINITY);
    for (let i = 0; i < 60; i++) expect(gate.tryStart(i)).toBe(true);
    expect(gate.active).toBe(60);
  });
});

describe('spatial attenuation', () => {
  it('matches the PannerNode formulas', () => {
    const inverse = resolveSpatial({ distanceModel: 'inverse', refDistance: 1, rolloff: 1, maxDistance: 100 });
    expect(attenuation(0.5, inverse)).toBe(1);
    expect(attenuation(1, inverse)).toBe(1);
    expect(attenuation(2, inverse)).toBeCloseTo(0.5);
    expect(attenuation(11, inverse)).toBeCloseTo(1 / 11);
    const linear = resolveSpatial({ distanceModel: 'linear', refDistance: 1, rolloff: 1, maxDistance: 11 });
    expect(attenuation(1, linear)).toBe(1);
    expect(attenuation(6, linear)).toBeCloseTo(0.5);
    expect(attenuation(11, linear)).toBe(0);
    expect(attenuation(50, linear)).toBe(0);
    const expo = resolveSpatial({ distanceModel: 'exponential', refDistance: 2, rolloff: 2, maxDistance: 100 });
    expect(attenuation(4, expo)).toBeCloseTo(0.25);
    expect(attenuation(1, DEFAULT_SPATIAL)).toBe(1);
  });

  it('flags inaudible sources', () => {
    expect(inaudible(5)).toBe(false);
    expect(inaudible(5000)).toBe(true);
    const linear = resolveSpatial({ distanceModel: 'linear', maxDistance: 10 });
    expect(inaudible(9, linear)).toBe(false);
    expect(inaudible(10, linear)).toBe(true);
  });

  it('validates the options', () => {
    expect(() => resolveSpatial({ refDistance: 0 })).toThrow(/refDistance/);
    expect(() => resolveSpatial({ rolloff: -1 })).toThrow(/rolloff/);
    expect(() => resolveSpatial({ refDistance: 5, maxDistance: 5 })).toThrow(/maxDistance/);
    expect(resolveSpatial(undefined)).toBe(DEFAULT_SPATIAL);
  });
});

describe('crossfade curves', () => {
  it('is equal-power: a² + b² = 1 across the fade', () => {
    for (let i = 0; i <= 10; i++) {
      const { a, b } = crossfadeGains(i / 10);
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
    expect(crossfadeGains(0)).toEqual({ a: 1, b: 0 });
    expect(crossfadeGains(1).a).toBeCloseTo(0);
    expect(crossfadeGains(1).b).toBeCloseTo(1);
    expect(crossfadeGains(-1)).toEqual({ a: 1, b: 0 });
    expect(crossfadeGains(0.5).a).toBeCloseTo(Math.SQRT1_2);
  });

  it('intensity gain is monotonic from 0 to 1', () => {
    let last = -1;
    for (let i = 0; i <= 20; i++) {
      const g = intensityGain(i / 20);
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
    expect(intensityGain(0)).toBe(0);
    expect(intensityGain(1)).toBeCloseTo(1);
  });

  it('samples a fade curve between two levels', () => {
    const c = fadeCurve(1, 0, 5);
    expect(c.length).toBe(5);
    expect(c[0]).toBeCloseTo(1);
    expect(c[4]).toBeCloseTo(0);
    expect(fadeCurve(0, 0.5, 1).length).toBe(2);
  });
});

describe('impact volume', () => {
  it('is silent below the threshold, floored above it, full at max', () => {
    expect(impactVolume(0.5, 1, 6)).toBe(0);
    expect(impactVolume(1, 1, 6)).toBeCloseTo(0.3);
    expect(impactVolume(6, 1, 6)).toBeCloseTo(1);
    expect(impactVolume(60, 1, 6)).toBeCloseTo(1);
    expect(impactVolume(Number.NaN, 1, 6)).toBe(0);
    expect(impactVolume(3, 3, 3)).toBe(1);
  });
});

/** A voice that records what the player asked of it. */
class RecordingVoice implements Voice {
  static nextId = 1;
  readonly id = RecordingVoice.nextId++;
  readonly pending = false;
  volume: number;
  playing = true;
  fadeOut: number | null = null;
  lastRamp = 0;
  constructor(
    readonly bus: 'music' | 'sfx' | 'ui' | 'ambience',
    readonly sound: string,
    readonly fadeIn: number,
    volume: number,
  ) {
    this.volume = volume;
  }
  isPlaying(): boolean {
    return this.playing;
  }
  stop(fade = 0): void {
    this.playing = false;
    this.fadeOut = fade;
  }
  setVolume(v: number, ramp = 0): void {
    this.volume = v;
    this.lastRamp = ramp;
  }
  setPitch(): void {}
  setPosition(): void {}
}

describe('MusicPlayer', () => {
  function makePlayer(): { player: MusicPlayer; voices: RecordingVoice[] } {
    const voices: RecordingVoice[] = [];
    const source: MusicVoiceSource = {
      play(sound, options) {
        const v = new RecordingVoice(options.bus, sound, options.fadeIn, options.volume);
        voices.push(v);
        return v;
      },
    };
    return { player: new MusicPlayer(source, 'music'), voices };
  }

  it('starts a track with fade-in on its bus and ignores a repeat', () => {
    const { player, voices } = makePlayer();
    player.play('a', { fadeIn: 2 });
    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({ bus: 'music', sound: 'a', fadeIn: 2, volume: 1 });
    player.play('a');
    expect(voices).toHaveLength(1);
    expect(player.currentTrack).toBe('a');
    expect(player.isPlaying()).toBe(true);
  });

  it('crossfades: the old track fades out over the crossfade time while the new one fades in', () => {
    const { player, voices } = makePlayer();
    player.play('a', { fadeIn: 0 });
    player.play('b', { fadeIn: 1, crossfade: 3 });
    expect(voices[0]?.playing).toBe(false);
    expect(voices[0]?.fadeOut).toBe(3);
    expect(voices[1]).toMatchObject({ sound: 'b', fadeIn: 1 });
    expect(player.stats().fadingOut).toBe(0); // the recording voice reports ended immediately
    expect(player.currentTrack).toBe('b');
  });

  it('blends an intensity stem with the equal-power curve', () => {
    const { player, voices } = makePlayer();
    player.play({ base: 'base', layer: 'layer' }, { volume: 0.8 });
    expect(voices).toHaveLength(2);
    expect(voices[1]?.volume).toBe(0);
    player.setIntensity(0.5, 0.25);
    expect(voices[1]?.volume).toBeCloseTo(0.8 * intensityGain(0.5));
    expect(voices[1]?.lastRamp).toBe(0.25);
    player.setIntensity(1);
    expect(voices[1]?.volume).toBeCloseTo(0.8);
    expect(voices[0]?.volume).toBe(0.8);
    player.setVolume(0.5);
    expect(voices[0]?.volume).toBe(0.5);
    expect(voices[1]?.volume).toBeCloseTo(0.5);
    expect(player.stats()).toMatchObject({ current: 'base+layer', intensity: 1, layered: true });
    player.stop(0.5);
    expect(voices.every((v) => !v.playing)).toBe(true);
    expect(player.currentTrack).toBeNull();
  });
});

describe('voice handles', () => {
  it('a dead voice is inert', () => {
    const v = new DeadVoice('sfx', 'x');
    expect(v.isPlaying()).toBe(false);
    v.stop();
    v.setVolume(1);
    expect(v.id).toBe(0);
  });

  it('a pending voice records settings and forwards them on bind', () => {
    const p = new PendingVoice('ambience', 'hum');
    expect(p.pending).toBe(true);
    expect(p.isPlaying()).toBe(true);
    p.setVolume(0.4);
    p.setPitch(1.2);
    p.setPosition(1, 2, 3);
    const live = new RecordingVoice('ambience', 'hum', 0, 1);
    const calls: string[] = [];
    live.setPitch = () => calls.push('pitch');
    live.setPosition = (x, y, z) => calls.push(`pos ${x},${y},${z}`);
    p.bind(live);
    expect(p.pending).toBe(false);
    expect(live.volume).toBe(0.4);
    expect(calls).toEqual(['pitch', 'pos 1,2,3']);
    p.stop(0.5);
    expect(live.playing).toBe(false);
    expect(p.isPlaying()).toBe(false);
  });

  it('a pending voice stopped before unlock reports stopped', () => {
    const p = new PendingVoice('music', 'x');
    p.stop();
    expect(p.isStopped).toBe(true);
    expect(p.pending).toBe(false);
    expect(p.isPlaying()).toBe(false);
  });
});

/** An AudioSystem stand-in that records definitions and plays. */
function fakeAudio(): { audio: AudioSystem; defined: string[]; undefined: string[]; plays: { name: string; target: unknown; options: unknown }[] } {
  const defined: string[] = [];
  const undefinedNames: string[] = [];
  const plays: { name: string; target: unknown; options: unknown }[] = [];
  const voice = (): Voice => ({ isPlaying: () => true, stop: () => undefined, setVolume: () => undefined, setPitch: () => undefined, setPosition: () => undefined }) as unknown as Voice;
  const audio = {
    defineSound: (def: { name: string }) => {
      defined.push(def.name);
      return def;
    },
    undefineSound: (name: string) => {
      undefinedNames.push(name);
      return true;
    },
    play: (name: string, options: unknown) => {
      plays.push({ name, target: null, options });
      return voice();
    },
    playAt: (name: string, target: unknown, options: unknown) => {
      plays.push({ name, target, options });
      return voice();
    },
  } as unknown as AudioSystem;
  return { audio, defined, undefined: undefinedNames, plays };
}

describe('SoundBank', () => {
  it('defines cues that have files, treats the rest as silent no-ops, and undefines on dispose', () => {
    const f = fakeAudio();
    const bank = new SoundBank(f.audio, {
      cues: [
        { name: 'shot', bus: 'sfx', files: [{ url: '/a.ogg' }, { url: '/b.ogg' }] },
        { name: 'later', bus: 'sfx', files: [] },
      ],
    });
    expect(f.defined).toEqual(['shot']);
    expect(bank.has('shot')).toBe(true);
    expect(bank.has('later')).toBe(false);
    expect(bank.missing).toEqual(['later']);
    expect(bank.play('later')).toBeNull();
    expect(bank.playAt('shot', { x: 1, y: 0, z: 0 })).not.toBeNull();
    expect(f.plays.map((p) => p.name)).toEqual(['shot']);
    bank.dispose();
    expect(f.undefined).toEqual(['shot']);
    expect(bank.has('shot')).toBe(false);
  });
});

describe('EmitterPool', () => {
  it('plays only the nearest emitters within range and re-picks as the listener moves', () => {
    const f = fakeAudio();
    const sink = { play: f.audio.play.bind(f.audio), playAt: f.audio.playAt.bind(f.audio), has: () => true };
    const pool = new EmitterPool(sink, { max: 2, repickSeconds: 1, spatial: { refDistance: 2, maxDistance: 20 } });
    pool.add({ position: { x: 0, y: 0, z: 5 }, sound: 'hum' });
    pool.add({ position: { x: 0, y: 0, z: 10 }, sound: 'hum' });
    pool.add({ position: { x: 0, y: 0, z: 15 }, sound: 'hum' });
    pool.add({ position: { x: 0, y: 0, z: 100 }, sound: 'hum' });
    pool.update(0, { x: 0, y: 0, z: 0 });
    expect(pool.playing).toBe(2);
    expect(pool.nearest).toBe(5);
    expect(f.plays.map((p) => (p.target as { z: number }).z)).toEqual([5, 10]);
    // Walk to the far end: the far emitter is now within range and the near ones are dropped.
    pool.update(1.5, { x: 0, y: 0, z: 100 });
    expect(pool.playing).toBe(1);
    expect(f.plays.at(-1)?.target).toEqual({ x: 0, y: 0, z: 100 });
    pool.stopAll();
    expect(pool.playing).toBe(0);
  });
});

describe('Scatter', () => {
  it('plays on its interval, around the listener for a positioned scatter and flat otherwise', () => {
    const f = fakeAudio();
    const sink = { play: f.audio.play.bind(f.audio), playAt: f.audio.playAt.bind(f.audio), has: () => true };
    const random = new Random(7);
    const drips = new Scatter(sink, 'drip', { interval: [1, 1], radius: [2, 4], y: 0.1 }, random);
    const thunder = new Scatter(sink, 'thunder', { interval: [5, 5] }, random);
    for (let i = 0; i < 3; i++) {
      drips.update(1, { x: 10, y: 1, z: 10 });
      thunder.update(1, { x: 10, y: 1, z: 10 });
    }
    const dripPlays = f.plays.filter((p) => p.name === 'drip');
    expect(dripPlays.length).toBe(3);
    for (const p of dripPlays) {
      const t = p.target as { x: number; y: number; z: number };
      const r = Math.hypot(t.x - 10, t.z - 10);
      expect(r).toBeGreaterThanOrEqual(2 - 1e-6);
      expect(r).toBeLessThanOrEqual(4 + 1e-6);
      expect(t.y).toBe(0.1);
    }
    expect(f.plays.filter((p) => p.name === 'thunder').length).toBe(0);
    for (let i = 0; i < 3; i++) thunder.update(1, { x: 0, y: 0, z: 0 });
    expect(f.plays.filter((p) => p.name === 'thunder').length).toBe(1);
    expect(f.plays.find((p) => p.name === 'thunder')?.target).toBeNull();
  });
});
