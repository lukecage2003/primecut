# Development journal

## 2026-11-12 — Phase 0 and Phase 1

**Environment inspected (read-only):** empty git repo; Linux container, 4 vCPU Xeon @2.1 GHz,
15 GB RAM, no GPU (`nvidia-smi` absent) — the RTX 3050 Laptop 4 GB mentioned as a reference is not
present here, so GPU paths are implemented with runtime verification rather than assumed. Tools:
Node 22, Python 3.13, Rust 1.97, Go, FFmpeg 6.1.1 (with libx264/x265/nvenc/qsv/vaapi encoders
listed), Xvfb, Playwright 1.63 with Chromium.

**Stack decided** (ADR-001…008): Electron + TS + React, FFmpeg as external processes, pure core
domain package, immer-based history, JSON project bundle.

**Built:**
1. `core`: rational time + SMPTE timecode, project model, 15 timeline operations, History,
   validation, migrations — 23 unit tests.
2. `engine`: FFmpeg process layer with cancellation, probe (VFR/rotation), import + fingerprints,
   thumbnails, waveform peaks, proxies, project store (atomic/checksum/backups/autosave/recovery/
   relink), exporter (filter-graph compiler + verification), task orchestrator, hardware inspection
   — 12 integration tests on real media.
3. Electron app: secure main/preload, `pmedia://` Range streaming, typed IPC contract, settings and
   recent projects; React UI: dashboard, media library, viewer with preview engine, timeline with
   6 tools, inspector, export dialog, task panel, settings & diagnostics.
4. E2E tests of the full vertical slice and crash recovery.
5. Packaging config (NSIS), FFmpeg fetch script with checksum, CI for Linux + Windows.

**Bugs found by tests and fixed:**
- Split at playhead did nothing when the current selection was elsewhere → now splits the selection
  only if it lies under the playhead, otherwise all unlocked tracks.
- E2E timing race reading the video element while it was seeking after pause → test now waits for a
  settled decoded frame (the app behaviour was correct).
- Test expectations corrected for lavfi sine amplitude and 5 s still at 29.97 = 149 frames.

### Phase 2 started
- Schema v2 (first real migration): `Track.transitions`, `Clip.fadeIn/fadeOut`.
- `core/transitions.ts` (add/remove/duration, Ctrl+D at nearest cut, handle math, normalisation) and
  `core/plan.ts` (render plan used by both preview and export).
- Exporter and preview now consume the plan. Timeline draws transitions and fade wedges; Inspector
  edits fades and transition duration.
- Found while testing: Playwright `app.close()` hangs if the project is dirty because the app
  (correctly) asks to save — the E2E test now asserts that prompt.

**Next concrete task:** nesting (sequence as clip), titles track (text rendering shared by preview
and export), copy/paste and box selection.

### Mission update — Script-to-Video becomes the priority
- Re-evaluated architecture (docs/SCRIPT_TO_VIDEO.md, ADR-009…012) and roadmap (STV track).
- Implemented `src/production` (parsing, alignment, entities, beats, matching, builder, QC,
  preferences), engine audio analysis + pipeline, schema v3 (clip motion, captions, media rights/tags,
  production report), Ken Burns + ASS captions in export and preview, Script-to-Video panel,
  sequence versions switcher, production report with per-shot explanations, “Learn from my edits”.
- Bugs found by tests and fixed: [VISUEL:] hint applied to a whole paragraph instead of the next
  sentence; a hinted image consumed by the previous shot (now reserved for its beat); acronym at
  sentence end (S.H.I.E.L.D.) not splitting; elided aliases (l'Araignée) not matched; overlapping
  name tags; Windows CI orphaned Electron helpers (tree kill); harness crash reading a closed app's pid.
- Environment note: Hugging Face and Wikimedia hosts are blocked by this environment's network
  policy, so the recogniser and web providers could not be exercised here.
- Windows CI: the BtbN FFmpeg build has no `flite` filter, so the synthetic-narration fixture now
  falls back to speech-like voiced bursts (same known pauses). Both paths are tested locally
  (`PRIMESTONE_TEST_NO_FLITE=1`).

### Faceless & Primestone Visuals
- Comic page panel detection (XY-cut) + panel-by-panel camera; first attempt framed tall panels
  at full page width (geometry limit) → windows may now extend past the page over a dark pad.
- Procedural compositions engine (`engine/generators.ts`) + contextual decision
  (`production/visuals.ts`); first render had a purple cast (screen blend applied in YUV) and a
  noisy vectorscope "orb" → glow now blended in RGB, orb replaced by a voice-envelope-driven core.
- Builder now never leaves a shot empty; generated shots are rendered in the pipeline and cached.
