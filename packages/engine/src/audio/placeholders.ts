import { Random } from '../core/Random';

/**
 * Procedurally synthesised placeholder SFX, rendered once through an
 * `OfflineAudioContext` (no user gesture needed, so they are ready before the
 * real context is unlocked). They exist so the engine's audio path can be
 * exercised end to end; they are NOT a score or a sound design. Every name
 * carries the `placeholder-` prefix so nothing ships by accident. See
 * `docs/audio/cue-sheet.md` for how to replace them.
 *
 * Deterministic: noise comes from the engine `Random` with a fixed seed.
 */
export const PLACEHOLDER_NAMES = [
  'placeholder-footstep',
  'placeholder-impact',
  'placeholder-ui-click',
  'placeholder-neon-buzz',
  'placeholder-rain',
  'placeholder-music-base',
  'placeholder-music-layer',
] as const;
export type PlaceholderName = (typeof PLACEHOLDER_NAMES)[number];

export const PLACEHOLDER_SAMPLE_RATE = 44_100;
const NOISE_SEED = 0x5eed_a0d1;

/** Per-placeholder duration in seconds and whether it is meant to loop. */
export const PLACEHOLDER_SPECS: Readonly<Record<PlaceholderName, { seconds: number; loop: boolean }>> = {
  'placeholder-footstep': { seconds: 0.18, loop: false },
  'placeholder-impact': { seconds: 0.45, loop: false },
  'placeholder-ui-click': { seconds: 0.08, loop: false },
  'placeholder-neon-buzz': { seconds: 2.0, loop: true },
  'placeholder-rain': { seconds: 4.0, loop: true },
  'placeholder-music-base': { seconds: 8.0, loop: true },
  'placeholder-music-layer': { seconds: 8.0, loop: true },
};

type OfflineFactory = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineFactory(): OfflineFactory {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineFactory; webkitOfflineAudioContext?: OfflineFactory };
  const ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!ctor) throw new Error('placeholders: OfflineAudioContext is not available');
  return ctor;
}

/** A mono buffer of seeded white noise, the raw material for taps, thuds and rain. */
export function noiseBuffer(ctx: BaseAudioContext, seconds: number, random: Random): AudioBuffer {
  const length = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = random.range(-1, 1);
  return buffer;
}

function envelope(param: AudioParam, at: number, peak: number, attack: number, decay: number): void {
  param.setValueAtTime(0.0001, at);
  param.exponentialRampToValueAtTime(Math.max(0.0001, peak), at + attack);
  param.exponentialRampToValueAtTime(0.0001, at + attack + decay);
}

async function render(name: PlaceholderName, build: (ctx: OfflineAudioContext, random: Random) => void): Promise<AudioBuffer> {
  const spec = PLACEHOLDER_SPECS[name];
  const Offline = offlineFactory();
  const ctx = new Offline(1, Math.floor(spec.seconds * PLACEHOLDER_SAMPLE_RATE), PLACEHOLDER_SAMPLE_RATE);
  build(ctx, new Random(NOISE_SEED ^ hashName(name)));
  return ctx.startRendering();
}

function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Short filtered noise burst: a heel tap. */
function buildFootstep(ctx: OfflineAudioContext, random: Random): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 0.2, random);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1800, 0);
  lp.frequency.exponentialRampToValueAtTime(300, 0.15);
  const gain = ctx.createGain();
  envelope(gain.gain, 0, 0.7, 0.004, 0.14);
  src.connect(lp).connect(gain).connect(ctx.destination);
  src.start(0);
}

/** Low sine thump plus a noise crack: a body hit. */
function buildImpact(ctx: OfflineAudioContext, random: Random): void {
  const thump = ctx.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(140, 0);
  thump.frequency.exponentialRampToValueAtTime(38, 0.35);
  const thumpGain = ctx.createGain();
  envelope(thumpGain.gain, 0, 0.9, 0.005, 0.38);
  thump.connect(thumpGain).connect(ctx.destination);
  thump.start(0);
  thump.stop(0.45);

  const crack = ctx.createBufferSource();
  crack.buffer = noiseBuffer(ctx, 0.12, random);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400;
  bp.Q.value = 0.8;
  const crackGain = ctx.createGain();
  envelope(crackGain.gain, 0, 0.4, 0.002, 0.08);
  crack.connect(bp).connect(crackGain).connect(ctx.destination);
  crack.start(0);
}

/** Two quick sine blips: a UI tick. */
function buildUiClick(ctx: OfflineAudioContext): void {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(1600, 0);
  osc.frequency.setValueAtTime(2200, 0.03);
  const gain = ctx.createGain();
  envelope(gain.gain, 0, 0.35, 0.002, 0.06);
  osc.connect(gain).connect(ctx.destination);
  osc.start(0);
  osc.stop(0.08);
}

/** 120 Hz mains hum with harmonics and a slow flicker: a neon tube. Seamless at 2 s. */
function buildNeonBuzz(ctx: OfflineAudioContext): void {
  const mix = ctx.createGain();
  mix.gain.value = 0.22;
  mix.connect(ctx.destination);
  const partials: Array<[number, number, OscillatorType]> = [
    [120, 1, 'sawtooth'],
    [240, 0.45, 'square'],
    [360, 0.2, 'sine'],
    [4800, 0.05, 'sine'],
  ];
  for (const [freq, level, type] of partials) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(mix);
    osc.start(0);
    osc.stop(2.0);
  }
  // Flicker: a 2.5 Hz LFO (5 cycles in 2 s, so the loop point is continuous).
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 2.5;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.06;
  lfo.connect(lfoGain).connect(mix.gain);
  lfo.start(0);
  lfo.stop(2.0);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2600;
  mix.disconnect();
  mix.connect(lp).connect(ctx.destination);
}

/** Pink-ish filtered noise with a gentle swell: a rain bed. Crossfaded head/tail so the 4 s loop is seamless. */
function buildRain(ctx: OfflineAudioContext, random: Random): void {
  const seconds = PLACEHOLDER_SPECS['placeholder-rain'].seconds;
  const src = ctx.createBufferSource();
  const buffer = noiseBuffer(ctx, seconds, random);
  // Loop-seam fix: blend the first and last 0.25 s.
  const data = buffer.getChannelData(0);
  const seam = Math.floor(0.25 * ctx.sampleRate);
  for (let i = 0; i < seam; i++) {
    const t = i / seam;
    const head = data[i] ?? 0;
    const tail = data[data.length - seam + i] ?? 0;
    data[i] = head * t + tail * (1 - t);
  }
  src.buffer = buffer;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 3200;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 400;
  const gain = ctx.createGain();
  gain.gain.value = 0.35;
  src.connect(hp).connect(lp).connect(gain).connect(ctx.destination);
  src.start(0);
}

const CHORD_A = [110, 164.81, 220, 261.63]; // A minor-ish pad
const CHORD_B = [98, 146.83, 196, 246.94]; // G

/** Two soft chords, 4 s each, low-passed: the "there is music here" bed. */
function buildMusicBase(ctx: OfflineAudioContext): void {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  const master = ctx.createGain();
  master.gain.value = 0.16;
  lp.connect(master).connect(ctx.destination);
  const chords: Array<[number[], number]> = [
    [CHORD_A, 0],
    [CHORD_B, 4],
  ];
  for (const [notes, at] of chords) {
    for (const freq of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(1, at + 0.6);
      g.gain.setValueAtTime(1, at + 3.2);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 4);
      osc.connect(g).connect(lp);
      osc.start(at);
      osc.stop(at + 4);
    }
  }
}

/** A 16th-note arpeggio over the same chords: the intensity stem layered by `setIntensity`. */
function buildMusicLayer(ctx: OfflineAudioContext): void {
  const master = ctx.createGain();
  master.gain.value = 0.12;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 300;
  master.connect(hp).connect(ctx.destination);
  const step = 0.125; // 120 BPM 16ths
  const total = PLACEHOLDER_SPECS['placeholder-music-layer'].seconds;
  for (let i = 0; i * step < total; i++) {
    const at = i * step;
    const chord = at < 4 ? CHORD_A : CHORD_B;
    const freq = (chord[i % chord.length] ?? 220) * (i % 8 < 4 ? 2 : 4);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    envelope(g.gain, at, 0.5, 0.005, step * 0.8);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + step);
  }
}

const BUILDERS: Readonly<Record<PlaceholderName, (ctx: OfflineAudioContext, random: Random) => void>> = {
  'placeholder-footstep': buildFootstep,
  'placeholder-impact': buildImpact,
  'placeholder-ui-click': buildUiClick,
  'placeholder-neon-buzz': buildNeonBuzz,
  'placeholder-rain': buildRain,
  'placeholder-music-base': buildMusicBase,
  'placeholder-music-layer': buildMusicLayer,
};

const cache = new Map<PlaceholderName, Promise<AudioBuffer>>();

/** Render (once per page) one placeholder buffer. */
export function renderPlaceholder(name: PlaceholderName): Promise<AudioBuffer> {
  let p = cache.get(name);
  if (!p) {
    p = render(name, BUILDERS[name]);
    cache.set(name, p);
  }
  return p;
}

/** Render every placeholder. Cached; safe to call from every scene. */
export async function renderAllPlaceholders(): Promise<ReadonlyMap<PlaceholderName, AudioBuffer>> {
  const out = new Map<PlaceholderName, AudioBuffer>();
  const buffers = await Promise.all(PLACEHOLDER_NAMES.map((n) => renderPlaceholder(n)));
  PLACEHOLDER_NAMES.forEach((name, i) => out.set(name, buffers[i] as AudioBuffer));
  return out;
}

/** Forget rendered buffers (tests, hot reload). */
export function clearPlaceholderCache(): void {
  cache.clear();
}
