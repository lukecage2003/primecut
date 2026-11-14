# Reprise de session

Branche : `claude/gallant-hawking-c8govj`. Avant tout : `npm ci && npm test` (tests unitaires et d’intégration ; 2 ignorés ici : OCR réel sans Tesseract, transcription whisper.cpp sans modèle),
`npm run test:e2e` sous xvfb, puis vérifier le dernier run CI.

## Fait dans la dernière session (réalisation de l'audit)
- EDG (`src/core/edg.ts`) : décisions persistées dans `production.edg`, schéma 4 et migration.
  Synchronisé avec la timeline (`reconcileGraph` dans `edit()`), annuler et rétablir, régénération qui
  reprend verrous et rejets, interface `Decisions.tsx` et badges de la timeline.
- Correspondances honnêtes (`planner.ts`) : preuves par origine, plafond de confiance pour les
  métadonnées, aucune image sans rapport placée (`fillUnrelated`, désactivée par défaut).
- Musique par section (`musicPlan.ts`, `narrative.ts`), index persistant des médias (`mediaIndex.ts`),
  OCR Tesseract facultatif (`ocr.ts`), confiance du découpage des cases, contrôle éditorial `reviewQc`.
- Benchmark réel : `docs/BENCHMARK.md`, `npm run bench`, `scripts/bench/annotate.html`.
  Aucun résultat : données réelles absentes.
- Correctif du glisser-déposer de fichiers dans la médiathèque (`'Files'`).

## P-CORE V2 (dernière mission)
Code : `src/pcore/v2/*`, `src/pcore/sceneV2.ts`, placement étendu, `PCoreV2.tsx`. Documentation et mesures :
`docs/PCORE_V2.md`. À faire sur votre PC : `npm run pcore:validate` (mesures GPU), puis une production
avec votre vraie voix.

## Prochain lot, dans l'ordre
1. **Vos données** : 20 à 50 pages annotées (B1), 20 à 50 requêtes (B2), un projet réel noté plan par
   plan (B4), 5 à 10 pistes musicales. Puis lancer `npm run bench` (v0, sans OCR), puis avec OCR.
2. Selon B1 et B4 : choix d'un modèle d'embedding image-texte local (licence et taille à présenter avant
   tout téléchargement) pour la recherche par description.
3. FFmpeg minimal, étape 2 (libass, lame…), inchangé depuis la session précédente.
4. EDG : recalcul ciblé d'une décision sans régénérer la version ; reprise d'une production interrompue.
5. Musique : vrai fondu enchaîné entre deux pistes (deux pistes audio alternées).

## En attente de votre décision
- Modèles pour la compréhension visuelle (OCR, embeddings) et, en option, un LLM local : liste et licences
  dans `docs/ARCHITECTURE_CIBLE.md` §3.3 ; rien n'est téléchargé sans accord.
- Publication d'une release FFmpeg (après l'étape 2 et la non-régression).
