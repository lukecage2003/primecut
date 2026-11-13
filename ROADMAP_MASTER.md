# Matrice de finalisation — Primestone Motion Studio

Mise à jour : 13 novembre 2026, v0.7.x. **Document unique de suivi** (il remplace l'ancienne matrice ;
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

## Matrice

| Module | Fonction | État | Preuve | Reste à faire | Dépend de | Prio |
|---|---|---|---|---|---|---|
| Projets | création, ouverture, sauvegarde atomique, 20 sauvegardes | ✅ | E, R | — | — | — |
| Projets | autosave et récupération après plantage | ✅ | E (arrêt brutal) | reprise des **productions** interrompues (checkpoints) | EDG | P0 |
| Projets | verrouillage multi-instance, migration de schéma | ⛔ | — | verrou de projet, version de schéma | — | P1 |
| Journal | journal JSON, rotation, corrélation, anonymisation | ✅ | U (5), E, CI Windows run 40 | — | — | — |
| Diagnostic | matériel, espace, dépendances, fonctions FFmpeg, problèmes récents | 🧪 | U, I, E | recommandations automatiques de profil | — | P1 |
| FFmpeg | contrôle des capacités (codecs, filtres, formats, nonfree) | 🧪 **nouveau** | I ; auto-test de l'installateur | — | — | P0 |
| FFmpeg | build minimal reproductible | 🟠 **nouveau** | script et workflow séparés (étape 1) | 1er passage CI, épinglage des empreintes, étape 2 (libass, QSV, AMF), comparaison des exports | — | P0 |
| Orchestrateur | tâches, priorités, dépendances, annulation, progression | ✅ | U, E | reprise, checkpoints, retries contrôlés | — | P1 |
| Script | import PDF, TXT, Markdown ; blocs VISUELS, sources | ✅ | U, I, R | **DOCX** ⛔ ; éditeur de chapitres ; contradictions | — | P1 |
| Script | mode sans script (voix → script), type de narration | ✅ | U, I, R | — | — | — |
| Voix | transcription locale whisper.cpp (sans Python) | ✅ | I, CI réelle, R | — | — | — |
| Voix | alignement script/voix | ✅ | I, R (66 min : 6 ms de médiane) | — | — | — |
| Voix | nettoyage mesuré (bruit, ronflement, de-esseur, compression, loudness) | ✅ | U, I, R | clics, plosives, réverbération | — | P2 |
| Voix | pauses resserrées, prise ratée finale retirée | ✅ | U, I, R | — | — | — |
| Voix | hésitations et répétitions de la transcription | 🧪 | U, I ; 3 transcriptions réelles | **référence annotée** (dossier d'écoute prêt) | votre écoute | P0 |
| Voix | plusieurs prises, comparaison, meilleurs segments | ⛔ | — | — | alignement ✅ | P1 |
| Musique | **index local** : métadonnées, LUFS, énergie, tempo, brillance, voix probable, licences, doublons, corrections, historique | 🧪 **nouveau** | U (8), I (2), E (1) ; tempo exact sur 6 rythmes de test | validation sur **vos** pistes (5 à 10) | vos fichiers | P0 |
| Musique | sélection par section, transitions sur pauses, Remplacer/Verrouiller | 📄 | conception validée | développement | index ✅ | **P0** |
| Musique | ducking sous la voix, niveau relatif | ✅ | I, R | — | — | — |
| Sound design | whoosh et impacts synthétisés localement, piste SFX | ✅ | I, R | bibliothèque de SFX de l'utilisateur, bus | — | P2 |
| Médias | import, proxies, vignettes, formes d'onde, reliaison | ✅ | E | base SQLite et FTS pour les grandes bibliothèques | — | P2 |
| Médias | doublons (empreinte perceptuelle et couleur) | ✅ | U, I | — | — | — |
| Comics | formats (couverture, planche, double page, webtoon, manga), cases, CBZ | ✅ | U, I | cases sans bordure | — | P3 |
| Comics | références (série, volume, numéro, année) | ✅ | U, I | — | — | — |
| Comics | bulles, OCR, traduction, personnages | ⛔ | — | modèles ONNX et Tesseract (accord) | gestionnaire de modèles | P3 |
| Association | choix d'image par mots-clés, entités, références, diversité, répétition | ✅ | U, I, R | **compréhension du contenu de l'image** | OCR et embeddings | P1 |
| EDG | décisions de montage identifiées, confiance, dépendances | ⛔ | raisons par plan seulement | `core/edg` | — | **P1** |
| Timeline | pistes, couper, trim, ripple, transitions, fondus, aimant, verrouillage, liens, zoom, annuler/rétablir | ✅ | E | — | — | — |
| Timeline | keyframes et courbes, copier/coller, groupement libre | ⛔ | — | `core/keyframes` | — | P1/P2 |
| Motion | Ken Burns, cadrage par case, compositions procédurales, typographie | ✅ | I, E, R | parallaxe, masques, calques, précompositions | keyframes | P2 |
| P-CORE | présence 3D réactive à la voix, 4 niveaux de qualité | ✅ | I, E, R | aperçu temps réel | — | P2 |
| Formats | 16:9, 9:16, 1:1, 4:5 recomposés | ✅ | I, R | cadrage intelligent (sujet, bulles, visages) | vision | P2 |
| Sous-titres | intégrés, SRT et VTT | ✅ | U, E | piste éditable et styles | — | P2 |
| QA | contrôle de production (synchro, écrans noirs, durée, LUFS, répétitions) | ✅ | U, I, R | séparation bloquant/majeur/facultatif ; rapport à chaque export | — | P1 |
| Export | H.264/H.265, ProRes, alpha, segmenté et reprenable, vérifié | ✅ | I, E, R | NVENC validé sur une vraie machine | votre PC | P2 |
| Apprentissage | préférences et historique de versions | 🟠 | U | portée (global, format, série, projet), décisions acceptées/refusées | EDG | P2 |
| Assistant local | commandes en langage naturel | ⛔ | — | LLM local (accord) → opérations EDG | EDG | P2 |
| IA locale | runtime, gestionnaire de modèles | 🟠 | whisper (catalogue, consentement, SHA) | contrat générique (ONNX, llama.cpp) | — | P1 |
| Interface | française, verre « liquid glass » sombre et clair | 🧪 **nouveau style** | E, captures | catalogue i18n | — | P2 |
| Installateur | NSIS français, installation silencieuse, auto-test, désinstallation | ✅ | CI Windows | mise à jour | — | P4 |
