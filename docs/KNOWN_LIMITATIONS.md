# Known limitations (v0.1.0)

Honest list; each item has a planned phase.

## Preview
- Playback uses one browser media element per visible clip with drift correction (re-seek beyond
  ~0.1 s). It is smooth for typical edits but not guaranteed frame-exact *while playing*; paused
  frames are exact. Export is always authoritative. → Phase 3 WebCodecs compositor.
- Reverse playback (J) steps by seeking and is not smooth.
- Clips cut very close together may show a brief black/frozen frame on the cut during playback while
  the next element seeks (pre-seeking 2 s ahead mitigates it).
- Codecs Chromium cannot decode (ProRes, DNxHR, HEVC on some systems, 10-bit 4:2:2…) are previewed
  only after their proxy is generated (background task).

## Editing
- Only one transition type (cross-dissolve / audio crossfade). No keyframes, effects, titles, nesting or copy/paste yet (Phase 2/4).
- Transitions need real source handles on both sides; Primestone does not invent frozen frames.
- Ripple operations affect the edited clip's track(s) and linked tracks only, not all tracks.
- Clip speed changes are modelled (`speed`) but not exposed (always 1×).
- Sequence settings cannot be changed after creation.

## Export
- One export at a time per click; no persistent render queue, no segmented/resumable export yet.
- Very long timelines with hundreds of clips create one FFmpeg input per clip; fine for normal
  projects, will be replaced by segmented rendering in Phase 3.
- HEVC export needs an FFmpeg build with libx265 (GPL build) or a hardware HEVC encoder.

## Platform
- Developed and tested on Linux (CI + container) and configured for Windows (CI job builds and tests
  on windows-latest). The Windows job has not yet been observed passing from this environment (no
  Windows runner available here); see TEST_REPORT.md.
- No GPU was available in the development container: hardware encoders/decoders are implemented with
  verification but not exercised in tests here.
- Installer is unsigned (SmartScreen warning on Windows).

## Script-to-Video (v0.5)
- Word-level sync needs a transcription engine installed by the user (faster-whisper or
  whisper.cpp) and a Whisper model on disk; Primestone does not download either. Without it, sync
  is pause-based and was measured at ~3 s median error on a TTS narration: not production quality.
- All measurements so far use a synthetic espeak-ng voice; **the real narration ("test spidey") has
  not been processed yet** because it is on the user's PC, not in the development environment.
- whisper.cpp backend: implemented from its documented JSON output and unit-tested on that format,
  but not run end-to-end here (no ggml model reachable from the development network).
- Procedural compositions render at ≈ 2× real time on 4 CPU cores (1080p): a 90-minute video with
  no illustrations needs hours on such a machine. GPU acceleration of compositions is not done.
- Knowledge base: ~50 curated entries + names learned from each script (marked uncertain, no facts).
  Comic references are read from sources, narration and file names (series/volume/issues/year);
  pictures without a number or year in their name cannot be checked against a cited issue.
- No web media providers yet (rights model and UI exist; no provider implemented or tested).
- PDF import: multi-column layouts and tables inside the narration are not handled; production
  tables in annexes are kept as notes, not applied to the edit.
- Hardware encoders (NVENC on the RTX 3050) and CUDA transcription have never run on real hardware
  here: use "Save diagnostics report" in Settings to measure them on the target PC.

## Voice cleanup (v0.6)
- Tuned and verified on synthetic voices only (espeak, generated harmonics + noise); thresholds may
  need adjusting on a real microphone recording. Denoising is FFmpeg's afftdn (spectral): good on
  steady noise (fans, hiss, hum), weak on non-stationary noise (traffic, keyboard, reverb). No
  de-reverberation, no AI denoiser (it would require downloading a model).
- The cleaned copy is regenerated per production settings (cached by content + chain); it is stored
  in the project's `Cache/voice` folder (≈ 8.6 MB per minute, 24-bit WAV).

## P-CORE (v0.6)
- Rendered offline (cached video clips), not live in the viewer; reaction changes need a re-render.
- Measured only with software WebGL (no GPU here): ≈ 3 fps at 1080². GPU speed on the RTX 3050 unknown.
- The narration "test spidey" has not been processed: it is on the creator's PC.
- Emotion is not inferred from the voice (loudness, transients, rhythm and script cues only).

## v0.7
- Script-less mode needs the local transcription (Python + faster-whisper + a Whisper model, installed
  by the user). Section titles are names taken from the speech; a section boundary is only found at a
  long pause or a spoken cue.
- Narration type detection is rule-based; confidence is often 30–45 % on mixed videos (shown in the
  report; the type can be forced).
- Comics format detection relies on gutters between panels: borderless or overlapping panels are
  not found; a coloured manga is read left to right unless its file name says manga/chapitre.

## Matching, decisions and analysis (13/11/2026)
- Pictures are matched on metadata (file name, tags, folder, comic references), user descriptions and,
  when Tesseract is installed and enabled, OCR text. **No model looks at the pixels**: a character drawn
  in a picture named `IMG_0042.jpg` is not recognised. The interface says so and caps metadata-only
  confidence at 75 %.
- Relevance has **not been measured on real data**: the benchmark tools exist (docs/BENCHMARK.md), the
  annotated datasets do not yet.
- OCR on comic lettering (capitals, stylised fonts, sound effects) is often poor; its confidence is shown.
  The real OCR integration test is skipped where Tesseract is absent (as in the development container).
- Panel detection relies on gutters (XY-cut). Borderless panels, slanted gutters and art across gutters
  give a low confidence; it has not been measured on real pages yet.
- Music per section switches tracks on a pause of the voice with a fade out then a fade in (no
  overlapping crossfade: both beds share one audio track).
- The media index is a JSON file (fine for thousands of files; not yet measured beyond 10 000).
- Script structure is read with explicit French rules; unknown names (not in the dictionary nor repeated in
  the script) are not recognised as entities.

## Comics réels et retouches (14/11/2026)
- **Découpe des cases** : sur 139 pages réelles (Avengers 2013 n° 1 à 3, Black Panther 2018 n° 1 et 2) :
  - 105 pages sont lues case par case ;
  - 18 sont jugées incertaines et montrées entières, puis parcourues, sans découpe ;
  - 11 sont classées générique (titres, crédits, publicités) ;
  - 5 sont des couvertures.

  Quand c'est ambigu, plusieurs images peuvent partager un même grand cadre : c'est voulu, pour ne jamais
  couper une case. Les cases superposées à une image en fond perdu ne sont pas séparées.
- **Détecteur de bulles** : il sert de garde-fou (4 bulles ou plus = page d'histoire). Il rate des bulles
  sur certaines pages sombres et voit parfois des « bulles » dans une publicité.
- **OCR** : le lettrage des comics reste difficile pour Tesseract, surtout les onomatopées et les polices
  stylisées. Le texte anglais des bulles n'aide à caler une page sur une narration française que par les
  noms propres.
- **Retouches en français** : seules les consignes sur les réglages sont comprises (plans, cases,
  musique, voix, sous-titres, titres, noms, logo, mouvement, fondus, pauses, hésitations, ordre des pages).
  Une consigne qui vise un instant précis (« à 0:32 mets la page 12 ») n'est pas encore comprise :
  utilisez `[VISUEL: page 12]` dans le script.
- **Analyse d'une vidéo YouTube par son lien** : non prise en charge. Le téléchargement est contraire aux
  conditions d'utilisation de YouTube et bloqué par sa vérification anti-robot. L'analyse se fait sur un
  fichier vidéo présent sur l'ordinateur.
- **Dicter une retouche** : le micro passe par la permission de l'application, puis la transcription locale
  (Whisper). Cette dictée n'a pas été testée avec un vrai micro dans l'environnement de test.
