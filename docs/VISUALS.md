# Primestone Visuals — faceless production & audio-reactive motion design

## Faceless by design
V1 needs no camera, webcam or on-screen presenter. A video is built only from the narration,
user-provided comics media, procedural motion design, typography, captions and sound.
Extension point for later (not in V1): presenter footage would be one more media source in the
decision order (e.g. "presenter" shots on V2 with their own placement rules); the planner, rights
model and render plan already treat every source uniformly, so no architectural change is needed.

## Decision order (never a black screen)
1. Relevant illustration/media available → used (explainable match).
2. Legally usable media found by search → *not yet available* (no web provider enabled); every
   generated shot records "web search: no provider enabled".
3. Explanatory motion design matched to the passage (`production/visuals.ts`):
   - character/team introduced → **character card** (name, publisher, role, HUD rings)
   - years / chronology → **timeline** (animated line, dated markers)
   - cosmic subject (univers, galaxie, multivers, Galactus…) → **cosmic** (star field, tinted nebula, voice particles)
   - AI / technology → **data matrix** (cellular data field, grid, hologram style)
4. **Voice HUD** (holographic rings, voice-driven core, live waveform); **dramatic** variant for intense passages.
5. **Kinetic typography** for pauses / key lines.
Consecutive generated shots never use the same composition (style/kind rotation, seeded variations).

## Real audio reactivity
- `voiceEnvelope`: RMS of the narration per video frame, fast attack / slow release, normalised to
  the 95th percentile → drives the glowing core and inner ring opacity through `sendcmd`
  (verified: core brighter while speaking than in pauses).
- `showwaves` (live waveform) and `avectorscope` (particle cloud) are computed from the real
  narration segment at the shot's timeline position.
- Pauses dim the visuals; speech rate and emphasis show up through the envelope dynamics.

## Rendering
Procedural only (FFmpeg sources/filters: gradients, geq-generated HUD textures, rotate, life,
noise, mandelbrot, showwaves, avectorscope, lagfun, gblur + screen blend in RGB, vignette) and
libass for typography and vector diagrams. No AI image generation, no external service.
Compositions are cached by spec hash in `Cache/generated/` and behave like normal media (preview,
trim, transitions, export). Shots carry 1 s handles so dissolves work.

## Manual control
Inspector → Motion design: composition, style (Primestone gold / Hologram / Crimson), title,
subtitle, "Shuffle" variation; each change re-renders in the background as one undoable step.
Production panel: style and "Motion design when no image" toggle.

## Performance
~4–9 s to render a 3 s 720p composition on 4 CPU threads (cosmic is the heaviest); rendering runs
two at a time in the task orchestrator. Known limit: moving a generated clip on the timeline does
not re-sync its audio reactivity until it is re-rendered (Inspector change or regeneration).
