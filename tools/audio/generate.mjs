#!/usr/bin/env node
/**
 * Generate a game's raw sound takes with ElevenLabs:
 *
 *   node tools/audio/generate.mjs [--manifest=<path>] [--raw=<dir>] [--only=<name>[,<name>]] [--kind=sfx|voice] [--force] [--dry-run]
 *
 * Reads the manifest module (default apps/showcase/audio/manifest.mjs; see
 * manifest-loader.mjs) and writes one MP3 per cue variant into its raw folder
 * as <name>-<n>.mp3 (skipping files that exist, unless --force). Sound effects go through the text-to-sound-effects endpoint,
 * voice lines through text-to-speech with the voice picked by VOICE_ID or by
 * searching the account's voices for the manifest's description.
 *
 * Credentials: ELEVENLABS_API_KEY from the environment or from a `.env` file
 * at the repo root (git-ignored). The key never leaves this process except in
 * the `xi-api-key` header to api.elevenlabs.io.
 *
 * Costs: text-to-sound bills roughly 100 characters per second requested (a
 * 1 s one-shot ~100 credits, a 22 s bed ~2,200); --dry-run prints the plan
 * with an estimate before spending anything.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { loadManifest, manifestArg, pathArg, repoRoot } from './manifest-loader.mjs';

const API = 'https://api.elevenlabs.io';
const SFX_MODEL = 'eleven_text_to_sound_v2';
const TTS_MODEL = 'eleven_multilingual_v2';
/** Highest MP3 rate available on every tier; the build re-encodes to Ogg. */
const OUTPUT_FORMAT = 'mp3_44100_128';
/** Text-to-sound-effects accepts 0.5..30 s; long beds are cut at 22 s to leave room for the loop seam. */
const MAX_SECONDS = 22;

/** Credits per second of requested sound, from ElevenLabs' published rate (approximate). */
const CREDITS_PER_SECOND = 100;

/** PowerShell's `>` writes UTF-16; read the file as whatever it is. */
async function readEnvFile() {
  const bytes = await readFile(path.join(repoRoot, '.env'));
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  return utf16 ? new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(2)) : bytes.toString('utf8').replace(/^\uFEFF/, '');
}

export async function loadApiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  try {
    const env = await readEnvFile();
    for (const line of env.split(/\r?\n/)) {
      const m = /^\s*ELEVENLABS_API_KEY\s*=\s*"?([^"#\s]+)"?/.exec(line);
      if (m) return m[1];
    }
  } catch {
    // no .env
  }
  return null;
}

async function loadVoiceId() {
  if (process.env.ELEVENLABS_VOICE_ID) return process.env.ELEVENLABS_VOICE_ID;
  try {
    const env = await readEnvFile();
    const m = /^\s*ELEVENLABS_VOICE_ID\s*=\s*"?([^"#\s]+)"?/m.exec(env);
    if (m) return m[1];
  } catch {
    // no .env
  }
  return null;
}

function parseArgs(argv) {
  const args = { only: null, kind: null, force: false, dryRun: false, manifest: manifestArg(argv), raw: pathArg(argv, 'raw') };
  for (const raw of argv) {
    if (raw.startsWith('--only=')) args.only = new Set(raw.slice(7).split(',').filter(Boolean));
    else if (raw.startsWith('--kind=')) args.kind = raw.slice(7);
    else if (raw === '--force') args.force = true;
    else if (raw === '--dry-run') args.dryRun = true;
  }
  return args;
}

export function rawFile(rawDir, name, variant) {
  return path.join(rawDir, `${name}-${String(variant + 1).padStart(2, '0')}.mp3`);
}

async function exists(file) {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

async function request(apiKey, url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Generate one sound-effect take. */
export async function generateSfx(apiKey, cue) {
  const seconds = Math.min(MAX_SECONDS, Math.max(0.5, cue.seconds));
  return request(apiKey, `${API}/v1/sound-generation?output_format=${OUTPUT_FORMAT}`, {
    text: cue.prompt,
    model_id: SFX_MODEL,
    duration_seconds: seconds,
    prompt_influence: cue.influence ?? 0.3,
    loop: Boolean(cue.loop),
  });
}

/** Find a voice for the barks: VOICE_ID, else the first voice matching the manifest's search. */
export async function pickVoice(apiKey, voiceSearch, log) {
  const fixed = await loadVoiceId();
  if (fixed) return fixed;
  const res = await fetch(`${API}/v1/voices`, { headers: { 'xi-api-key': apiKey } });
  if (!res.ok) throw new Error(`GET /v1/voices: ${res.status}`);
  const { voices } = await res.json();
  const score = (v) => {
    const labels = Object.values(v.labels ?? {}).join(' ').toLowerCase();
    const text = `${v.name} ${labels} ${v.description ?? ''}`.toLowerCase();
    let s = 0;
    if (labels.includes(voiceSearch.gender)) s += 2;
    for (const k of voiceSearch.keywords) if (text.includes(k)) s += 1;
    return s;
  };
  const ranked = [...voices].sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  if (!best) throw new Error('no voices on this account');
  log(`  voice: ${best.name} (${best.voice_id}); set ELEVENLABS_VOICE_ID to choose another`);
  return best.voice_id;
}

/** Generate one voice line. Variants differ by stability so the takes are not identical. */
export async function generateVoice(apiKey, voiceId, cue, variant) {
  return request(apiKey, `${API}/v1/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`, {
    text: cue.prompt,
    model_id: TTS_MODEL,
    voice_settings: { stability: variant % 2 === 0 ? 0.35 : 0.5, similarity_boost: 0.8, style: 0.6, use_speaker_boost: true },
  });
}

export async function generateAll({ manifest = undefined, raw = null, only = null, kind = null, force = false, dryRun = false, log = console.log } = {}) {
  const m = await loadManifest(manifest, { raw });
  const cues = m.cues.filter((c) => (!only || only.has(c.name)) && (!kind || c.kind === kind));
  log(`manifest: ${path.relative(repoRoot, m.file)} → ${path.relative(repoRoot, m.raw)}`);
  let planned = 0;
  let credits = 0;
  const work = [];
  for (const cue of cues) {
    const variants = cue.variants ?? 1;
    for (let v = 0; v < variants; v++) {
      const file = rawFile(m.raw, cue.name, v);
      if (!force && (await exists(file))) continue;
      work.push({ cue, v, file });
      planned += 1;
      credits += cue.kind === 'voice' ? cue.prompt.length : Math.min(MAX_SECONDS, cue.seconds) * CREDITS_PER_SECOND;
    }
  }
  log(`${cues.length} cue(s), ${planned} take(s) to generate, ~${Math.round(credits).toLocaleString()} credits`);
  if (dryRun) {
    for (const w of work) log(`  ${path.basename(w.file)}  [${w.cue.kind}${w.cue.loop ? ', loop' : ''}${w.cue.kind === 'sfx' ? `, ${w.cue.seconds}s` : ''}]  ${w.cue.prompt}`);
    return { planned, generated: 0, failed: 0 };
  }
  if (planned === 0) return { planned, generated: 0, failed: 0 };
  const apiKey = await loadApiKey();
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set (environment or .env at the repo root)');
  await mkdir(m.raw, { recursive: true });
  let voiceId = null;
  let generated = 0;
  let failed = 0;
  for (const { cue, v, file } of work) {
    try {
      let bytes;
      if (cue.kind === 'voice') {
        voiceId ??= await pickVoice(apiKey, m.voiceSearch, log);
        bytes = await generateVoice(apiKey, voiceId, cue, v);
      } else {
        bytes = await generateSfx(apiKey, cue);
      }
      await writeFile(file, bytes);
      generated += 1;
      log(`  ${path.basename(file)}: ${(bytes.byteLength / 1024).toFixed(0)} KiB`);
    } catch (error) {
      failed += 1;
      log(`  ${path.basename(file)}: FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`${generated} generated, ${failed} failed`);
  return { planned, generated, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  generateAll(args)
    .then((r) => process.exit(r.failed ? 1 : 0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
