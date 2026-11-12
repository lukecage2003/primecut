# Known limitations (v0.1.0)

Honest list; each item has a planned phase.

## Preview
- Playback uses one browser media element per visible clip with drift correction (re-seek beyond
  ~0.1 s). It is smooth for typical edits but not guaranteed frame-exact *while playing*; paused
  frames are exact. Export is always authoritative. → Phase 3 WebCodecs compositor.
- Reverse playback (J) steps by seeking and is not smooth.
- Clips cut very close together may show a brief black/frozen frame on the cut during playback while
  the next element seeks (pre-seeking 2 s ahead mitigates it).
- Codecs Chromium cannot decode (ProRes, DNxHR, HEVC on some systems, 10-bit 4:2:2…) are previewed
  only after their proxy is generated (background task).

## Editing
- Only one transition type (cross-dissolve / audio crossfade). No keyframes, effects, titles, nesting or copy/paste yet (Phase 2/4).
- Transitions need real source handles on both sides; Primestone does not invent frozen frames.
- Ripple operations affect the edited clip's track(s) and linked tracks only, not all tracks.
- Clip speed changes are modelled (`speed`) but not exposed (always 1×).
- Sequence settings cannot be changed after creation.

## Export
- One export at a time per click; no persistent render queue, no segmented/resumable export yet.
- Very long timelines with hundreds of clips create one FFmpeg input per clip; fine for normal
  projects, will be replaced by segmented rendering in Phase 3.
- HEVC export needs an FFmpeg build with libx265 (GPL build) or a hardware HEVC encoder.

## Platform
- Developed and tested on Linux (CI + container) and configured for Windows (CI job builds and tests
  on windows-latest). The Windows job has not yet been observed passing from this environment (no
  Windows runner available here); see TEST_REPORT.md.
- No GPU was available in the development container: hardware encoders/decoders are implemented with
  verification but not exercised in tests here.
- Installer is unsigned (SmartScreen warning on Windows).

## Script-to-Video (v0.5)
- Word-level sync needs a transcription engine installed by the user (faster-whisper or
  whisper.cpp) and a Whisper model on disk; Primestone does not download either. Without it, sync
  is pause-based and was measured at ~3 s median error on a TTS narration: not production quality.
- All measurements so far use a synthetic espeak-ng voice; **the real narration ("test spidey") has
  not been processed yet** because it is on the user's PC, not in the development environment.
- whisper.cpp backend: implemented from its documented JSON output and unit-tested on that format,
  but not run end-to-end here (no ggml model reachable from the development network).
- Procedural compositions render at ≈ 2× real time on 4 CPU cores (1080p): a 90-minute video with
  no illustrations needs hours on such a machine. GPU acceleration of compositions is not done.
- Knowledge base: ~50 curated entries + names learned from each script (marked uncertain, no facts).
- No web media providers yet (rights model and UI exist; no provider implemented or tested).
- PDF import: multi-column layouts and tables inside the narration are not handled; production
  tables in annexes are kept as notes, not applied to the edit.
- Hardware encoders (NVENC on the RTX 3050) and CUDA transcription have never run on real hardware
  here: use "Save diagnostics report" in Settings to measure them on the target PC.
