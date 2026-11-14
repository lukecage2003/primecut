# License audit

Primestone Motion Studio source code: **MIT** (see LICENSE).

## Runtime dependencies shipped in the app

| Component | Version | License | Use | Redistribution notes |
|---|---|---|---|---|
| Electron (incl. Chromium, Node.js) | 45.x | MIT (+ Chromium BSD-style & third-party notices) | Desktop shell | Ship `LICENSE` and `LICENSES.chromium.html` (electron-builder does this). Chromium's bundled FFmpeg decodes H.264/AAC for preview; codec patent licensing is the distributor's responsibility in some jurisdictions. |
| React, React DOM | 19.x | MIT | UI | Include notice. |
| immer | 11.x | MIT | Structural sharing for History | Include notice. |
| FFmpeg / FFprobe (executables) | bundled **LGPL** build (since 14/11/2026, user's rule: no GPL) | LGPL-2.1+ or GPL-2+/3 depending on build | Decode, filter, encode | Spawned as separate processes, never linked. If a **GPL** build (with libx264/libx265) is bundled, ship the FFmpeg license, a written offer/link to the exact source, and the build configuration. An **LGPL** build excludes x264/x265: Primestone then relies on hardware encoders (NVENC/QSV/AMF) or users point `PRIMESTONE_FFMPEG_DIR` at their own build. H.264/HEVC/AAC are patent-encumbered formats; no royalty-bearing component is bundled by Primestone itself. |

Since 14/11/2026 the installer ships the **LGPL** FFmpeg build (no x264/x265): exports use the graphics card's
H.264/HEVC encoder after a real test encode, otherwise AV1 (SVT-AV1, BSD + AOM patent licence) or VP9 (libvpx, BSD)
on the processor; the app's own intermediate files use H.264 on the graphics card or VP9. A user who points
`PRIMESTONE_FFMPEG_DIR` at a build with x264 gets it back automatically.

## Development-only dependencies (not shipped)

TypeScript (Apache-2.0), Vite (MIT), @vitejs/plugin-react (MIT), esbuild (MIT), Vitest (MIT),
Playwright (Apache-2.0), @types/* (MIT), electron-builder (MIT, planned for packaging).

## Added in v0.5

| Component | License | Use |
|---|---|---|
| pdfjs-dist 4.10 | Apache-2.0 | PDF script import (runs in the main process, no network). |
| an-array-of-french-words / an-array-of-english-words 2.0 | MIT | Word lists used only to repair words glued by PDF justification. |
| faster-whisper (optional, user-installed) | MIT | Transcription sidecar, `tools/transcribe/faster_whisper_words.py`. Not bundled. |
| whisper.cpp v1.9.5 | MIT | **Bundled** built-in transcription engine (`resources/whisper`, licence text and SOURCE.json shipped). See docs/THIRD_PARTY.md. |
| Whisper ggml model weights | MIT | Downloaded **only on explicit request** in Settings (size, source, licence shown; SHA-1 checked). |
| three (Three.js) 0.170 | MIT | P-CORE 3D renderer (bundled in the hidden render page). |
| deep-filter-rt 0.2 (DeepFilterNet3 model embedded) | MIT OR Apache-2.0 | **Bundled** neural speech denoiser `resources/denoise/primestone-denoise` (our wrapper in `tools/denoise`, built in CI from crates.io). Ship both licence texts and its NOTICE.md. |
| @napi-rs/canvas 0.1 | MIT | Draws comic PDF pages for pdf.js (native module, unpacked from the asar). |
| Tesseract OCR (optional, user-installed) | Apache-2.0 | Reads speech balloons; used only when found on the computer. Not bundled. |
| espeak-ng | GPL-3.0 | **Test tooling only** (campaign narrations); not shipped, not linked. |

## Evaluated for upcoming phases (not integrated yet)

| Candidate | License | Notes |
|---|---|---|
| OpenTimelineIO | Apache-2.0 | Interchange (EDL/FCPXML/OTIO) — planned Phase 2/3 via Python sidecar or TS port of the schema. |
| MLT | LGPL-2.1 | Alternative render backend — not needed so far (ADR-002). |
| PySceneDetect | BSD-3 | Scene detection for Automatic Editing (Phase 5). Python sidecar. |
| OpenCV | Apache-2.0 | Subject tracking / reframing (Phase 8). |
| ONNX Runtime | MIT | Local inference runtime (Phase 6). |
| faster-whisper (CTranslate2) | MIT | Transcription. **Model weights**: Whisper weights are MIT; downloaded only on explicit user request. |
| WhisperX | BSD-2 | Word alignment; depends on pyannote (some models gated / non-commercial) — must be reviewed before use. |
| Piper (TTS) | MIT (engine) | **Voices have individual licenses** (many CC-BY / some non-commercial) — each voice must be checked and shown to the user. Note: upstream moved to OHF-Voice/piper1-gpl (GPL-3.0) — use as a separate process only. |
| Blender | GPL-2+ | Not embedded. |
| Natron | GPL-2 | Not embedded; reference only. |
| Tauri | MIT/Apache-2.0 | Considered for the shell (ADR-001). |

No component with a non-commercial or "no redistribution" clause is part of the app.
