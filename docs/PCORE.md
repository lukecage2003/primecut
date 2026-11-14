# P-CORE — voice-reactive digital presence

> **P-CORE V2** (layered entity, narrative director, presence engine): see `docs/PCORE_V2.md`. This document
> describes V1.1, which still renders every clip created before V2.

P-CORE is the creator's visual presence in faceless videos: the official Primestone logo as a live
3D entity that reacts to the real narration. It is procedural (no pre-rendered loop, no AI image
generation), deterministic (same parameters → same frames) and runs offline.

## Architecture (as implemented)

| Layer | File | Role |
|---|---|---|
| Brand asset | `assets/pcore/logo-gold.webp`, `logo-shape.json` | Official artwork (with alpha) and its silhouette traced by `scripts/pcore/vectorize-logo.mjs` (64-point polygon, slit included). |
| Audio Engine | `src/pcore/audio.ts` | Per video frame: RMS, level normalised to the narration's own range, smoothed envelope (attack/release), low/mid/high bands (biquads), transients, hysteresis silence gate with minimum duration, speech-rate proxy. Loudness ≠ emotion: signals stay separate. |
| Expression Engine | `src/pcore/expression.ts` | 9 states (IDLE, LISTENING, SPEAKING, EMPHASIS, INTENSE, SILENCE, TRANSITION, FOCUS, REVEAL) → smoothed render parameters (configurable transition time). Semantic cues from the aligned script (questions → FOCUS, reveals → REVEAL with a full turn, section changes → decomposition/reconstruction, exclamations → EMPHASIS); timeline markers named `P-CORE: REVEAL [2s]` etc. override. Works with audio only (semantic toggle). |
| Placement Engine | `src/pcore/placement.ts` | Optional **fixed position** chosen by the creator (centre, size) overrides adaptive placement in every production. Otherwise, from the timeline: no illustration → hero (centred, large, above the subtitle band); informative cards → beside; landscape pictures → least-covered corner (lower thirds and subtitles avoided); portrait pages → the free pillarbox side; reveals → temporarily larger. All values editable. |
| Scene | `src/pcore/scene.ts` | Three.js (MIT): extruded logo (official artwork on the face, gold metal sides, environment reflections), 20 fragments that rebuild the exact logo, holographic ring arcs, orbiting particles, sparkle trail, radial energy lines, halo. Pure function of (parameters, time). |
| Render host | `src/main/pcoreRender.ts`, `src/pcore/renderPage.ts` | Hidden window (WebGL2 on the GPU) → straight-alpha RGBA (additive light converted to coverage) → FFmpeg. Output read back and validated (pixel format, size, frame count, decoded alpha range). Watchdog and clean failure if WebGL is unavailable. |
| Formats | `src/engine/pcore.ts` | Inside Primestone: WebM VP9 alpha on the timeline, composited by the native exporter. Standalone alpha files from P-CORE Studio (optional): VP9 WebM, ProRes 4444 `.mov` (10-bit alpha), QuickTime Animation `.mov` (lossless), PNG sequence. No workflow depends on another editor. |
| Quality levels | `src/pcore/quality.ts` | Preview / Standard / High Quality / Final Render: internal render scale (0.5×, 1×, 1.5×, 2× with an alpha-correct premultiplied downscale), particle density (50–150 %), VP9 effort. Productions use the level chosen in P-CORE Studio (default High); the cache key includes it. |
| Timeline | `src/production/builder.ts`, exporter | P-CORE clips on V2 (independent of the narration on A1, which is never modified); VP9 alpha decoded with libvpx in the export; voice-reactive backgrounds drop their own hologram when P-CORE leads. A failed P-CORE render never blocks a production (reported). |
| UI | `src/renderer/components/PCoreStudio.tsx` | Viewport (checkerboard preview), audio response graph with state strip, expression sliders, marker buttons, placement, appearance, export with the validation result. |

## Tests
- Unit (`tests/unit/pcore.test.ts`): silence detection with hysteresis (pause placed within 0.15 s;
  0.2 s gaps ignored), gain-independent normalisation, determinism, idle/speaking/silence states and
  bounded per-frame changes, reveal = one full turn, transition decomposes and rebuilds exactly,
  semantic cues, markers, placement decisions and segments.
- Integration: a VP9 alpha overlay composited over V1 in a real export (pixel check of opaque and
  transparent areas).
- E2E (Electron, `script-to-video.spec.ts`): P-CORE clip produced by Script-to-Video in a faceless
  video; P-CORE Studio graph drawn from the real narration, preview rendered, ProRes 4444 export
  verified (`yuva*`, alpha 0–255).
- Visual check: contact sheets of renders (official logo recognisable, reveal turn with visible
  thickness, decomposition/reconstruction, portrait layouts).

## Performance (measured)
No GPU in the development machine: software WebGL (SwiftShader) renders ≈ 3 fps at 1080×1080 and
≈ 4 fps at 960×540. The RTX 3050 (4 GB) target has not been measured yet: use Settings → *Save
diagnostics report* and a P-CORE Studio export to measure it. GPU memory use is small (one extruded
mesh, ~1 700 points, a 1254² texture).

## V1.1 (2026-11-12) — validation on a real narration

Diagnostic (code read, not assumed): 9 states present; rendering, timeline track and export were
already native (hidden window inside Primestone + its FFmpeg; P-CORE clip on V2 composited by the
exporter). Problems found and fixed:
- **EMPHASIS over-triggered on a real voice** (40 % of the time, 165 state changes/min on the
  creator's narration *Midnight Spider-Man*): the transient signal saturated (6 % of speech frames at
  1.0). Fixed: unsaturated onset scale, emphasis/intense thresholds adapted to the narrator (top 3 % /
  top 10 %, settings remain floors), emphasis as an event (≤ 1 per 1.2 s), 0.3 s minimum dwell for
  other states. Result on that voice: speaking 65 %, emphasis 13 %, intense 7 %, silence 11 %,
  74 changes/min; on the TTS documentary narration: emphasis 14 %, speaking 72 %.
- Export labels pointed to external editors: removed; formats are described by their properties.
- No quality levels: added (above). No permanent manual placement: added (above).
- Rest pose checked on renders: logo intact (no seams/cracks), silhouette and slit faithful.

Measured render speed, **software WebGL (SwiftShader), 4 vCPU, no GPU**, 1080×1080 output, 150 frames
of the real narration, including analysis and VP9 encoding:

| Level | Time | Throughput |
|---|---|---|
| Preview | 9.0 s | 16.6 fps |
| Standard | 33.2 s | 4.5 fps |
| High Quality | 51.1 s | 2.9 fps |
| Final Render | 78.9 s | 1.9 fps |

These are **not GPU numbers**. RTX 3050 (4 GB VRAM) speed, GPU load and VRAM have not been measured:
no GPU is reachable from the development environment.

## Limits
- GPU performance unmeasured (see V1.1). Procedure for the creator: P-CORE Studio → choose a quality level next to the format → Export; the result line shows the render time and frames/s on that computer. Repeat per level, plus Settings → *Save diagnostics report*.
- Real-time playback of P-CORE is not computed live: clips are rendered (cached) and previewed as
  video. Editing placement (move/resize) is instant; changing reactions needs a re-render.
- Software rendering in tests requires `PRIMESTONE_SOFTWARE_GL=1` (never enabled in the app).
- Emotion is not inferred from the voice; states come from loudness/transients/rhythm and the script.
