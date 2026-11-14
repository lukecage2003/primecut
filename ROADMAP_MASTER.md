# Matrice de finalisation — Primestone Motion Studio

Mise à jour : 13 novembre 2026 (réalisation de l'audit), v0.7.x. **Document unique de suivi** (il remplace l'ancienne matrice ;
le détail historique reste dans `RAPPORT_AUDIT_GLOBAL.md`). Aucun pourcentage : chaque ligne a un état
et la preuve qui le justifie.

**États** :
1. ✅ terminé et validé (tests automatiques **et** production réelle) ;
2. 🧪 implémenté, insuffisamment testé ;
3. 🟠 partiel ;
4. 🐞 présent mais défectueux ;
5. 📄 documenté, non développé ;
6. ⛔ absent.

**Preuves** : U = unitaire, I = intégration avec FFmpeg réel, E = bout en bout dans l'application,
R = production réelle mesurée, H = validation humaine.

## Chemin critique vers le premier montage autonome local (test final : 15 min)
1. **Musique dans la production** (index ✅ → sélection par section, transitions, Remplacer/Verrouiller).
2. **Edit Decision Graph** : décisions identifiées, confiance, dépendances, recalcul partiel.
3. **Recherche des médias par le contenu** (aujourd'hui : noms de fichiers, cases, doublons) → OCR et
   embeddings locaux (modèles à autoriser).
4. **Compréhension du script** au-delà des règles (entités, faits/théories) → LLM local facultatif,
   jamais indispensable.
5. **Test final de 15 min** sur vos ressources réelles, avec validation humaine.

Les points 1 et 2 n'ont pas besoin de modèle. Les points 3 et 4 demandent votre accord pour télécharger
des modèles. Voir `docs/ARCHITECTURE_CIBLE.md`.

## Après la réalisation de l'audit (13/11/2026)
Implémenté et vérifié par des tests automatiques (pas encore sur vos données réelles) : EDG, musique par
section, structure du script, index des médias, OCR facultatif, contrôle éditorial, outils du benchmark.
**Toujours non validé** : pertinence réelle des images (B4), cases sur de vraies pages (B1), recherche
(B2), musique sur vos pistes. Voir `docs/BENCHMARK.md`.

## Matrice

| Module | Fonction | État | Preuve | Reste à faire | Dépend de | Prio |
|---|---|---|---|---|---|---|
| Projets | création, ouverture, sauvegarde atomique, 20 sauvegardes | ✅ | E, R | — | — | — |
| Projets | autosave et récupération après plantage | ✅ | E (arrêt brutal) | reprise des **productions** interrompues (checkpoints) | EDG | P0 |
| Projets | verrouillage multi-instance, migration de schéma | ⛔ | — | verrou de projet, version de schéma | — | P1 |
| Journal | journal JSON, rotation, corrélation, anonymisation | ✅ | U (5), E, CI Windows run 40 | — | — | — |
| Diagnostic | matériel, espace, dépendances, fonctions FFmpeg, problèmes récents | 🧪 | U, I, E | recommandations automatiques de profil | — | P1 |
| FFmpeg | contrôle des capacités (codecs, filtres, formats, nonfree) | 🧪 **nouveau** | I ; auto-test de l'installateur | — | — | P0 |
| FFmpeg | build minimal reproductible | 🟠 **nouveau** | étape 1 compilée en CI (7 min), toutes les sources épinglées ; non-régression : manquent `ass` et `libmp3lame` | étape 2 (libass et sa pile, lame, QSV, AMF), puis comparaison des exports | — | P0 |
| Orchestrateur | tâches, priorités, dépendances, annulation, progression | ✅ | U, E | reprise, checkpoints, retries contrôlés | — | P1 |
| Script | import PDF, TXT, Markdown ; blocs VISUELS, sources | ✅ | U, I, R | **DOCX** ⛔ ; éditeur de chapitres ; contradictions | — | P1 |
| Script | mode sans script (voix → script), type de narration | ✅ | U, I, R | — | — | — |
| Script | structure narrative par section (règles, indices, confiance, intensité) | 🧪 **nouveau** | U (2), I | mesure B3 sur vos scripts ; entités hors dictionnaire (ex. « Stan Lee ») | — | P1 |
| Voix | transcription locale whisper.cpp (sans Python) | ✅ | I, CI réelle, R | — | — | — |
| Voix | alignement script/voix | ✅ | I, R (66 min : 6 ms de médiane) | — | — | — |
| Voix | nettoyage mesuré (bruit, ronflement, de-esseur, compression, loudness) | ✅ | U, I, R | clics, plosives, réverbération | — | P2 |
| Voix | pauses resserrées, prise ratée finale retirée | ✅ | U, I, R | — | — | — |
| Voix | hésitations et répétitions de la transcription | 🧪 | U, I ; 3 transcriptions réelles | **référence annotée** (dossier d'écoute prêt) | votre écoute | P0 |
| Voix | plusieurs prises, comparaison, meilleurs segments | ⛔ | — | — | alignement ✅ | P1 |
| Musique | **index local** : métadonnées, LUFS, énergie, tempo, brillance, voix probable, licences, doublons, corrections, historique | 🧪 **nouveau** | U (8), I (2), E (1) ; tempo exact sur 6 rythmes de test | validation sur **vos** pistes (5 à 10) | vos fichiers | P0 |
| Musique | sélection par section, transitions sur pauses, Remplacer/Verrouiller | 🧪 **nouveau** | U (5), I (bibliothèque indexée réelle → production) | validation sur **vos** pistes ; fondu enchaîné (aujourd'hui fondu sortant puis entrant sur la pause) | index ✅ | P0 |
| Musique | ducking sous la voix, niveau relatif | ✅ | I, R | — | — | — |
| Sound design | whoosh et impacts synthétisés localement, piste SFX | ✅ | I, R | bibliothèque de SFX de l'utilisateur, bus | — | P2 |
| Médias | import, proxies, vignettes, formes d'onde, reliaison | ✅ | E | — | — | — |
| Médias | index persistant partagé (réutilisation, déplacements, modifications, introuvables), recherche texte | 🧪 **nouveau** | I (scan × 4), U (recherche) | index JSON : à mesurer au-delà de 10 000 fichiers (SQLite si nécessaire) | — | P1 |
| Médias | doublons (empreinte perceptuelle et couleur) | ✅ | U, I | — | — | — |
| Comics | formats (couverture, planche, double page, webtoon, manga), cases, CBZ | ✅ | U, I | cases sans bordure | — | P3 |
| Comics | références (série, volume, numéro, année) | ✅ | U, I | — | — | — |
| Comics | OCR local (Tesseract installé par l'utilisateur), zones de texte | 🧪 **nouveau** | U (analyse TSV) ; intégration ignorée ici (Tesseract absent du conteneur) | mesure du CER sur vos pages (B1) ; bulles et personnages : ⛔ (modèle à choisir) | Tesseract | P1 |
| Association | choix par métadonnées (nom, étiquettes, dossier, références), description, OCR ; preuves et confiance ; aucune image sans rapport placée | 🧪 | U, I | **compréhension visuelle** ⛔ (aucun modèle d'image) ; pertinence réelle non mesurée (B4) | embeddings (accord) | P0 |
| EDG | décisions identifiées, candidats, preuves, confiance, dépendances, états, historique ; synchronisé avec la timeline et annuler/rétablir ; régénération partielle | 🧪 **nouveau** | U (9), I (verrou repris à la régénération), E (verrouiller puis annuler) | recalcul ciblé sans régénération complète ; reprise d'une production interrompue | — | P0 |
| Timeline | pistes, couper, trim, ripple, transitions, fondus, aimant, verrouillage, liens, zoom, annuler/rétablir | ✅ | E | — | — | — |
| Timeline | keyframes et courbes, copier/coller, groupement libre | ⛔ | — | `core/keyframes` | — | P1/P2 |
| Motion | Ken Burns, cadrage par case, compositions procédurales, typographie | ✅ | I, E, R | parallaxe, masques, calques, précompositions | keyframes | P2 |
| P-CORE | présence 3D réactive à la voix, 4 niveaux de qualité | ✅ | I, E, R | aperçu temps réel | — | P2 |
| P-CORE V2 | 5 couches, 12 expressions, animation à ressorts, directeur narratif (texte en contexte et voix), présence A/B/C, réactions éditables dans la timeline, 5 préréglages | 🧪 **nouveau** | U (16), E (studio, verrouillage d'une réaction), validation Electron (fidélité IoU 0,97, exports alpha ×4, qualités mesurées en logiciel) | **mesure sur RTX 3050** ; validation sur votre voix réelle ; mouvement continu entre placements (images clés) | votre PC | P1 |
| Formats | 16:9, 9:16, 1:1, 4:5 recomposés | ✅ | I, R | cadrage intelligent (sujet, bulles, visages) | vision | P2 |
| Sous-titres | intégrés, SRT et VTT | ✅ | U, E | piste éditable et styles | — | P2 |
| QA | contrôle de production (synchro, écrans noirs, durée, LUFS, répétitions) | ✅ | U, I, R | séparation bloquant/majeur/facultatif ; rapport à chaque export | — | P1 |
| Export | H.264/H.265, ProRes, alpha, segmenté et reprenable, vérifié | ✅ | I, E, R | NVENC validé sur une vraie machine | votre PC | P2 |
| Apprentissage | préférences et historique de versions | 🟠 | U | portée (global, format, série, projet), décisions acceptées/refusées | EDG | P2 |
| Assistant local | commandes en langage naturel | ⛔ | — | LLM local (accord) → opérations EDG | EDG | P2 |
| IA locale | runtime, gestionnaire de modèles | 🟠 | whisper (catalogue, consentement, SHA) | contrat générique (ONNX, llama.cpp) | — | P1 |
| Interface | française, verre « liquid glass » sombre et clair | 🧪 **nouveau style** | E, captures | catalogue i18n | — | P2 |
| Installateur | NSIS français, installation silencieuse, auto-test, désinstallation | ✅ | CI Windows | mise à jour | — | P4 |
