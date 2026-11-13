# Benchmark open source — Primestone Motion Studio

Date : 13 novembre 2026 · Primestone est distribué sous licence **MIT**, en application de bureau
installable (code propriétaire possible pour les extensions). Conséquence : du code **GPL/AGPL ne peut
pas être intégré** dans l'application (il imposerait cette licence à l'ensemble) ; un programme GPL
peut seulement être livré **à côté**, comme exécutable séparé appelé en sous-processus (c'est déjà le
cas de FFmpeg, build GPL), avec sa licence et l'accès à ses sources.

## 1. Projets inspectés dans leur code

Méthode : clone en lecture seule (`git clone --depth 1`) dans un dossier isolé, rien n'est exécuté
sauf whisper.cpp (compilé depuis les sources et testé). Fichiers lus : licence, manifestes de
dépendances, arborescence, modules clés cités ci-dessous. Activité = date du dernier commit.

| Projet | Fonction | Technologie | Licence | Activité | Intérêt pour Primestone | Décision |
|---|---|---|---|---|---|---|
| **whisper.cpp** (ggml-org) | Reconnaissance vocale locale | C/C++, ggml, CPU/CUDA/Vulkan | **MIT** | 13/11/2026, v1.9.5 | Supprime l'obligation d'installer Python. `examples/cli/cli.cpp` : horodatage par mot (`-ml 1 -sow`), JSON complet (`-ojf`), VAD Silero intégré (`--vad`, `-vm`), DTW. Table SHA-1 officielle des modèles (`models/README.md`). Binaires Windows officiels (`whisper-bin-x64.zip`, variante CUDA). | ✅ **Intégré** (v0.7+) : binaire embarqué, gestionnaire de modèles, test réel en CI. |
| **OpenASR** (QuintinShaw) | Application de transcription locale | Rust + ggml | Apache-2.0 | 30/10/2026 | Même moteur ggml que whisper.cpp, avec API HTTP locale et diarisation. Plus lourd à embarquer (chaîne Rust). | 📚 Référence (diarisation, API locale) ; whisper.cpp suffit. |
| **MLT Framework** | Moteur de montage multipiste | C, plugins FFmpeg/Qt | **LGPL-2.1** | 07/11/2026 | Timeline, transitions, keyframes, filtres temps réel éprouvés (Shotcut, Kdenlive). Nous avons un moteur FFmpeg (graphe de filtres + rendu segmenté reprenable) validé par 130 tests ; migrer serait une réécriture du rendu. LGPL : liaison dynamique possible avec obligations. | 📚 Référence (modèle de keyframes, transitions). ❌ pas de migration sans démonstration de supériorité. |
| **OpenTimelineIO** (ASWF) | Format d'échange de timelines | C++/Python | Apache-2.0 | 10/11/2026 | Échange avec d'autres logiciels. Le cahier des charges exclut toute dépendance à Premiere/Resolve ; un export OTIO resterait une option d'interopérabilité. Le format JSON est documenté : un export natif ne nécessiterait pas la bibliothèque. | 🕓 P3 (export optionnel, sans dépendance). |
| **FrameTrellis** (sanskarIN) | Éditeur vidéo de bureau | C++20, Qt 6/QML, MLT | **GPL-3.0** | 13/11/2026 | Très proche de nos principes (local, sauvegardes atomiques, format de projet versionné, autosave). `docs/architecture/project-format.md` : courbes de volume/opacité/transform interpolées linéairement, ≤ 1000 points, valeurs tenues aux extrémités. | 📚 Référence pour les keyframes (P1) ; ❌ code non réutilisable (GPL). |
| **OpenKatana** (rk0neki) | Moteur de montage piloté par agent IA | Python, WebGL, Blender, ComfyUI | Apache-2.0 | 04/11/2026 | Outils de timeline, typographie, caméras, 3D WebGL, « match a reference ». Architecture « un projet, plusieurs entrées » (CLI, MCP, studio). Dépendances lourdes (ComfyUI, Blender) incompatibles avec une installation simple. | 📚 Référence (catalogue d'outils de montage, typographie). |
| **OpenMontage** | Production vidéo pilotée par agent | Python, Remotion, API génératives | **AGPL-3.0** | 08/11/2026 | Pipeline recherche → script → plan de scènes → composition. Repose sur des services de génération (Veo, Kling, fal.ai) : contraire à nos règles (local, pas d'IA générative d'images). | ❌ Rejeté (AGPL + cloud) ; idée retenue : plan de scènes explicite. |
| **BallonsTranslator** (dmMaze) | Traduction de planches (détection de texte, OCR, effacement, relettrage) | Python/Qt, PyTorch, ONNX | **GPL-3.0** | 09/11/2026 | Chaîne complète comics : `modules/textdetector`, `modules/ocr` (manga-ocr, mit48px, PaddleOCR…), `modules/inpaint` (LaMa, AOT, PatchMatch). Référence la plus complète pour la Comic Intelligence. | 📚 Référence d'architecture ; ❌ code non intégrable (GPL). |
| **comic-translator** (UnfetteredScholar) | Traduction de planches | FastAPI + React, transformers, ONNX Runtime | **MIT** | 08/08/2026 | `text_detector.py` : détection bulles/texte avec le modèle RT-DETR `ogkalu/comic-text-and-bubble-detector` ; `image_clean.py` : effacement avec `lama_manga.onnx` via ONNX Runtime ; OCR et traduction par des modèles de 2,2 et 14 milliards de paramètres. | 🕓 Adapter (P2) la partie **ONNX** (détection de bulles, effacement) via onnxruntime-node ; licences des **poids** à vérifier modèle par modèle ; OCR/traduction trop lourds pour une RTX 3050 4 Go. |

## 2. Pistes non inspectées dans cette session (connaissance générale, à vérifier avant usage)

| Projet | Fonction | Licence (à confirmer) | Usage envisagé |
|---|---|---|---|
| auto-editor | Coupe des silences | Unlicense | Idée reprise (réimplémentée) : pauses resserrées, v0.7. |
| Kumiko | Découpage des cases | à vérifier | Idée reprise : lecture droite → gauche des mangas, v0.7. |
| WhisperX | Alignement forcé (phonèmes) | BSD-2 (code) ; modèles wav2vec2 variés | P2 : précision < 50 ms sans script, nécessite un 2ᵉ modèle (accord requis). |
| Silero VAD | Détection de parole | MIT | Disponible via whisper.cpp (`--vad`) : P1 pour détecter respirations/hésitations. |
| ONNX Runtime | Inférence locale (CPU/DirectML/CUDA) | MIT | Socle des modèles comics et image (P2). |
| Tesseract / tesseract.js | OCR | Apache-2.0 | OCR des bulles en anglais (P2), léger. |
| LaMa | Effacement de texte | Apache-2.0 (code) | Remplacement des textes de bulles (P2/P3). |
| OpenCLIP | Recherche d'images par le sens | MIT (code), poids selon jeu d'entraînement | P2 : correspondance phrase ↔ illustration au-delà des noms de fichiers. |
| OPUS-MT (Marian) | Traduction EN→FR locale | CC-BY 4.0 (poids) | P3 : traduction des dialogues. |
| Remotion | Rendu vidéo en React | licence entreprise payante au-delà de 3 personnes | ❌ Rejeté (coût / licence). |
| Essentia | Analyse musicale (humeur, tempo) | **AGPL-3.0** | ❌ Rejeté ; analyse musicale faite avec FFmpeg + nos propres mesures. |

## 3. Synthèse

- **Intégré** : whisper.cpp (transcription sans Python, avec vérification des modèles).
- **À adapter (P2)** : modèles ONNX pour la Comic Intelligence (bulles, effacement), OpenCLIP pour la
  recherche sémantique d'images, Silero VAD via whisper.cpp.
- **Références** : MLT et FrameTrellis (keyframes, format de projet), BallonsTranslator (chaîne comics),
  OpenKatana (outils de montage), OpenASR (diarisation).
- **Rejetés** : OpenMontage (AGPL + services génératifs), Remotion (licence), Essentia (AGPL).
- **Moteur de rendu** : aucun projet inspecté ne justifie de remplacer le moteur FFmpeg actuel ni P-CORE ;
  MLT reste la seule alternative crédible et ne serait envisagée qu'après une démonstration chiffrée.
