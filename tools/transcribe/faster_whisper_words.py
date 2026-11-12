#!/usr/bin/env python3
"""Primestone transcription sidecar (faster-whisper backend, MIT).

Usage: faster_whisper_words.py --model <dir> --audio <file> --out <json> [--language fr] [--device auto]
       [--initial-prompt "names…"] [--threads N]

Writes {"engine", "model", "language", "duration", "words": [{"text","start","end","p"}]} and prints
progress lines "PROGRESS <0..1>" on stdout. Runs fully offline: the model directory must already exist
locally (Primestone never downloads a model without the user's explicit consent).
"""
import argparse, json, sys, os

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--language', default='fr')
    ap.add_argument('--device', default='auto')
    ap.add_argument('--compute-type', default='default')
    ap.add_argument('--initial-prompt', default=None)
    ap.add_argument('--threads', type=int, default=0)
    a = ap.parse_args()
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    import wave
    import numpy as np
    from faster_whisper import WhisperModel
    # Primestone decodes the narration itself (FFmpeg → 16 kHz mono s16 WAV): no codec dependency here
    with wave.open(a.audio, 'rb') as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit('expected 16 kHz mono 16-bit WAV')
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    model = WhisperModel(a.model, device=a.device, compute_type=a.compute_type, cpu_threads=a.threads, local_files_only=True)
    segments, info = model.transcribe(audio, language=a.language or None, word_timestamps=True, vad_filter=False,
                                      beam_size=5, initial_prompt=a.initial_prompt, condition_on_previous_text=True)
    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({'text': w.word.strip(), 'start': round(w.start, 3), 'end': round(w.end, 3), 'p': round(w.probability, 3)})
        print(f'PROGRESS {min(1.0, seg.end / max(info.duration, 0.001)):.3f}', flush=True)
    tmp = a.out + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'engine': 'faster-whisper', 'model': os.path.basename(os.path.normpath(a.model)), 'language': info.language,
                   'duration': info.duration, 'words': words}, f, ensure_ascii=False)
    os.replace(tmp, a.out)
    print('DONE', flush=True)

if __name__ == '__main__':
    sys.exit(main())
