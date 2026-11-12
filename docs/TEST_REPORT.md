# Test report

Run date: 2026-11-12 · Commit: see `git log` · Environment: Linux container (4 vCPU Xeon, 15 GB RAM,
no GPU), Node 22, Electron 45.3.1, FFmpeg 6.1.1 (system), Xvfb.

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 errors |
| Unit (core + production) | `npx vitest run tests/unit` | ✅ 50 / 50 |
| Integration (engine + real FFmpeg) | `npx vitest run tests/integration` | ✅ 20 / 20 |
| End-to-end (Electron UI, Xvfb) | `npx playwright test` | ✅ 5 / 5 |
| Packaged build smoke (linux-unpacked) | `electron-builder --linux dir` + launch | ✅ starts, dashboard renders |
| GitHub CI (windows-latest + ubuntu) | `.github/workflows/ci.yml` | ✅ runs 3, 7, 8 green on both OS (unit, integration, E2E, NSIS installer); latest run pending at time of writing |

## What the tests prove

**Unit (tests/unit):** rational time and SMPTE drop-frame timecode round-trips (29.97/59.94);
placement with exact durations; overwrite trimming/splitting; insert ripple; razor with linked
halves staying paired; move across tracks; refusal on locked tracks / before zero with history
unchanged; trim constrained by media length and neighbours; ripple trim; roll; slip; slide;
ripple delete; undo/redo identity; markers; tracks; stills and audio-only placement; migrations.

**Integration (tests/integration, real FFmpeg on generated media):** probing of video/audio/still/
VFR and rejection of non-media; thumbnails, waveform peaks, VFR→CFR proxies; save/reopen identity,
backups rotation, checksum tamper and corrupt-file detection; autosave recovery newer-only;
refusal of newer schema; media relocation via relative paths and folder search; **export of a
cut + moved timeline checked frame by frame (pixel colours at given times) and by audio RMS in each
region**; 29.97 export with trims and stills (exact frame count); empty-sequence refusal; cancel
removes partial files; orchestrator priority / dependencies / dedupe / verify failure / cancel
propagation; hardware report.

**End-to-end (tests/e2e):** the full 12-step vertical slice through the real UI including drag with
snapping, undo/redo, save, quitting, relaunch, reopening from the recent list, exact restoration,
export through the dialog and verification of the produced file (1920×1080, 150 frames, colours,
silent gap, audio present). Crash recovery: SIGKILL after autosave, relaunch, Recover prompt,
restored edit, save clears autosave.

**Phase 2 additions:** transitions (centring, handle clamping, refusal without handles, Ctrl+D on
video+audio, pruning when clips separate, following splits, duration clamp), fades (linked, clamped),
render plan (extensions, ramps, layer order, disabled tracks/clips), schema v1→v2 migration; export
of a dissolve verified as a ~50% red/blue mix at the cut, fade from black, audio crossfade; UI test
of Ctrl+D, transition selection/delete/undo, fade slider, and the unsaved-changes prompt on close.

**Script-to-Video:** FR sentence splitting with abbreviations/acronyms and directives; entity
recognition with FR aliases and elisions; pause alignment exact on constructed cases and robust to
intra-sentence pauses; transcript alignment robust to recognition errors; timeline construction
(continuous coverage, relevant images for named characters/hints/issues, narration loudness gain,
motion, dissolves, titles, name tags, subtitle line limits); placeholders + QC errors without media;
rights policy; QC auto-fix; preference adaptation. Integration on **real audio** (flite TTS with
known boundaries): pause detection and ±0.3 s sentence alignment; full pipeline from a media folder
with sidecar tags → QC ≥ 80, no errors, correct image per sentence, verified export with audible
narration, Ken Burns motion (frame difference) and burned subtitles (pixel diff vs. caption-less
export). E2E: the whole flow through the UI including preview captions and export.

**Visuals & panels:** panel detection on synthetic rasters; window/path maths; real page export
checked panel by panel; all 7 composition kinds render with exact frame count and visible content;
voice envelope follows speech/pauses; HUD core measurably brighter while speaking; a production
with zero images exports a video with no black frames; Inspector re-render through the UI.

## Not covered yet
GPU encoders/decoders (no GPU here), Windows-specific paths (covered by CI job once run), long
timelines/load tests, preview frame accuracy during playback (see KNOWN_LIMITATIONS).
