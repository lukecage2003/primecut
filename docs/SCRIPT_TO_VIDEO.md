# Script-to-Video — architecture and status

Mission (2026-11-12 update): Primestone is primarily an **autonomous comics-video production
system**. Input: a script, the recorded narration, the user's images/covers/videos, optional
editorial directions. Output: a complete first cut (media, edit, motion, titles, subtitles, sound,
QC) that stays fully editable in the timeline.

## Re-evaluated architecture

The editor built in Phases 1–2 is kept as the **execution and correction layer**: a generated cut is
an ordinary `Sequence`, so preview, manual editing, undo, save and verified export all apply to it.
A new layer sits on top:

```
src/production/   (pure TypeScript, no I/O — runs in tests, main process and renderer)
  script.ts       FR-aware parsing: sections, sentences, directives [VISUEL:] [TITRE:] [PAUSE] [NOTE:]
  align.ts        text ↔ voice: alignByPauses (model-free DP on pauses) | alignToTranscript (word-level)
  knowledge.ts    comics knowledge base with evidence status (verified/curated/interpretation/theory/uncertain)
  entities.ts     entity recognition (FR/EN aliases, issue numbers, unknown proper nouns)
  planner.ts      beats (editorial sequences), library indexing, explainable media scoring, reservations
  builder.ts      timeline construction: shots, Ken Burns, dissolves, narration/music levels, captions
  qc.ts           quality control + safe auto-fixes + style measurement
  preferences.ts  production preferences + adaptation from user edits (versioned, revertible)
src/engine/
  audioAnalysis.ts  silencedetect + EBU R128 loudness
  production.ts     pipeline orchestration (stages reported through the TaskOrchestrator)
src/core/  motion.ts (shared Ken Burns math), captions.ts (wrapping + ASS), plan.ts (render plan)
```

Pipeline stages and where they stand (numbers = the mandatory pipeline of the brief):

| # | Stage | Status | Implementation |
|---|---|---|---|
| 1 | Analyse script and narration | **Done** | script.ts, audioAnalysis.ts |
| 2 | Text/voice sync (sentence, word) | **Partial** | Sentence level from pauses (tested ±0.3 s on real audio); word level when a transcript is available (alignToTranscript, tested); local recogniser sidecar not yet integrated |
| 3 | Split into editorial sequences | **Done** | planner.buildBeats (sections, pauses, subject changes, target length) |
| 4 | Identify characters, events, comics, places | **Partial** | Seed knowledge base (52 entries) + unknown-name detection; no user-editable KB UI yet |
| 5 | Visual needs per sequence | **Done** | entities, [VISUEL:] hints, keywords, issue numbers |
| 6 | Find media (user files / allowed web sources) | **Partial** | User folders + project media with tags/sidecars. Web providers: designed (rights model + policy), not implemented (network sources unavailable in the dev environment) |
| 7 | Check relevance, provenance, terms of use | **Partial** | Every asset carries `rights`; non-cleared media are never auto-placed; QC errors block-flag them |
| 8 | Build the timeline automatically | **Done** | builder.ts |
| 9 | Choose images and durations from narration | **Done** | scoring + reservations + no-repeat rules + split of long beats |
| 10 | Zooms, moves, transitions | **Done (v1)** | Ken Burns (6 kinds), panel-by-panel page reading, blurred fill, dissolves; procedural motion design (docs/VISUALS.md) |
| 11 | Titles, subtitles, graphics | **Partial** | Section titles, subtitles (≤2×42 chars), name tags, missing-visual cards (ASS export, identical preview) |
| 12 | Sound environment | **Partial** | Narration normalised to −16 LUFS, music bed at a relative level with fades; no sidechain ducking or SFX yet |
| 13 | Rhythm from narrative/emotional intent | **Planned** | Needs sentiment/intensity cues |
| 14 | Automatic QC + corrections | **Done** (v1) | qc.ts: gaps, shot length, repeats, rights, placeholders, caption overflow, sync confidence; auto-fix gaps/repeats |
| 15 | Editable preview | **Done** | Generated sequence opens in the editor; report explains each shot |
| 16 | Export in requested format | **Done** | Existing verified exporter (captions burned via libass) |

## Learning: what it is and is not

`adaptPreferences` compares the style of the generated version with the user's edited version
(mean shot length, motion types, dissolve share, music level, subtitles) and moves the production
preferences toward the user's choices (EMA, α = 0.35). Every change is a new preferences version
with a human-readable list of changes, stored in the user profile and revertible. **This is
parameter adaptation, not model training**; no model weights are trained or downloaded.

## Rights policy (media)

`MediaRights.usage`: `owned` · `user-provided` · `reusable` (licence + attribution) ·
`permission-required` · `view-only` · `unknown`. Automatic edits only place `owned`,
`user-provided` and `reusable` items. Anything else is at most listed as a reference. Provenance
(source, licence, URL, attribution, check date) is stored on the asset and saved in the project.
Web providers will be disabled by default and require explicit consent per provider.

## Next steps (in order)
1. ~~Blurred fill, panel-by-panel reading, procedural audio-reactive motion design~~ (done).
2. Optional local word-level recogniser (faster-whisper sidecar, model downloaded only on explicit request, licence shown).
3. Web media providers with licence filters (Wikimedia Commons / Openverse), consent-gated, attribution credits.
4. Sidechain ducking, SFX layer, emotional pacing cues from the script.
5. Version comparison view (QC score, style metrics) and A/B regeneration.
