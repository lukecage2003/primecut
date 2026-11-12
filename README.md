# Primestone Motion Studio

A local-first, free, professional desktop video editor — Windows first.
No account, no subscription, no cloud: your media never leaves your machine.

> **Status: v0.1.0 — Phase 1 (vertical slice) complete and tested end-to-end.**
> This is an early editor, not yet a Premiere Pro replacement. See
> [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for exactly what works and what does not.

## What works today (tested)

- Projects: create, save (atomic, checksummed, 20 rotating backups), reopen, autosave + crash
  recovery, recent projects, moved/missing media detection and relinking.
- Media: import video/audio/stills (dialog or drag & drop), metadata probe incl. VFR detection,
  thumbnails, waveforms, automatic H.264 CFR preview proxies for non-previewable or VFR media.
- Timeline: multitrack video/audio, frame-exact edits at fractional rates (23.976/29.97 DF/59.94),
  linked A/V, overwrite placement, drag-move across tracks with snapping, razor/split, trim, ripple
  trim, roll, slip, slide, delete/ripple delete, markers, track lock/hide/mute, undo/redo.
- Inspector: scale/position/rotation/opacity and audio gain, previewed live, undoable.
- Preview: synchronized multi-layer video + Web Audio playback, J/K/L, frame stepping.
- Export: H.264/HEVC MP4/MOV/MKV through FFmpeg, Quality / Deep Quality / Balanced presets,
  background task with progress and cancel, output verified (streams, size, exact frame count)
  before it is published. Optional verified hardware encoders (NVENC/QSV/AMF) in Balanced mode.
- Settings & diagnostics: theme (dark/light), performance profile, autosave interval, read-only
  hardware report (CPU, RAM, GPU, working hardware encoders, FFmpeg build).

## Quick start (development)

```bash
npm install
```

```bash
npm run build && npm start
```

FFmpeg must be available: on PATH, in `vendor/ffmpeg/`, or via `PRIMESTONE_FFMPEG_DIR`.
Full instructions: [docs/BUILD.md](docs/BUILD.md). Usage: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Tests

```bash
npm test
```

```bash
npm run build && xvfb-run -a npx playwright test --trace off
```

Latest results: [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## Documentation

| Document | Content |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Layers, time model, editing model, project format |
| [DECISIONS](docs/DECISIONS.md) | Technical decisions (ADR log) |
| [REQUIREMENTS](docs/REQUIREMENTS.md) | Requirement registry with status and evidence |
| [ROADMAP](docs/ROADMAP.md) | Phases 0–9 |
| [LICENSES](docs/LICENSES.md) | License audit of every component |
| [KNOWN_LIMITATIONS](docs/KNOWN_LIMITATIONS.md) | Honest list of current limits |
| [DEVLOG](docs/DEVLOG.md) | Development journal |
| [BUILD](docs/BUILD.md) · [USER_GUIDE](docs/USER_GUIDE.md) | Build and usage guides |

## License

MIT for Primestone's code. Third-party components keep their own licenses — see docs/LICENSES.md.
