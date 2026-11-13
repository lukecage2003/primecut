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
  Comic references are read from sources, narration and file names (series/volume/issues/year);
  pictures without a number or year in their name cannot be checked against a cited issue.
- No web media providers yet (rights model and UI exist; no provider implemented or tested).
- PDF import: multi-column layouts and tables inside the narration are not handled; production
  tables in annexes are kept as notes, not applied to the edit.
- Hardware encoders (NVENC on the RTX 3050) and CUDA transcription have never run on real hardware
  here: use "Save diagnostics report" in Settings to measure them on the target PC.

## Voice cleanup (v0.6)
- Tuned and verified on synthetic voices only (espeak, generated harmonics + noise); thresholds may
  need adjusting on a real microphone recording. Denoising is FFmpeg's afftdn (spectral): good on
  steady noise (fans, hiss, hum), weak on non-stationary noise (traffic, keyboard, reverb). No
  de-reverberation, no AI denoiser (it would require downloading a model).
- The cleaned copy is regenerated per production settings (cached by content + chain); it is stored
  in the project's `Cache/voice` folder (≈ 8.6 MB per minute, 24-bit WAV).

## P-CORE (v0.6)
- Rendered offline (cached video clips), not live in the viewer; reaction changes need a re-render.
- Measured only with software WebGL (no GPU here): ≈ 3 fps at 1080². GPU speed on the RTX 3050 unknown.
- The narration "test spidey" has not been processed: it is on the creator's PC.
- Emotion is not inferred from the voice (loudness, transients, rhythm and script cues only).

## v0.7
- Script-less mode needs the local transcription (Python + faster-whisper + a Whisper model, installed
  by the user). Section titles are names taken from the speech; a section boundary is only found at a
  long pause or a spoken cue.
- Narration type detection is rule-based; confidence is often 30–45 % on mixed videos (shown in the
  report; the type can be forced).
- Comics format detection relies on gutters between panels: borderless or overlapping panels are
  not found; a coloured manga is read left to right unless its file name says manga/chapitre.
