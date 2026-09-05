#!/usr/bin/env node
/**
 * Master the raw takes into game assets:
 *
 *   node tools/audio/build.mjs [--only=<name>] [--force] [--verbose]
 *
 * For every cue in tools/audio/manifest.mjs with raw takes in
 * assets/source/audio/raw/, ffmpeg:
 *
 *   one-shots   trim leading / trailing silence, mono unless `stereo`,
 *               loudness-normalise to the cue's LUFS target, 48 kHz
 *   loops       trim, normalise, then crossfade the tail into the head so the
 *               seam is silent; a loop's length shrinks by the crossfade
 *   voice       the `ganger` style adds a helmet-comms band-pass, a touch of
 *               saturation and a squelch of noise so the barks sit in the mix
 *
 * and writes Ogg Vorbis into apps/showcase/public/audio/, plus manifest.json:
 * the cue list with the engine settings and the files that exist, which the
 * game reads at scene load. Cues with no takes are listed without files, so
 * the game can fall back and the console says what is missing.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUES, LUFS } from './manifest.mjs';
import { RAW } from './generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
export const OUT = path.join(repoRoot, 'apps', 'showcase', 'public', 'audio');
const SAMPLE_RATE = 48000;
const LOOP_CROSSFADE = 0.35;
/** ffmpeg's silence detector: anything under this is "silence" for trimming. */
const TRIM_DB = -45;
const TRIM_TAIL_DB = -55;

function parseArgs(argv) {
  const args = { only: null, force: false, verbose: false };
  for (const raw of argv) {
    if (raw.startsWith('--only=')) args.only = new Set(raw.slice(7).split(',').filter(Boolean));
    else if (raw === '--force') args.force = true;
    else if (raw === '--verbose') args.verbose = true;
  }
  return args;
}

function ffmpeg(args, verbose) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', verbose ? 'warning' : 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`ffmpeg not found: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' | ')}`);
  return r;
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true });
  const d = Number.parseFloat((r.stdout || '').trim());
  return Number.isFinite(d) ? d : 0;
}

/** Measure integrated loudness (first pass of loudnorm) so the second pass is linear, not a limiter. */
function measureLoudness(file, target) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const text = r.stderr || '';
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function filtersFor(cue, measured, target) {
  const chain = [];
  chain.push(`silenceremove=start_periods=1:start_threshold=${TRIM_DB}dB:start_silence=0.02`);
  // Trim the tail: reverse, trim the (now leading) silence, reverse back.
  chain.push('areverse', `silenceremove=start_periods=1:start_threshold=${TRIM_TAIL_DB}dB:start_silence=0.05`, 'areverse');
  if (cue.voiceStyle === 'ganger') {
    // Helmet comms: band-limited, a little crunch, a floor of static.
    chain.push('highpass=f=300', 'lowpass=f=3400', 'acompressor=threshold=-18dB:ratio=4:attack=5:release=80', 'volume=1.5', 'alimiter=limit=0.9');
  }
  if (measured && Number.isFinite(Number(measured.input_i))) {
    chain.push(
      `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`,
    );
  } else {
    chain.push(`loudnorm=I=${target}:TP=-1.5:LRA=11`);
  }
  return chain.join(',');
}

/** Master one take to Ogg. Returns the output duration. */
async function masterTake(input, output, cue, tmp, verbose) {
  const target = cue.lufs ?? (cue.kind === 'voice' ? LUFS.voice : LUFS[cue.bus] ?? LUFS.sfx);
  const measured = measureLoudness(input, target);
  const channels = cue.stereo ? 2 : 1;
  const mastered = path.join(tmp, `${path.basename(output, '.ogg')}.wav`);
  ffmpeg(['-i', input, '-af', filtersFor(cue, measured, target), '-ac', String(channels), '-ar', String(SAMPLE_RATE), mastered], verbose);
  let source = mastered;
  if (cue.loop) {
    // Seamless loop: the last LOOP_CROSSFADE seconds fade into the first, then the head is cut off.
    const duration = probeDuration(mastered);
    const xf = Math.min(LOOP_CROSSFADE, duration / 4);
    const looped = path.join(tmp, `${path.basename(output, '.ogg')}-loop.wav`);
    const body = duration - xf;
    ffmpeg(
      [
        '-i', mastered,
        '-filter_complex',
        `[0:a]atrim=0:${xf.toFixed(4)},asetpts=PTS-STARTPTS[head];` +
          `[0:a]atrim=${xf.toFixed(4)}:${body.toFixed(4)},asetpts=PTS-STARTPTS[mid];` +
          `[0:a]atrim=${body.toFixed(4)},asetpts=PTS-STARTPTS[tail];` +
          `[tail][head]acrossfade=d=${xf.toFixed(4)}:c1=tri:c2=tri[seam];` +
          `[mid][seam]concat=n=2:v=0:a=1[out]`,
        '-map', '[out]', looped,
      ],
      verbose,
    );
    source = looped;
  }
  ffmpeg(['-i', source, '-c:a', 'libvorbis', '-q:a', cue.bus === 'ambience' || cue.stereo ? '6' : '5', output], verbose);
  return probeDuration(output);
}

export async function buildAll({ only = null, force = false, verbose = false, log = console.log } = {}) {
  await mkdir(OUT, { recursive: true });
  const rawFiles = new Set((await readdir(RAW).catch(() => [])).filter((f) => f.endsWith('.mp3')));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'spark-audio-'));
  const manifest = { generated: new Date().toISOString(), sampleRate: SAMPLE_RATE, cues: [] };
  let built = 0;
  let missing = 0;
  try {
    for (const cue of CUES) {
      const variants = cue.variants ?? 1;
      const files = [];
      for (let v = 0; v < variants; v++) {
        const base = `${cue.name}-${String(v + 1).padStart(2, '0')}`;
        if (!rawFiles.has(`${base}.mp3`)) continue;
        const output = path.join(OUT, `${base}.ogg`);
        const url = `/audio/${base}.ogg`;
        const selected = !only || only.has(cue.name);
        let duration = 0;
        const have = await stat(output).catch(() => null);
        if (selected && (force || !have || have.mtimeMs < (await stat(path.join(RAW, `${base}.mp3`))).mtimeMs)) {
          duration = await masterTake(path.join(RAW, `${base}.mp3`), output, cue, tmp, verbose);
          built += 1;
          log(`  ${base}.ogg  ${duration.toFixed(2)} s${cue.loop ? ' loop' : ''}`);
        } else if (have) {
          duration = probeDuration(output);
        }
        if (duration > 0) files.push({ url, duration: Math.round(duration * 1000) / 1000 });
      }
      if (files.length === 0) missing += 1;
      manifest.cues.push({
        name: cue.name,
        kind: cue.kind,
        bus: cue.bus,
        loop: Boolean(cue.loop),
        volume: cue.volume,
        volumeVariance: cue.volumeVariance ?? 0,
        pitchVariance: cue.pitchVariance ?? 0,
        cooldownMs: cue.cooldownMs ?? 0,
        maxInstances: cue.maxInstances ?? null,
        files,
      });
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  await writeFile(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const withFiles = manifest.cues.filter((c) => c.files.length > 0).length;
  log(`${built} take(s) mastered; manifest: ${withFiles}/${manifest.cues.length} cues have audio${missing ? ` (${missing} still need takes: pnpm audio:generate)` : ''}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildAll(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
