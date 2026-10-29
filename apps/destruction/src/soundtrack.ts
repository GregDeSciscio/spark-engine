import { DEFAULT_MAX_VOICES, resolveSpatial, semitonesToRate, type Heard } from '@spark/engine';
import { AIR, soundUrls, VOICES, type SoundName } from './sounds';

/**
 * The sandbox's sounds mixed offline, for films. A headless browser has no
 * running AudioContext to record, so tools/clip.mjs logs what the sandbox
 * played (`listen` / `heard` on the probe API) and where the camera was, and
 * this renders what the engine's audio would have put out: the same takes
 * (round-robin, never the same one twice running), pitch variance and
 * per-sound instance caps, the sfx bus's voice cap (oldest stolen),
 * equal-power panning with each sound's reach from a listener riding the
 * camera, the air looping underneath, and the master limiter.
 */

/** The listener at film time `t`: where it is and the point it looks at. */
export interface Ear {
  t: number;
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
}

/** `heard` stamped in film seconds; `ears` in time order. Stereo, `seconds` long. */
export async function mixSoundtrack(heard: readonly Heard[], ears: readonly Ear[], seconds: number, rate = 48000): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const takes = new Map<SoundName, AudioBuffer[]>();
  for (const name of new Set(heard.map((h) => h.name))) {
    takes.set(name, await Promise.all(soundUrls(name).map(async (url) => ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()))));
  }
  const last = new Map<SoundName, number>();

  // master → limiter, as AudioSystem builds it (bus and master gains are 1 at their defaults).
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  // The air was already playing when the film started (it fades in on the first click, long before).
  const air = ctx.createBufferSource();
  air.buffer = await ctx.decodeAudioData(await (await fetch(AIR.url)).arrayBuffer());
  air.loop = true;
  const airGain = ctx.createGain();
  airGain.gain.value = AIR.volume;
  air.connect(airGain).connect(limiter);
  air.start(0);

  const l = ctx.listener;
  ears.forEach((e, i) => {
    const f = [e.tx - e.x, e.ty - e.y, e.tz - e.z];
    const fl = Math.hypot(f[0]!, f[1]!, f[2]!) || 1;
    const [fx, fy, fz] = f.map((v) => v / fl) as [number, number, number];
    // Up is world up made square to the view: the fly camera never rolls.
    let [ux, uy, uz] = [-fy * fx, 1 - fy * fy, -fy * fz];
    const ul = Math.hypot(ux, uy, uz) || 1;
    [ux, uy, uz] = [ux / ul, uy / ul, uz / ul];
    const set = (p: AudioParam, v: number): void => {
      if (i === 0) p.setValueAtTime(v, 0);
      else p.linearRampToValueAtTime(v, e.t);
    };
    set(l.positionX, e.x);
    set(l.positionY, e.y);
    set(l.positionZ, e.z);
    set(l.forwardX, fx);
    set(l.forwardY, fy);
    set(l.forwardZ, fz);
    set(l.upX, ux);
    set(l.upY, uy);
    set(l.upZ, uz);
  });

  let seed = 0x5eed;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const live: Array<{ name: Heard['name']; end: number; gain: GainNode; source: AudioBufferSourceNode }> = [];
  let played = 0;
  let gated = 0;
  let stolen = 0;
  for (const h of heard) {
    const options = takes.get(h.name)!;
    for (let i = live.length - 1; i >= 0; i--) if (live[i]!.end <= h.t) live.splice(i, 1);
    const voice = VOICES[h.name];
    if (live.filter((v) => v.name === h.name).length >= voice.maxInstances) {
      gated++;
      continue;
    }
    if (live.length >= DEFAULT_MAX_VOICES.sfx) {
      const oldest = live.shift()!;
      oldest.gain.gain.setValueAtTime(oldest.gain.gain.value, h.t);
      oldest.gain.gain.linearRampToValueAtTime(0, h.t + 0.02);
      oldest.source.stop(h.t + 0.02);
      stolen++;
    }
    const others = options.map((_, i) => i).filter((i) => options.length === 1 || i !== last.get(h.name));
    const take = others[Math.floor(random() * others.length)]!;
    last.set(h.name, take);
    const buffer = options[take]!;
    const pitch = semitonesToRate((random() * 2 - 1) * voice.pitchVariance);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = pitch;
    const gain = ctx.createGain();
    gain.gain.value = voice.volume * h.volume;
    // As fx plays it: the engine's spatial defaults with the sound's reach.
    const spatial = resolveSpatial({ refDistance: voice.reach });
    const panner = ctx.createPanner();
    panner.panningModel = spatial.hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = spatial.distanceModel;
    panner.refDistance = spatial.refDistance;
    panner.rolloffFactor = spatial.rolloff;
    panner.maxDistance = spatial.maxDistance;
    panner.positionX.value = h.x;
    panner.positionY.value = h.y;
    panner.positionZ.value = h.z;
    source.connect(gain).connect(panner).connect(limiter);
    source.start(h.t);
    live.push({ name: h.name, end: h.t + buffer.duration / pitch, gain, source });
    played++;
  }
  console.info(`soundtrack: ${played} played, ${gated} over their instance cap, ${stolen} stolen`);
  return ctx.startRendering();
}
