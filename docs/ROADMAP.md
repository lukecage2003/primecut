# Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Environment inspection, architecture, audit of critical tech, repo, tests & conventions | **Done** |
| 1 | Vertical slice: launch → create → import → library → timeline → preview → cut/move → save → close → reopen → export | **Done** (E2E green) |
| 2 | Editor (continues as the correction layer): transitions (cross-dissolve, dip), audio fades & clip/track volume automation, nesting, titles track, insert/overwrite from source monitor with in/out, multi-select box, copy/paste, ripple across tracks, sequence settings editing, OTIO/EDL/FCPXML interchange | Next |
| 3 | Render & performance: WebCodecs + WebGL/WebGPU preview compositor (frame-exact playback, effects preview), segmented resumable export, render queue UI, proxy manager UI, preview render cache | Planned |
| 4 | Motion Design: layers/groups, text & shapes, keyframes with Bézier easing, masks, parenting, precomps, 2D/2.5D camera, parallax, comic panels/bubbles/onomatopoeia animation | Planned |
| 5 | Editorial intelligence: script import, narrative segmentation, storyboard, visual suggestions from the user's own media, assisted rough cut with human approval | Planned |
| 6 | Local AI & voice: model manager (explicit downloads, license display), faster-whisper transcription, alignment, Piper TTS with per-voice licenses, denoise/voice cleanup, consented voice cloning only | Planned |
| 7 | Comics Intelligence: knowledge model separating verified facts / interpretations / theories / uncertain info, sourced entries only | Planned |
| 8 | Vertical formats & automation: subject tracking + dynamic reframing, caption-safe layout, independent versions, voice commands, preference learning | Planned |
| 9 | Stabilisation: security review, performance/load tests, signed installer, docs, compatibility matrix | Planned |

## Re-prioritisation — 2026-11-12 (mission update)

The product goal is now **Script-to-Video for comics content**. Phases 5 (editorial intelligence),
6 (local AI & voice) and 7 (comics intelligence) are pulled forward and merged into a single
track, **STV**, which takes priority over remaining classic-editor features. See
[SCRIPT_TO_VIDEO.md](SCRIPT_TO_VIDEO.md) for the stage-by-stage status.

| Track | Scope | Status |
|---|---|---|
| STV-1 | Script parsing, narration analysis, pause alignment, beats, entity index, media matching, timeline builder, captions, motion, QC, preference adaptation, UI | **Done** (tested end-to-end) |
| STV-2 | Comic-page presentation (blurred fill, panel-by-panel moves), sidechain ducking, SFX, pacing from intent | Next |
| STV-3 | Word-level recogniser sidecar (faster-whisper, opt-in model download), knowledge-base editor with sources | Planned |
| STV-4 | Rights-aware web media providers (consent-gated), credits generation | Planned |
| STV-5 | Version comparison/A-B, automatic regeneration loop driven by QC | Planned |

Classic editor items of Phase 2–4 continue only where STV needs them (e.g. keyframes for panel moves).

Order changes are recorded here with their reason.

- 2026-11-12: Packaging (electron-builder NSIS + CI Windows job) pulled forward from Phase 9 so every
  phase is validated on Windows, the priority platform.
