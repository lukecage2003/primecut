# Technical decisions (ADR log)

## ADR-001 — Desktop shell: Electron + TypeScript + React (2026-11-12)
**Options considered:** Tauri (Rust + system WebView), Electron, Qt/PySide6, native C++/Qt.
**Decision:** Electron 45 for the shell, TypeScript everywhere, React 19 for UI.
**Why:**
- Windows is the priority; Electron ships its own Chromium, so behaviour is identical on every
  Windows machine (no WebView2 version drift) and in Linux CI.
- Chromium gives hardware video decode in `<video>`, WebCodecs and WebGPU for the next preview
  engine generation, and Web Audio for the mixer — without native bindings.
- One language across core, engine and UI; the pure `core` package runs in the UI and in Node.
- Playwright drives Electron for real end-to-end tests (used from day one).
**Costs accepted:** larger install and RAM footprint than Tauri. Mitigation: heavy work stays in
FFmpeg processes; the timeline model is immutable/structurally shared.
**Revisit when:** the preview needs a native GPU compositor — likely a Rust/C++ sidecar exposed
through the same `PrimestoneApi` contract, without rewriting the UI.

## ADR-002 — Media engine: FFmpeg as external executables
FFmpeg/FFprobe are spawned, never linked. This keeps the app MIT-licensable while allowing an
LGPL or GPL FFmpeg build to be shipped alongside (see LICENSES.md), lets users swap builds
(`PRIMESTONE_FFMPEG_DIR`), and isolates crashes from the UI. Rendering uses one `filter_complex` per
export; segmented/resumable rendering (Phase 3) will split by ranges using the same plan builder.
MLT was considered (mature, LGPL) but would add a second graph model to keep in sync with ours and
its Windows packaging is heavier; we may still use it as an alternative backend later.

## ADR-003 — Time representation
Integer frames on the timeline, rational frame rates, seconds for source positions. See
ARCHITECTURE.md. Avoids float drift on long timelines and keeps NTSC exact.

## ADR-004 — Immutable project + immer History
Undo/redo via snapshots with structural sharing instead of hand-written inverse commands: every
operation is automatically undoable and cannot desynchronise with its inverse.

## ADR-005 — Project format: JSON envelope with checksum, folder bundle
Human-diffable, versioned with explicit migrations, integrity-checked, atomic writes, backups and
autosave in the project folder so a project moves as one unit. SQLite was considered for very large
projects; JSON is fine for the expected size (a 2-hour edit ≈ a few MB) and is easy to recover by hand.

## ADR-006 — Preview via browser media elements (Phase 1)
Fastest path to real, synchronized playback using hardware decode. Limitations (frame accuracy while
playing, effects preview) are known; the plan is a WebCodecs + WebGL/WebGPU compositor (Phase 3) fed
by the same layout math. Non-previewable codecs and VFR sources get automatic H.264 CFR proxies.

## ADR-007 — Quality first
Default performance profile is **Quality** (CPU x264 CRF 18 slow). Hardware encoders are used only in
**Balanced** and only after a real test encode succeeded on the machine; the chosen encoder is logged
in the export task. Exports are verified before being published.

## ADR-008 — Test strategy
Vitest for core (unit) and engine (integration against real FFmpeg with generated media, checking
pixels and audio levels of rendered files). Playwright + Electron under Xvfb for end-to-end tests
of the real UI, with native dialogs stubbed in the main process.
