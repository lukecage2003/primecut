# Reprise de session

Branche : `claude/gallant-hawking-c8govj`. Avant tout : `npm ci && npm test` (138 tests + 1 ignoré),
`npm run test:e2e` sous xvfb, puis vérifier le dernier run CI.

## Fait dans la dernière session (MASTER EXECUTION V2)
- P0 6.1 journal technique (`src/engine/log.ts`, `src/engine/deps.ts`, Réglages, diagnostic).
- Correctif CI Windows (test CBZ), runs 33–35 documentés.
- P1 hésitations et répétitions : mesure sur 3 transcriptions réelles. Sur la première version :
  2 + 11 + 3 fausses alarmes (fins de phrase, listes, « oh lala lala »). Après correction : 0 + 1 + 0 ;
  le seul cas restant, « de de », est plausible. Whisper n'a écrit aucun « euh ».

## Prochain lot, dans l'ordre (voir ROADMAP_MASTER.md, chemin critique)
1. FFmpeg minimal : lire le 1er passage du workflow « FFmpeg minimal », épingler les empreintes
   relevées (RECORDED.json), puis étape 2 (libass et sa pile, AMF, libvpl) jusqu'à 0 capacité manquante.
   Ensuite : comparaison des exports avec le binaire BtbN.
2. Musique dans la production : cible par section, score, transitions sur pauses, Remplacer/Verrouiller
   (`docs/CONCEPTION_MUSIQUE.md` §3 à 6).
3. EDG (`docs/ARCHITECTURE_CIBLE.md` §3.1) : à présenter avant de le coder (modification architecturale).
4. Dès réception : vos pistes musicales (validation réelle) et vos annotations (`annotation/…/annotate.html`,
   puis `npx tsx scripts/eval/hesitation-score.ts annotation/narration-spidey`).

## En attente de votre décision
- Modèles pour la compréhension visuelle (OCR, embeddings) et, en option, un LLM local : liste et licences
  dans `docs/ARCHITECTURE_CIBLE.md` §3.3 ; rien n'est téléchargé sans accord.
- Publication d'une release FFmpeg (après l'étape 2 et la non-régression).
