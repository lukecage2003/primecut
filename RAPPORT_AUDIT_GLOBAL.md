# Rapport d'audit global — Primestone Motion Studio

Date : 13 novembre 2026. Auteur : audit technique de la mission maître.
Compagnon : [`docs/BENCHMARK_OPEN_SOURCE.md`](docs/BENCHMARK_OPEN_SOURCE.md),
[`docs/THIRD_PARTY.md`](docs/THIRD_PARTY.md).

## Phase 0 — État de référence

| Élément | Constat (vérifié) |
|---|---|
| Branche | `claude/gallant-hawking-c8govj`, aucun changement non commité au départ. |
| Version réelle | **0.7.0** (et non 0.6.0 comme indiqué dans la mission) : interface française, mode sans script, détection des types de narration et des formats de comics ont été livrés après le run 24. |
| Commit de référence | `4bb2225` — CI run 27 ✅ Windows + Linux (tests, E2E, installateur, installation/auto-test/désinstallation). Run 24 (`44fc577`, v0.6 + P-CORE V1.1) ✅ également. |
| Installateur de référence | Artefact `primestone-windows-installer` du run 27 (`Primestone Motion Studio Setup 0.7.0.exe`). |
| Tests au départ | 92 unitaires + 33 intégration + 6 E2E (dénombrement des fichiers de test), tous verts localement et en CI. |
| Code | ~14 400 lignes TypeScript : `core` 2 100, `engine` 3 100, `production` 3 100, `pcore` 870, `main` 920, `renderer` 4 000. |

## Phase 1 — Matrice des fonctionnalités

États : ✅ livré et validé · 🟡 livré, à améliorer · 🟠 partiel · ⛔ absent · 🔬 à étudier.

### A. Production Studio
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Création / ouverture / enregistrement | ✅ | E2E « vertical slice », sauvegarde atomique + 20 sauvegardes | — | — |
| Autosave + récupération après plantage | ✅ | E2E « crash recovery » | — | — |
| Duplication de projet | ⛔ | — | pas d'action « Dupliquer » | P2 |
| Tableau de bord (projets récents) | 🟡 | écran d'accueil | pas de vignettes ni d'état des rendus | P2 |
| Suivi des rendus / tâches | ✅ | panneau Tâches (orchestrateur avec priorités, annulation) | — | — |
| Gestion des modèles IA | ✅ **(nouveau)** | gestionnaire whisper : consentement, reprise, SHA-1 (3 tests) | un seul type de modèle | étendre (VAD, ONNX) en P2 |
| Paramètres globaux | ✅ | Réglages (thème, performances, transcription, diagnostic) | — | — |

### B. Script Studio
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Import PDF/TXT/MD | ✅ | 5 scripts réels, mots collés réparés, bibliographie exclue | colonnes multiples non gérées | P3 |
| Éditeur de texte | 🟡 | zone de texte du panneau Script → Vidéo | pas d'éditeur dédié (recherche, surlignage des entités) | P2 |
| Analyse narrative, sections, rythme | ✅ | pacing, types de narration (tests + 5 scripts) | confiance 30–45 % sur vidéos mixtes | P2 |
| Personnages / événements / références | 🟡 | ~50 entités + noms appris + références structurées | pas de base de publications/dates | P2 |
| Liaison phrase ↔ plan ↔ média | ✅ | raisons par plan, clic → position | — | — |
| Modifications du script après génération | 🟡 | régénération = nouvelle version | pas de mise à jour incrémentale | P2 |
| Sans script (narration → script) | ✅ | narration réelle Midnight Spider-Man | titres de section = noms cités | — |

### C. Voice Studio
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Transcription locale | ✅ **(amélioré)** | whisper.cpp intégré, plus de Python requis ; test reconnaissance réelle en CI (modèle officiel base) | qualité sur votre voix à mesurer avec « small » | P1 : mesure sur votre machine |
| Alignement script ↔ voix | ✅ | 6 ms médiane / 94,5 % ≤ 250 ms (documentaire 66 min, vérité terrain) | — | — |
| Prises ratées, hors script | ✅ | narration réelle (348,5 s) | — | — |
| Respirations / hésitations | 🟠 | pauses détectées (seuil adaptatif) | « euh », respirations non classées | P1 : VAD Silero via whisper.cpp |
| Nettoyage (bruit, ronflement, de-ess, EQ, compression, LUFS) | ✅ | tests + voix réelle (−35,5 → −16,1 LUFS) | réglé sur une seule vraie voix | — |
| Emphase / rythme vocal | ✅ | P-CORE recalibré (emphase 40 % → 13 %) | — | — |
| Commandes vocales | ⛔ | — | absent | P3 (dépend de la transcription temps réel) |

### D. Comic Intelligence
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Détection des cases + ordre de lecture (manga RTL) | ✅ | fichiers réels (test d'intégration) | cases sans bordure non détectées | P2 (modèle ONNX) |
| Formats (couverture, planche, double page, webtoon) | ✅ | tests | — | — |
| Import d'archives CBZ/ZIP | ✅ **(nouveau)** | pages extraites dans l'ordre naturel, octet pour octet (test d'intégration) | CBR (RAR) non pris en charge : licence non libre | — |
| Bulles, OCR, dialogues | ⛔ | — | absent | P2 (ONNX + Tesseract, voir benchmark) |
| Traduction, effacement des textes | ⛔ | — | absent | P3 |
| Reconnaissance des personnages | ⛔ | — | uniquement par nom de fichier | P2 (OpenCLIP) |

### E. Image Intelligence
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Correspondance narration ↔ image | 🟡 | noms de fichiers, étiquettes, références de numéros | aucune analyse du contenu de l'image | P2 (recherche sémantique locale) |
| Doublons | ✅ **(nouveau)** | empreinte perceptuelle + couleur moyenne ; une copie n'est jamais montrée juste après l'original (test qui échoue sans le correctif) | images très retouchées non reconnues | — |
| Œuvres homonymes exclues | ✅ | tests | — | — |
| Droits / provenance | 🟡 | modèle de droits + QC bloque les droits non vérifiés | pas d'interface d'édition des droits | P2 |

### F. Media Library
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Import, miniatures, proxies, médias manquants | ✅ | E2E | — | — |
| Recherche | 🟡 | filtre par nom | pas de tags/collections dans l'interface | P2 |
| Recherche en ligne | ⛔ | — | aucun fournisseur | P2 (avec consentement, licences vérifiées) |

### G. Music Intelligence
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Ducking automatique, niveaux | ✅ | tests d'intégration | — | — |
| Effets sonores procéduraux | ✅ | tests | — | — |
| Bibliothèque musicale, ambiance, choix par séquence | ⛔ | — | une seule musique choisie à la main | **P1** |

### H. Graphics & Motion
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Compositions procédurales (7 types), typographie | ✅ | E2E « faceless » | variété limitée (répétitions consécutives mesurées) | P2 |
| Éditeur de calques, keyframes, masques, tracking | ⛔ | mouvements de caméra prédéfinis seulement | pas d'éditeur | P2 (keyframes) / P3 (masques, tracking) |

### I. P-CORE
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Rendu, 4 qualités, alpha vérifié, placement | ✅ | E2E + mesures logicielles | **GPU jamais mesuré** (RTX 3050) | mesure sur votre machine |
| Prévisualisation temps réel | 🟠 | rendu puis cache | pas de temps réel | P3 |

### J. Timeline Studio
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| Pistes, découpe, ripple/roll/slip/slide, marqueurs, zoom, magnétisme, annuler | ✅ | tests unitaires + E2E | — | — |
| Keyframes génériques | ⛔ | mouvements prédéfinis seulement | absent | P2 (modèle : courbes linéaires bornées, cf. FrameTrellis) |

### K. Thumbnail Studio
| ⛔ absent | — | — | — | P2 |

### L. Export Studio
| Fonctionnalité | État | Qualité / preuve | Problème | Action |
|---|---|---|---|---|
| 4 formats, H.264/H.265, vérification, reprise segmentée | ✅ | tests + documentaire 66 min | — | — |
| SRT/VTT | ✅ | test + E2E | — | — |
| Export par lot | ⛔ | — | absent | P2 |
| Comparaison de versions | ✅ **(nouveau)** | test + E2E (tableau mesuré) | ne mesure pas encore les fichiers exportés | P2 |
| Encodage NVENC | 🟡 | utilisé seulement s'il passe un test réel | jamais vu fonctionner sur votre machine | mesure |

### Transversal
| Sujet | État | Constat | Action |
|---|---|---|---|
| Interface en français | ✅ | interface, moteur, guides, **installateur (nouveau)** | — |
| Architecture de traduction | ⛔ | textes français en dur | P2 : catalogue de messages |
| Apprentissage des préférences | ✅ | versions + restauration, explication des changements | décisions acceptées/refusées non enregistrées → P2 |
| Sécurité processus | ✅ | aucun shell : tous les processus en tableau d'arguments | — |
| Protocole média | ✅ **(corrigé)** | servait n'importe quel fichier du disque → limité aux médias | — |
| Reproductibilité FFmpeg | 🟠 | build « latest » de la série 8.1 | P0-3 : épingler un build daté |
| Journalisation structurée | ✅ **(nouveau)** | `engine/log.ts` : JSON par ligne, catégories, niveaux, rotation (5 Mo, 14 jours), corrélation par tâche, dossier personnel masqué ; erreurs FFmpeg, processus principal et interface ; dépendances défaillantes et problèmes récents dans Réglages et dans le rapport de diagnostic | — |

## Phase 3 — Architecture

### Actuelle (conservée)

```
Renderer (React, sandbox, CSP)  ──IPC typée (shared/api.ts)──▶  Main (Electron)
   éditeur, inspecteur, studios                                   │ orchestrateur de tâches (priorités, annulation)
                                                                   ├─ engine/   FFmpeg (rendu, export segmenté), voix,
                                                                   │            transcription (whisper.cpp intégré),
                                                                   │            modèles (téléchargement vérifié)
                                                                   ├─ production/  script, alignement, réalisation,
                                                                   │               types de narration, comparaison (pur)
                                                                   ├─ pcore/   expression, placement (pur) + rendu WebGL
                                                                   └─ core/    modèle de projet, timeline, historique (pur)
```

Principe à garder : **cœur pur et testé** (`core`, `production`, `pcore` sans E/S) + **moteurs à effets**
(`engine`, `main`). Les 130 tests reposent sur cette séparation.

### Cible (évolutions, sans migration globale)

1. `engine/models` devient le **registre unique des modèles** (whisper, VAD, ONNX) : même contrat
   `catalogue → consentement → téléchargement vérifié → statut`.
2. Nouveau `engine/vision` (P2) : inférence ONNX Runtime pour bulles, cases sans bordure, empreintes
   d'images, recherche sémantique ; contrat `analyzeImage(path) → { panels, bubbles, embedding, phash }`
   stocké dans `MediaAsset` (champ versionné).
3. Nouveau `production/music` (P1) : analyse des pistes de la bibliothèque (FFmpeg : énergie, tempo,
   dynamique) → choix par section.
4. `core/keyframes` (P2) : courbes par propriété sur les clips, interprétées par l'export et
   l'aperçu.
5. Catalogue de messages (P2) : `renderer/i18n` avec clés et français par défaut.

### Risques et stratégie de tests
- Toute nouvelle dépendance passe par `docs/THIRD_PARTY.md` (licence, poids, obligations).
- Chaque lot : tests unitaires du cœur pur + intégration avec FFmpeg/whisper réels + E2E si interface.
- Tests « modèle réel » en CI uniquement quand la source est vérifiable (SHA).

## Phase 4 — Feuille de route

| Prio | Tâche | Fichiers | Critère d'acceptation | Tests | Risque |
|---|---|---|---|---|---|
| **P0-1** ✅ | Protocole média limité aux médias | `main/protocol.ts` | un fichier non média → 403 | E2E (lecture inchangée) | faible |
| **P0-2** ✅ | Installateur en français | `package.json` (nsis) | installation silencieuse OK en CI | CI install/uninstall | textes non vérifiés visuellement |
| **P0-3** | Reproductibilité du build FFmpeg | `scripts/fetch-ffmpeg.mjs` | même SHA-256 à chaque build | CI | **constat** : BtbN ne conserve qu'environ un mois de builds datés (37 tags) — épingler un tag casserait le build après quelques semaines. Traçabilité actuelle : SHA-256 de l'archive + version exacte relevée par l'auto-test de chaque installateur. **Solution proposée, à valider par vous** : archiver le build FFmpeg retenu dans une *release* GitHub de Primestone (publication) puis épingler sur cette archive. |
| **P1-1** ✅ | Transcription intégrée sans Python | `engine/transcribe.ts`, `engine/models.ts`, Réglages | modèle téléchargé avec accord, vérifié, utilisé | 3 intégration + reconnaissance réelle CI | qualité sur vraie voix à mesurer |
| **P1-2** ✅ | Comparaison mesurée des versions | `production/compare.ts`, Inspecteur | tableau, verdicts techniques seulement | unitaire + E2E | — |
| **P1-3** ✅ | Import d'archives CBZ/ZIP de planches | `engine/production.ts` (scan) | pages extraites dans l'ordre, cases détectées | intégration | archives volumineuses |
| **P1-4** ✅ | Doublons d'images (empreinte perceptuelle) | `engine/media.ts`, planner | doublon jamais montré deux fois comme deux images | intégration | faux positifs |
| **P1-5** | Musique par section depuis une bibliothèque locale | `production/music.ts` | choix expliqué, transitions aux changements de section | intégration | licence des musiques (droits) |
| **P1-6** | Respirations/hésitations (VAD) | whisper.cpp `--vad` | pauses classées, « euh » repérés | réel en CI | modèle VAD (consentement) |
| **P1-7** ✅ | Journal structuré (fichier) | `engine/log.ts`, `engine/deps.ts`, `main/`, Réglages | journal JSON, sans dossier personnel, rotation | 4 unitaires + E2E (dépendances listées) | — |
| P2 | Bulles/OCR (ONNX + Tesseract), recherche sémantique d'images, keyframes, éditeur de script, export par lot, catalogue i18n, Thumbnail Studio, recherche en ligne avec consentement | — | — | — | poids des modèles (4 Go VRAM) |
| P3 | Commandes vocales, traduction/effacement des bulles, masques/tracking, export OTIO, aperçu P-CORE temps réel | — | — | — | — |

## Phase 5 — Lots réalisés dans cette mission

| Lot | Contenu | Tests |
|---|---|---|
| 1 | whisper.cpp v1.9.5 intégré (compilé depuis le tag sur Linux et Windows, autonome : sans OpenMP, runtime statique — le tag n'a pas d'archive Windows publiée, constaté en CI), gestionnaire de modèles (consentement, reprise, SHA-1), Réglages, auto-test de l'installation, progression corrigée (elle n'était jamais lue) | 3 intégration (téléchargement, reprise, SHA-1 faux) + moteur détecté + reconnaissance réelle en CI avec le modèle officiel recommandé (`small`) |
| 2 | Installateur en français | CI Windows |
| 3 | Comparaison mesurée des versions | unitaire + E2E |
| 4 | Protocole média restreint aux médias | E2E |
| 5 | Registre des composants tiers, audit des licences transitives | — |
| 6 | Archives CBZ/ZIP (lecteur ZIP borné : noms jamais utilisés comme chemins, taille et nombre limités, images seules) | intégration (ordre naturel, pages identiques à l'octet, entrée hostile refusée, cache) |
| 7 | Doublons d'images (dHash + couleur moyenne) | unitaires + intégration ; un faux positif (couvertures teintées regroupées) détecté par le test Script → Vidéo puis corrigé |
| 8 | Dépendances de développement : Vite 8.0 → 8.3.8 (alerte « high » de launch-editor, serveur de dev seulement) | 134 tests + 6 E2E |

### Résultats de la CI (run 31)
- Windows : whisper.cpp compilé depuis le tag en 1 min 30, installateur, installation silencieuse,
  **auto-test de l'application installée (whisper-cli exécuté)**, désinstallation : ✅.
- Linux : modèle officiel `small` téléchargé, SHA-1 vérifié, reconnaissance réelle : ✅ **de justesse**
  (confiance 0,667 pour un seuil de 0,66). Texte reconnu sur la voix espeak : « C'est bien mal à
  foutre de bouffer au-delà du sud de New York… » — la voix robotique d'espeak est mal reconnue. Ce
  test prouve que la chaîne fonctionne (programme, modèle, horodatage, alignement), **pas la
  précision** ; sur votre vraie voix, le modèle `small` (via faster-whisper) donnait une
  transcription fidèle (confiance moyenne 0,91).

### CI après le run 31
- Runs 33 à 35 : **rouges sous Windows** — le test d'intégration CBZ appelait l'outil `zip`, absent
  des machines Windows de GitHub (`spawnSync zip ENOENT`). Corrigé au commit 45335c0 : le test
  construit lui-même l'archive (écrivain ZIP de test) et vérifie en plus deux noms d'entrée hostiles.
  Aucun code de l'application n'était en cause.

### Sécurité des dépendances
- `npm audit --omit=dev` : **0 vulnérabilité** dans ce qui est livré.
- Outils de développement : alerte « high » corrigée (Vite) ; 6 alertes « moderate » restantes
  (`minimatch` via electron-builder), sans effet sur l'application installée, correction seulement
  par une montée de version majeure de l'outil d'empaquetage (à planifier).

## Limites de cet audit
- Machine de l'utilisateur (RTX 3050) inaccessible : aucune mesure GPU.
- Modèles Whisper non téléchargeables depuis l'environnement de développement (Hugging Face bloqué) :
  la reconnaissance réelle est validée **en CI** avec le modèle officiel `base`.
- La fin du message de mission était tronquée après « BENCHMARK_OPEN_SOURCE. » : d'autres livrables
  de la phase 7 peuvent manquer.
