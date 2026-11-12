# Test report

Run date: 2026-11-12 · Commit: see `git log` · Environment: Linux container (4 vCPU Xeon, 15 GB RAM,
no GPU), Node 22, Electron 45.3.1, FFmpeg 6.1.1 (system), Xvfb.

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 errors |
| Unit (core) | `npx vitest run tests/unit` | ✅ 23 / 23 |
| Integration (engine + real FFmpeg) | `npx vitest run tests/integration` | ✅ 12 / 12 |
| End-to-end (Electron UI, Xvfb) | `npx playwright test` | ✅ 2 / 2 |
| Packaged build smoke (linux-unpacked) | `electron-builder --linux dir` + launch | ✅ starts, dashboard renders |
| Windows CI job | `.github/workflows/ci.yml` | ⏳ not yet observed (no Windows runner in this environment) |

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

## Not covered yet
GPU encoders/decoders (no GPU here), Windows-specific paths (covered by CI job once run), long
timelines/load tests, preview frame accuracy during playback (see KNOWN_LIMITATIONS).
