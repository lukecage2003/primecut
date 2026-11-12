# Requirement registry

Status legend: **Done** = implemented, integrated, tested, documented · **Partial** = works with
documented limits · **Planned** = not implemented (no UI pretends otherwise).
Evidence refers to test files (U = tests/unit, I = tests/integration, E = tests/e2e).

## Phase 1 — vertical slice (acceptance chain)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| VS-1 | Launch the application | Done | E vertical-slice |
| VS-2 | Create a project | Done | E vertical-slice |
| VS-3 | Import a video | Done | E vertical-slice, I engine › media import |
| VS-4 | See it in the media library | Done | E vertical-slice (thumbnail check) |
| VS-5 | Add it to the timeline | Done | E vertical-slice, U timeline |
| VS-6 | Play and preview | Done | E vertical-slice (decoded frame, currentTime advances) |
| VS-7 | Move and cut | Done | E vertical-slice (split + drag with snap), U timeline |
| VS-8 | Save the project | Done | E vertical-slice, I project storage |
| VS-9 | Close the application | Done | E vertical-slice |
| VS-10 | Reopen the project | Done | E vertical-slice (recent list) |
| VS-11 | Find the edit intact | Done | E vertical-slice (exact clip positions) |
| VS-12 | Export a working video | Done | E vertical-slice (ffprobe: 1920×1080, 150 frames, pixel colours, audio levels) |

## Timeline & editing

| ID | Requirement | Status | Evidence / notes |
|---|---|---|---|
| TL-01 | Frame-accurate editing | Done | Integer-frame model; I export checks exact frame content |
| TL-02 | Fractional frame rates (23.976/29.97/59.94) | Done | U time (drop-frame TC), I export @29.97 |
| TL-03 | VFR media | Partial | Detected; CFR proxy for preview; export conforms via fps filter (I) |
| TL-04 | Multiple tracks (video/audio) | Done | Add tracks, compositing order V1→Vn (I export overlay) |
| TL-05 | Titles, graphics, subtitles tracks | Planned | Phase 2/4 |
| TL-06 | Split / razor | Done | U, E |
| TL-07 | Move (time + track), overwrite semantics | Done | U, E |
| TL-08 | Trim, ripple, roll, slip, slide | Done | U timeline (each op + clamping); UI tools B/N/Y/U |
| TL-09 | Keyframes & Bézier curves | Planned | Phase 4 |
| TL-10 | Transitions | Planned | Phase 2 |
| TL-11 | Markers | Done | U; UI (M key, double-click to delete) |
| TL-12 | Nesting | Planned | Phase 2 |
| TL-13 | Track lock / disable (hide/mute) | Done | U (locked edits refused), I export ignores disabled tracks via plan |
| TL-14 | Linked A/V sync | Done | U (linked move/split/trim), E |
| TL-15 | Undo / redo | Done | U history, E |
| TL-16 | Snapping | Done | E (drag snaps to clip end) |

## Project format, storage, recovery

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| PF-01 | Versioned native format + migrations | Done | U migrations, I refuses newer schema |
| PF-02 | Integrity (checksum) | Done | I tampered file rejected |
| PF-03 | Atomic writes (transactions) | Done | projectStore.atomicWrite |
| PF-04 | Autosave + crash recovery | Done | I autosave, E crash recovery (SIGKILL) |
| PF-05 | Snapshots / backups | Done | I backups rotation |
| PF-06 | Media relocation & path validation | Done | I relative-path relocation, folder search; UI “Locate…” |
| PF-07 | Stores media, sequences, tracks, clips, transforms, markers, export settings, metadata | Done | model.ts; E round-trip |
| PF-08 | Effects, compositions, subtitles in format | Planned | added with their features |

## Engine, export, performance

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| EN-01 | Decode / probe | Done | I probe (video, audio, still, VFR, invalid file) |
| EN-02 | Preview playback | Partial | Browser-element engine; see KNOWN_LIMITATIONS |
| EN-03 | Transform / compositing | Partial | Scale/position/rotation/opacity in preview and export; no effects yet |
| EN-04 | Encoding / export with verification | Done | I export, E |
| EN-05 | Hardware acceleration + CPU fallback | Partial | Encoders verified by test-encode; used in Balanced. HW decode in preview via Chromium |
| EN-06 | Segmented / resumable export | Planned | Phase 3 |
| EN-07 | Proxies | Done | I proxy generation (VFR → CFR); auto for non-previewable media |
| EN-08 | Cache (thumbs, peaks, proxies) | Done | I cache |
| EN-09 | Task orchestrator (priority, deps, dedupe, cancel, verify) | Done | I task orchestrator |
| EN-10 | Hardware inspection (read-only) + profiles | Done | I hardware; Settings UI |
| EN-11 | Quality default, no silent quality reduction | Done | ADR-007; encoder logged per export |

## Modules (product map)

| # | Module | Status |
|---|---|---|
| 1 | Dashboard | Done (create/open/recent) |
| 2 | Project Manager | Done (Phase 1 scope) |
| 3 | Media Library | Done (Phase 1 scope; bins/metadata search planned) |
| 4 | Timeline Editor | Partial (see TL-*) |
| 5 | Editing Studio (viewer/inspector) | Partial |
| 13 | Export Center | Partial (single export + queue via tasks; presets) |
| 18 | Task Orchestrator | Done (engine); UI task panel |
| 21 | Hardware & Performance | Partial (inspection + profiles) |
| 22 | Cache & Proxy Manager | Partial (automatic; no management UI) |
| 23 | Backup & Recovery | Done (backups, autosave, recovery prompt) |
| 24 | Diagnostics | Partial (hardware/FFmpeg report) |
| 25 | Settings | Partial (theme, profile, autosave, projects folder) |
| 6–12, 14–17, 19–20, 26–27 | Automatic Editing, Storyboard, Script Intelligence, Motion Design, VFX, Audio Studio, Voice Studio, Quality Control, Local AI, Comics Intelligence, Model Manager, Preference Learning, API Manager, Plugins, Learning Center | Planned — no UI exists for them yet, by design |
