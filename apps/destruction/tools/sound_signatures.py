"""Acoustic signatures of the destruction sound takes (public/sfx/<sound>-<n>.mp3), checked against what each is
meant to be. It would have turned down the first ElevenLabs thuds, which had almost nothing below 200 Hz.

    python -I tools/sound_signatures.py public/sfx        # needs ffmpeg, numpy, scipy
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import signal

RATE = 48000


def load(path: Path) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', str(RATE), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def describe(x: np.ndarray) -> dict:
    rate = RATE
    # Rectified envelopes (a Hilbert envelope spikes at the buffer's ends): 2 ms for the attack, 10 ms for the rest.
    # Attack: from 10% of the peak to the first time it reaches half of it. (Time to the very loudest moment
    # misreads real takes: a boom's sub swell peaks ~100 ms after its crack.)
    quick = np.convolve(np.abs(x), np.ones(int(rate * 0.002)) / int(rate * 0.002), mode='same')
    start = int(np.argmax(quick > 0.1 * quick.max()))
    attack_ms = (int(np.argmax(quick > 0.5 * quick.max())) - start) / rate * 1000
    env = np.convolve(np.abs(x), np.ones(int(rate * 0.01)) / int(rate * 0.01), mode='same')
    peak_i = int(np.argmax(env))
    tail = np.nonzero(env > env.max() * 10 ** (-30 / 20))[0]
    decay_s = (tail[-1] - peak_i) / rate if len(tail) else 0
    sustain_s = float((env > env.max() * 0.1).sum() / rate)  # time within 20 dB of the loudest
    f, _, S = signal.spectrogram(x, rate, nperseg=1024, noverlap=768)
    power = S.sum(axis=1)
    centroid = float((f * power).sum() / power.sum())
    low_share = float(power[f < 200].sum() / power.sum())
    mid_share = float(power[(f >= 600) & (f < 6000)].sum() / power.sum())
    high_share = float(power[f >= 600].sum() / power.sum())
    # Centroid early vs late: does it darken as it decays?
    frame_c = (f[:, None] * S).sum(0) / np.maximum(S.sum(0), 1e-12)
    frame_p = S.sum(0)
    audible = np.nonzero(frame_p > frame_p.max() * 1e-4)[0]  # within 40 dB of the loudest moment
    third = max(1, len(audible) // 3)
    w = frame_p[audible]
    early_c = float((frame_c[audible[:third]] * w[:third]).sum() / w[:third].sum())
    late_c = float((frame_c[audible[-third:]] * w[-third:]).sum() / w[-third:].sum())
    # Onsets: rises in a fast envelope.
    fast = np.convolve(np.abs(x), np.ones(int(rate * 0.004)) / int(rate * 0.004), mode='same')
    onsets = len(np.nonzero((fast[1:] > 0.25 * fast.max()) & (fast[:-1] <= 0.25 * fast.max()))[0])
    return dict(attack_ms=attack_ms, decay_s=decay_s, sustain_s=sustain_s, centroid=centroid, low_share=low_share, mid_share=mid_share,
                high_share=high_share, early_c=early_c, late_c=late_c, onsets=onsets, seconds=len(x) / rate)


CHECKS = {
    'boom': lambda d: [('fast attack (<15 ms)', d['attack_ms'] < 15), ('long decay (>0.8 s)', d['decay_s'] > 0.8),
                       ('body: a third of its energy below 200 Hz', d['low_share'] > 0.33), ('reads on a laptop: a tenth above 600 Hz', d['high_share'] > 0.1),
                       ('darkens as it decays', d['late_c'] < d['early_c'])],
    'clang': lambda d: [('fast attack (<15 ms)', d['attack_ms'] < 15), ('rings (>0.3 s decay)', d['decay_s'] > 0.3),
                        ('hollow and heavy: a fifth below 200 Hz', d['low_share'] > 0.2), ('metal: a fifth in 600 Hz-6 kHz', d['mid_share'] > 0.2)],
    'collapse': lambda d: [('sustained (>1.5 s within 20 dB of its peak)', d['sustain_s'] > 1.5),
                           ('broadband: a fifth below 200 Hz and a fifth above 600 Hz', d['low_share'] > 0.2 and d['high_share'] > 0.2)],
    'crack': lambda d: [('sharp attack (<5 ms)', d['attack_ms'] < 5), ('short (<0.5 s decay)', d['decay_s'] < 0.5), ('bright (centroid >1.5 kHz)', d['centroid'] > 1500)],
    'crumble': lambda d: [('several impacts (>=4 onsets)', d['onsets'] >= 4), ('gritty, not hiss (centroid 600-6000 Hz)', 600 < d['centroid'] < 6000)],
    'creak': lambda d: [('drawn out (>1 s within 20 dB of its peak)', d['sustain_s'] > 1), ('a low groan (a sixth below 200 Hz)', d['low_share'] > 0.15),
                        ('metal you can hear on a laptop (a quarter in 600 Hz-6 kHz)', d['mid_share'] > 0.25)],
    'thud': lambda d: [('fast attack (<15 ms)', d['attack_ms'] < 15), ('short (<1 s decay)', d['decay_s'] < 1),
                       ('heavy: half its energy below 200 Hz', d['low_share'] > 0.5), ('a knock a laptop plays (>4% above 600 Hz)', d['high_share'] > 0.04)],
}

failed = 0
for path in sorted(Path(sys.argv[1]).glob('*.mp3')):
    sound = path.stem.rsplit('-', 1)[0]
    d = describe(load(path))
    print(f"{path.stem}: attack {d['attack_ms']:.1f} ms, decay {d['decay_s']:.2f} s, sustain {d['sustain_s']:.2f} s, centroid {d['centroid']:.0f} Hz "
          f"({d['early_c']:.0f} -> {d['late_c']:.0f}), <200 Hz {d['low_share'] * 100:.0f}%, >600 Hz {d['high_share'] * 100:.0f}%, onsets {d['onsets']}")
    for label, ok in CHECKS[sound](d):
        if not ok:
            print(f'   FAIL {label}')
            failed += 1
print('all signatures match' if not failed else f'{failed} mismatches')
