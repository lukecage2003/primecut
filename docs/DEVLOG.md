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
