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

## ADR-009 — Script-to-Video as a pure planning layer over the editor (2026-11-12)
The production engine outputs ordinary Sequences. Benefits: everything generated is previewable,
editable, undoable and exported by the already-verified pipeline; QC and preference learning can
compare generated vs. edited versions with the same data model. Planning code is pure TypeScript
(testable without FFmpeg); only audio analysis and file scanning live in the engine.

## ADR-010 — Model-free alignment first, recogniser optional
Pause-based DP alignment works offline on any machine with zero downloads and is accurate at the
sentence level when the narration has natural pauses (validated on real audio). Word-level timing
uses a recogniser transcript when available (faster-whisper sidecar, opt-in model download).
Rationale: the brief forbids silent model downloads, and a 4 GB VRAM laptop must stay usable.

## ADR-011 — Captions via ASS/libass
One caption model renders through libass in export (any FFmpeg build with libass, incl. BtbN Windows
builds) and through matching HTML/CSS metrics in the preview. Fonts: Arial (present on Windows,
mapped by fontconfig elsewhere).

## ADR-012 — Ken Burns via per-frame scale + fixed crop
`scale=eval=frame` + `crop` with time expressions gives smooth zoom/pan with a fixed output size;
the identical formula (core/motion.ts, smoothstep easing) drives the CSS preview. Zoompan was
rejected (integer jitter unless heavily upscaled).

## ADR-013 — Production scripts are imported, not reformatted by the user
Real scripts arrive as PDFs with timed headings, VISUELS/Montage/Texte/Sources blocks and annexes.
Primestone converts them to its Markdown-with-directives form (`scriptImport.ts`) instead of asking
the author to rewrite them; the converted text is shown and editable. PDF text comes from pdf.js;
words glued by justification are repaired with word lists plus the document's own vocabulary.

## ADR-014 — Transcription through user-installed engines
Two backends behind one contract (word JSON): faster-whisper (Python) and whisper.cpp (single
executable, CUDA builds). Primestone checks but never installs or downloads; audio is decoded to
16 kHz WAV by Primestone and stays local. Alignment is a banded edit-distance DP anchored on unique
trigrams (linear memory, 15k words < 1 s), edges snapped to speech onsets from the audio analysis.

## ADR-015 — Ducking as a deterministic envelope
Music ducking is computed from the narration track's waveform peaks into a gain envelope shared by
the preview (Web Audio) and the export (`asendcmd` + `volume`), instead of `sidechaincompress`,
so what is heard while editing is what is exported and the depth is editable and learnable.

## ADR-016 — Procedural sound effects, segmented export
SFX (whoosh, impact, tick) are synthesised with FFmpeg: no sample library, no licence question.
Long or clip-heavy exports are rendered in video segments cut where no transition runs, plus one
audio pass, joined by stream copy and verified; segments are reused after an interruption.
