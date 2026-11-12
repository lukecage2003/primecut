# Architecture — Primestone Motion Studio

Status: reflects the code at v0.2.0-dev (Phase 1 complete, Phase 2 in progress).

## Layers and responsibilities

```
┌──────────────────────────────── Renderer process (Chromium, sandboxed) ─────────────────────────────┐
│ src/renderer   React UI: Home/Dashboard, Media Library, Viewer, Timeline, Inspector, Export,        │
│                Tasks, Settings & Diagnostics.                                                       │
│   store.ts     session/UI state (selection, playhead, zoom, tool, caches)                            │
│   actions.ts   every user operation; edits go through core History (undoable)                        │
│   preview.ts   PreviewEngine — layered <video>/<img>/<audio> + Web Audio, same layout math as export │
│   playback.ts  transport clock                                                                       │
│                         ▲ uses (pure, no I/O)                                                        │
│ src/core       Domain model: rational time/timecode, Project/Sequence/Track/Clip, timeline           │
│                operations, History (undo/redo), validation, schema migrations                        │
└───────────────────────────────────────▲─────────────────────────────────────────────────────────────┘
                     typed IPC contract │ src/shared/api.ts (PrimestoneApi) — preload exposes it
┌───────────────────────────────────────┴──────────── Main process (Node) ────────────────────────────┐
│ src/main       window, security policy, pmedia:// streaming protocol (Range), IPC handlers, settings  │
│ src/engine     ffmpeg.ts (process layer) · probe.ts · media.ts (import, fingerprint, thumbnails,     │
│                waveform peaks, proxies) · projectStore.ts (.psproj, atomic writes, backups, autosave, │
│                recovery, relink) · exporter.ts (sequence → FFmpeg graph → verify) · tasks.ts          │
│                (TaskOrchestrator) · hardware.ts (read-only inspection, encoder verification)         │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                    │ spawns (never links)
                              FFmpeg / FFprobe executables
```

Rules enforced by structure:

- `core` imports nothing from `engine`, `main` or `renderer` and does no I/O. It runs identically in
  Node (tests, export) and in the renderer.
- The renderer never touches the filesystem or spawns processes; everything goes through
  `PrimestoneApi` (contextIsolation + sandbox + no nodeIntegration).
- `engine` has no Electron dependency, so it is fully testable with Vitest and reusable by a future
  headless/CLI renderer.

## Time model

- Timeline positions/durations: **integer frames** in the sequence timebase.
- Frame rates: **rationals** (`30000/1001`), so NTSC is exact; SMPTE drop-frame timecode for 29.97/59.94.
- Source positions: seconds (double). This decouples the timeline from source rates and VFR media.
- Export conforms every clip with `fps=<seq rate>` then cuts an exact frame count (`trim=end_frame`),
  so VFR sources render at the right frames. VFR media also get a CFR preview proxy.

## Editing model

`History.commit(label, recipe)` runs a recipe on an immer draft of the whole project. If the recipe
throws (`EditError`), nothing changes. Snapshots share structure, so undo memory is proportional to
what changed. Drag interactions compute *previews* with the same operation (`produce` without commit)
and commit once on release — what you see while dragging is exactly what gets committed.

Operations (`core/timeline.ts`): place (overwrite/insert), clearRange (overwrite semantics), split /
razor, move (with track change, linked A/V), delete / ripple delete, trim (normal/ripple, media and
neighbour constraints), roll, slip, slide, track lock/disable, markers, clip properties, unlink.

## Render plan (shared by preview and export)

`core/plan.ts` turns a sequence into `PlanItem`s: effective start/end (clips extended into their
handles by transitions), source in-point, opacity/volume ramps (fades, dissolves, crossfades) and
layer order. The exporter compiles plan items into FFmpeg (`fade=…:alpha=1`, `afade`), the preview
applies the same ramps to element opacity / Web Audio gain — one definition, two renderers.
After every edit `normalizeSequence` prunes transitions whose clips are no longer adjacent and
clamps durations to the available handles.

## Native project format (`.psproj`, schema v2)

Folder layout: `<Project>/<Project>.psproj`, `Autosave/`, `Backups/` (20 rotating snapshots taken
before each save), `Cache/{thumbs,peaks,proxies}` (disposable).

Envelope: `{ format, schemaVersion, appVersion, savedAt, checksum: sha256(project JSON), project }`.
Load path: parse → checksum → migrate (refuses newer schemas) → validate → resolve media (absolute
path, then path relative to the project folder; size + partial sha256 fingerprint detects replaced
files) → offer autosave recovery if newer. All writes are atomic (temp + fsync + rename).

## Preview vs. export

The preview is a real-time approximation built from browser media elements (hardware-decoded by
Chromium), laid out with the same fit/transform math as the exporter. Export is authoritative: a
single FFmpeg filter graph, written to a temp file, verified (streams, resolution, exact frame count,
duration) and only then renamed to the target name.

## Task orchestration

`TaskOrchestrator` (engine/tasks.ts) runs thumbnails, waveforms, proxies and exports — and will run
local AI jobs — with priorities, CPU-slot and GPU limits, dependencies, dedupe keys, cancellation,
logs, progress, and an optional verify step that must pass before a task is `done`.
