#!/usr/bin/env python3
"""Builds a reproducible French test narration with ground-truth sentence timings.

usage: make-narration.py <script.md> <out.wav> <out.truth.json> [--voice fr] [--speed 165] [--gap 0.35] [--max-sentences N]
Each sentence of the Primestone script is synthesised separately with espeak-ng (test tool only, not
shipped), then concatenated with a pause; the exact start/end of every sentence is recorded.
The sentence split is done by Primestone itself (reads a JSON list of sentences on stdin if '-' given).
"""
import json, subprocess, sys, wave, tempfile, os, argparse
ap = argparse.ArgumentParser()
ap.add_argument('sentences_json'); ap.add_argument('out_wav'); ap.add_argument('out_truth')
ap.add_argument('--voice', default='fr'); ap.add_argument('--speed', type=int, default=165); ap.add_argument('--gap', type=float, default=0.35)
ap.add_argument('--para-gap', type=float, default=0.8)
a = ap.parse_args()
sents = json.load(open(a.sentences_json, encoding='utf-8'))
rate = 22050
frames = bytearray(); truth = []; t = 0.0
with tempfile.TemporaryDirectory() as d:
    for i, s in enumerate(sents):
        f = os.path.join(d, f'{i}.wav')
        subprocess.run(['espeak-ng', '-v', a.voice, '-s', str(a.speed), '-w', f, s['text']], check=True)
        with wave.open(f, 'rb') as w:
            assert w.getframerate() == rate and w.getnchannels() == 1
            data = w.readframes(w.getnframes())
        # trim espeak's leading/trailing silence so truth = audible speech
        import array
        x = array.array('h', data)
        thr = 300
        st = next((k for k, v in enumerate(x) if abs(v) > thr), 0)
        en = len(x) - next((k for k, v in enumerate(reversed(x)) if abs(v) > thr), 0)
        x = x[st:en]
        truth.append({'index': s['index'], 'start': round(t, 3), 'end': round(t + len(x) / rate, 3)})
        frames += x.tobytes(); t += len(x) / rate
        gap = a.para_gap if s.get('paragraphEnd') else a.gap
        frames += b'\x00\x00' * int(gap * rate); t += gap
with wave.open(a.out_wav, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(frames))
json.dump(truth, open(a.out_truth, 'w'))
print(f'{len(truth)} sentences, {t:.1f}s')
