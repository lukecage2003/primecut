# Registre des composants tiers

Mis à jour : 13 novembre 2026 (v0.7.x). Primestone Motion Studio : licence MIT.
Audit des dépendances npm **embarquées** (fermeture transitive des `dependencies`, calculée depuis
`package-lock.json`) : 8 paquets — 7 MIT, 1 Apache-2.0 — **aucune licence copyleft**.

## Embarqués dans l'installateur

| Composant | Version | Source | Licence | Modifications | Obligations |
|---|---|---|---|---|---|
| Electron (Chromium, Node.js) | 45.3.1 | npm `electron` | MIT + avis tiers Chromium | aucune | Livrer `LICENSE` et `LICENSES.chromium.html` (fait par electron-builder). |
| React, React DOM, scheduler | 19.3.1 / 0.28.0 | npm | MIT | aucune | Avis de licence. |
| immer | 11.2.10 | npm | MIT | aucune | Avis de licence. |
| three (Three.js) | 0.170.0 | npm | MIT | aucune | Avis de licence. |
| pdfjs-dist | 4.10.38 | npm | Apache-2.0 | aucune | Avis + NOTICE Apache. |
| an-array-of-french-words / english-words | 2.0.0 | npm | MIT | aucune | Avis de licence. |
| **FFmpeg / FFprobe** (exécutables séparés) | série 8.1, build GPL « latest » BtbN (Windows) | github.com/BtbN/FFmpeg-Builds, SHA-256 vérifié | **GPL-3.0** (avec libx264/x265) | aucune | Appelés en sous-processus, jamais liés. `LICENSE.txt` et `SOURCE.txt` (archive, SHA-256, lien vers le code source exact) livrés dans `resources/ffmpeg`. ⚠ Version « latest » : épingler un build daté (voir RAPPORT_AUDIT_GLOBAL, P0-3). |
| **whisper.cpp** `whisper-cli` | v1.9.5 (`d1be6fd`) | github.com/ggml-org/whisper.cpp — compilé depuis les sources du tag sur chaque système (`scripts/fetch-whisper.mjs`) : CPU, sans OpenMP, runtime C/C++ statique (le tag n'a pas d'archive Windows publiée) | **MIT** | aucune (options de compilation seulement) | `LICENSE-whisper.cpp.txt` (texte exact du tag) et `SOURCE.json` (origine, SHA-256) livrés dans `resources/whisper`. |
| Logo et silhouette Primestone (P-CORE) | — | Primestone | propriété de Primestone | — | — |

## Téléchargés uniquement à la demande de l'utilisateur

| Composant | Taille | Source | Licence | Vérification |
|---|---|---|---|---|
| Modèles Whisper ggml (base, small, large-v3-turbo-q5_0, medium) | 142 Mo – 1,5 Go | huggingface.co/ggerganov/whisper.cpp | MIT (poids OpenAI Whisper, conversion whisper.cpp) | SHA-1 de la table officielle `models/README.md` de whisper.cpp ; fichier incomplet ou différent supprimé ; reprise possible. |

## Installés par l'utilisateur (facultatifs, non fournis)

| Composant | Licence | Usage |
|---|---|---|
| Python + faster-whisper (CTranslate2) | PSF / MIT | Moteur de transcription alternatif (réglages avancés). |

## Outils de développement et de test (jamais livrés)

| Composant | Licence | Usage |
|---|---|---|
| espeak-ng | GPL-3.0 | Voix de synthèse pour les campagnes et le test de reconnaissance en CI. |
| Playwright, Vitest, esbuild, Vite, TypeScript, electron-builder | Apache-2.0 / MIT | Tests, compilation, empaquetage. |
