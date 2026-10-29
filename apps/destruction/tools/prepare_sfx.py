"""Build the sandbox's sound files from the ElevenLabs takes (assets/sfx/raw, recipe in assets/sfx/takes.json).

Each take is a stack of layers: every layer is trimmed to its onset (or its main snap) and leveled to the same loudness, then
mixed at its gain and delay. The mix is high-passed at 30 Hz (sub-sonic rumble only eats headroom), its silent
tail cut, leveled again and peak-limited to -1 dBFS, and written to public/sfx/<sound>-<n>.mp3 (mono, 48 kHz).
Loops (the air) keep their whole length, are filtered around the seam so it stays seamless, and are written as
public/sfx/<loop>.wav at 24 kHz: MP3's encoder padding can leave a gap where a loop wraps.
Without the limiter a plain peak cap left the sharp sounds (boom, crack, thud) 5-12 dB under the rest.

    python -I tools/prepare_sfx.py        # needs ffmpeg, numpy, scipy
"""
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy import ndimage, signal

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'assets' / 'sfx' / 'raw'
OUT = ROOT / 'public' / 'sfx'
RATE = 48000
# Loudest 100 ms of every take, K-weighted (ITU-R BS.1770): what each sound plays at before its VOICES volume.
# BS.1770's 400 ms window hears a 50 ms impact as 6-8 dB quieter than it sounds.
TARGET = -14.0
CEILING = 10 ** (-1 / 20)
# The most the limiter may take off a peak; past it the take is left quieter instead.
MAX_REDUCTION_DB = 8.0

# BS.1770 K-weighting at 48 kHz: a head-related high shelf, then a 38 Hz high-pass.
K_SHELF = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
K_HIGHPASS = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])
SUBSONIC = signal.butter(2, 30, 'highpass', fs=RATE, output='sos')
# What a laptop or phone speaker plays: little below ~250 Hz.
SMALL_SPEAKER = signal.butter(4, 250, 'highpass', fs=RATE, output='sos')


def load(name: str) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(RAW / f'{name}.mp3'), '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def loudness(x: np.ndarray) -> float:
    """Max short-window loudness (100 ms windows, 10 ms apart), LUFS-scaled."""
    k = signal.lfilter(*K_HIGHPASS, signal.lfilter(*K_SHELF, x))
    win, hop = RATE // 10, RATE // 100
    sq = np.concatenate([[0.0], np.cumsum(k * k)])
    if len(k) <= win:
        return -0.691 + 10 * np.log10(max(sq[-1] / max(1, len(k)), 1e-12))
    means = (sq[win::hop] - sq[: len(sq) - win : hop][: len(sq[win::hop])]) / win
    return -0.691 + 10 * np.log10(max(means.max(), 1e-12))


def onset_trim(x: np.ndarray, snap: bool = False) -> np.ndarray:
    """From 2 ms before the first sample within 40 dB of the peak: the sound starts when it is played. With
    `snap`, from its first sample within 6 dB of the peak instead (a crack take's main snap can come 100 ms
    after a faint crackle)."""
    first = int(np.argmax(np.abs(x) > (0.5 if snap else 0.01) * np.abs(x).max()))
    return x[max(0, first - RATE // 500) :]


def tail_trim(x: np.ndarray) -> np.ndarray:
    """Cut after the last 10 ms within 60 dB of the loudest, with a 30 ms fade."""
    hop = RATE // 100
    n = len(x) // hop
    rms = np.sqrt((x[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    last = n - 1 - int(np.argmax((rms > rms.max() * 1e-3)[::-1]))
    x = x[: min(len(x), (last + 4) * hop)].copy()
    fade = min(len(x), int(0.03 * RATE))
    x[-fade:] *= np.linspace(1, 0, fade)
    return x


def level(x: np.ndarray) -> np.ndarray:
    return x * 10 ** ((TARGET - loudness(x)) / 20)


def limiter_gain(x: np.ndarray) -> np.ndarray:
    """Per-sample gain holding |x| to CEILING: 3 ms lookahead (a forward min, then a trailing mean, so every
    window that reaches a peak is already down to it), 80 ms release."""
    look = int(0.003 * RATE)
    need = np.minimum(1.0, CEILING / np.maximum(np.abs(x), 1e-12))
    ahead = ndimage.minimum_filter1d(need, size=look, origin=-(look // 2))
    smooth = np.convolve(ahead, np.ones(look) / look)[: len(x)]
    smooth[: look] = ahead[: look]
    g = smooth.copy()
    k = 1 - np.exp(-1 / (0.08 * RATE))
    for i in range(1, len(g)):
        if g[i] > g[i - 1]:
            g[i] = g[i - 1] + (smooth[i] - g[i - 1]) * k
    return g


def master(x: np.ndarray) -> tuple[np.ndarray, float]:
    """Level to TARGET and limit to CEILING, backing off where that would take more than MAX_REDUCTION_DB.
    Returns the take and the most the limiter took off (dB)."""
    x = level(x)
    reduction = -20 * np.log10(limiter_gain(x).min())
    if reduction > MAX_REDUCTION_DB:
        x = x * 10 ** ((MAX_REDUCTION_DB - reduction) / 20)
    g = limiter_gain(x)
    return x * g, -20 * np.log10(g.min())


def bands(x: np.ndarray) -> str:
    s = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / RATE)
    share = [s[(f >= a) & (f < b)].sum() / s.sum() for a, b in [(0, 200), (200, 600), (600, 2000), (2000, 24000)]]
    return ' '.join(f'{v * 100:3.0f}%' for v in share)


def build_loop(layers: list) -> tuple[np.ndarray, float]:
    x = sum(level(load(layer['raw'])) * layer.get('gain', 1.0) for layer in layers)
    # Filtered as three copies end to end, keeping the middle one: the filter has no start-up at the seam.
    n = len(x)
    return master(signal.sosfilt(SUBSONIC, np.tile(x, 3))[n : 2 * n])


def build(layers: list) -> tuple[np.ndarray, float]:
    parts = []
    for layer in layers:
        x = level(onset_trim(load(layer['raw']), layer.get('start') == 'snap')) * layer.get('gain', 1.0)
        parts.append(np.concatenate([np.zeros(int(layer.get('delay', 0.0) * RATE)), x]))
    mix = np.zeros(max(len(p) for p in parts))
    for p in parts:
        mix[: len(p)] += p
    mix = tail_trim(signal.sosfilt(SUBSONIC, mix))
    mix[: RATE // 1000] *= np.linspace(0, 1, RATE // 1000)
    return master(mix)


def main() -> None:
    recipe = json.loads((ROOT / 'assets' / 'sfx' / 'takes.json').read_text(encoding='utf-8'))
    OUT.mkdir(parents=True, exist_ok=True)
    for old in [*OUT.glob('*.mp3'), *OUT.glob('*.wav')]:
        old.unlink()
    print('take          length  peak  limited  loudness    laptop     <200 200-600 600-2k >2k')
    for sound, takes in recipe['sounds'].items():
        for i, layers in enumerate(takes, 1):
            x, limited = build(layers)
            dest = OUT / f'{sound}-{i}.mp3'
            subprocess.run(
                ['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', '-', '-c:a', 'libmp3lame', '-b:a', '160k', str(dest)],
                input=x.astype(np.float32).tobytes(),
                check=True,
            )
            report(dest, x, limited)
    for name, layers in recipe.get('loops', {}).items():
        x, limited = build_loop(layers)
        dest = OUT / f'{name}.wav'
        subprocess.run(
            ['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(RATE), '-ac', '1', '-i', '-', '-ar', '24000', '-c:a', 'pcm_s16le', str(dest)],
            input=x.astype(np.float32).tobytes(),
            check=True,
        )
        report(dest, x, limited)


def report(dest: Path, x: np.ndarray, limited: float) -> None:
    laptop = loudness(signal.sosfilt(SMALL_SPEAKER, x))
    print(f'{dest.stem:12s} {len(x) / RATE:5.2f} s {20 * np.log10(np.abs(x).max()):5.1f} {limited:4.1f} dB {loudness(x):6.1f} LUFS {laptop:6.1f} LUFS  {bands(x)}')


if __name__ == '__main__':
    main()
