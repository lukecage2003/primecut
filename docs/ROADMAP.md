# Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Environment inspection, architecture, audit of critical tech, repo, tests & conventions | **Done** |
| 1 | Vertical slice: launch → create → import → library → timeline → preview → cut/move → save → close → reopen → export | **Done** (E2E green) |
| 2 | Editor: transitions (cross-dissolve, dip), audio fades & clip/track volume automation, nesting, titles track, insert/overwrite from source monitor with in/out, multi-select box, copy/paste, ripple across tracks, sequence settings editing, OTIO/EDL/FCPXML interchange | Next |
| 3 | Render & performance: WebCodecs + WebGL/WebGPU preview compositor (frame-exact playback, effects preview), segmented resumable export, render queue UI, proxy manager UI, preview render cache | Planned |
| 4 | Motion Design: layers/groups, text & shapes, keyframes with Bézier easing, masks, parenting, precomps, 2D/2.5D camera, parallax, comic panels/bubbles/onomatopoeia animation | Planned |
| 5 | Editorial intelligence: script import, narrative segmentation, storyboard, visual suggestions from the user's own media, assisted rough cut with human approval | Planned |
| 6 | Local AI & voice: model manager (explicit downloads, license display), faster-whisper transcription, alignment, Piper TTS with per-voice licenses, denoise/voice cleanup, consented voice cloning only | Planned |
| 7 | Comics Intelligence: knowledge model separating verified facts / interpretations / theories / uncertain info, sourced entries only | Planned |
| 8 | Vertical formats & automation: subject tracking + dynamic reframing, caption-safe layout, independent versions, voice commands, preference learning | Planned |
| 9 | Stabilisation: security review, performance/load tests, signed installer, docs, compatibility matrix | Planned |

Order changes are recorded here with their reason.

- 2026-11-12: Packaging (electron-builder NSIS + CI Windows job) pulled forward from Phase 9 so every
  phase is validated on Windows, the priority platform.
