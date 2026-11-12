# Test report

Run date: 2026-11-12 · Commit: see `git log` · Environment: Linux container (4 vCPU Xeon, 15 GB RAM,
no GPU), Node 22, Electron 45.3.1, FFmpeg 6.1.1 (system), Xvfb.

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ 0 errors |
| Unit (core + production) | `npx vitest run tests/unit` | ✅ 59 / 59 |
| Integration (engine + real FFmpeg) | `npx vitest run tests/integration` | ✅ 22 / 22 |
| End-to-end (Electron UI, Xvfb) | `npx playwright test` | ✅ 5 / 5 |
| Packaged build smoke (linux-unpacked) | `electron-builder --linux dir` + launch | ✅ starts, dashboard renders |
| GitHub CI (windows-latest + ubuntu) | `.github/workflows/ci.yml` | ✅ runs 3, 7–10 green on both OS (unit, integration, E2E, NSIS installer); runs for the v0.5 commits: see Actions |

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

## Production campaign (v0.5, reproducible: `scripts/eval/campaign.ts`)

Real Primestone scripts (PDF) → French narration synthesised per sentence with espeak-ng (exact
ground-truth timings) → local transcription (faster-whisper, Whisper *small* int8, CPU) → full
Script-to-Video pipeline → export → measurements on the exported file. Machine: 4 vCPU, no GPU.
Media libraries are synthetic images named after the entities/references of each script (they
test matching logic, not image quality). espeak is a robotic voice: **these runs do not replace a
test with the real narration.**

| Scenario | Video | ASR | Generation | Export (×RT) | Sync median / p90 / ≤250 ms | Shots (strong/weak/generated) | QC | Loudness / true peak | Black frames |
|---|---|---|---|---|---|---|---|---|---|
| Short vertical 1080×1920 (Despair, 2 min 26) | 146 s | 58 s | 3 s* | 262 s (1.78×) | 1 ms / 164 ms / 93 % | 20 / 7 / 0 | 100 | −16.0 LUFS / −1.4 dBFS | none |
| Comics analysis 1080p (Télépathie, many refs) | 601 s | 209 s | 184 s | 764 s (1.27×) | 58 ms / 448 ms / 83 % | 74 / 13 / 13 | 100 | −16.1 / −1.4 | none |
| No illustrations 1080p (Apocalypse) | 526 s | 188 s | 1089 s | 555 s (1.05×) | 44 ms / 381 ms / 85 % | 0 / 0 / 95 | 100 | −16.1 / −1.4 | none |
| Documentary 720p (5 scripts, ~90 min) | see DEVLOG | | | | | | | | |

\* procedural compositions cached from a previous run. Peak memory ≤ 242 MB in all runs.
Without transcription (pauses only) the sentence error was ~3 s median on the same narration:
word-level transcription is the recommended mode.

Findings fixed during the campaign: true peak above 0 dBFS (master limiter added), portrait
character cards cut off (portrait layouts), sub-0.7 s subtitles (merging), names unknown to the
knowledge base ignored (script entities), single-command export unsuitable for long timelines on
Windows (segmented export). Open: procedural rendering ≈ 2× real time on 4 cores (dominant cost
of illustration-poor videos).
