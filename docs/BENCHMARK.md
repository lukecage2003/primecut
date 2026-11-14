# Benchmark réel — protocole, formats et outils

13 novembre 2026. Ce protocole remplace, pour toute mesure de **pertinence**, les campagnes
`scripts/eval/campaign.ts --media rich|sparse`. Les bibliothèques de ces campagnes sont des images
synthétiques **nommées d'après le script**. Leur « pertinence » est donc circulaire : elle mesure la
correspondance de noms avec des noms dérivés du même texte. Elles restent utiles pour la robustesse
technique (durée, synchronisation, export), jamais pour la pertinence.

> **État : aucun résultat n'a encore été mesuré.** Il manque les jeux de données réels annotés par
> vous (B1 à B4). Rien n'est publié tant qu'ils n'existent pas. Les tests automatiques de l'outil
> utilisent de petites données synthétiques qui vérifient le code, pas la qualité du produit.

## Jeux de données (privés, hors dépôt)

| Jeu | Contenu | Format | Outil d'annotation |
|---|---|---|---|
| B1 Pages | ~50 pages réelles : planches, doubles pages, couvertures, manga, webtoon | `primestone-bench/pages@1` | `scripts/bench/annotate.html`, onglet B1 |
| B2 Recherche | ~50 requêtes en français et les fichiers pertinents de votre bibliothèque | `primestone-bench/queries@1` | éditeur de texte (exemple ci-dessous) |
| B3 Script | 3 scripts réels, annotés par section : fonction, intensité de 1 à 5, entités | `primestone-bench/script@1` | éditeur de texte |
| B4 Production | 1 projet de 10 à 15 min ; chaque plan noté de 1 à 5, « trompeuse » oui/non | `primestone-bench/judgements@1` | `npm run bench -- template` puis `annotate.html`, onglet B4 |
| B5 Voix | dossier d'écoute des hésitations (déjà prêt) | voir `docs/ETUDE_HESITATIONS.md` | `scripts/eval/hesitation-*.ts` |

Les médias ne quittent jamais votre ordinateur. Seuls les scores peuvent être versionnés, dans
`docs/benchmark/`, avec l'option `--out docs/benchmark`.

### Exemples de fichiers

```json
{ "format": "primestone-bench/queries@1", "annotator": "MA",
  "queries": [ { "query": "Thanos utilise le Gant de l'Infini", "relevant": ["Infinity Gauntlet/p12.jpg", "Thanos/gant-02.png"] } ] }
```

```json
{ "format": "primestone-bench/script@1", "annotator": "MA", "script": "spiderman.md",
  "sections": [ { "title": "Les origines", "fn": "contexte", "intensity": 2, "entities": ["Spider-Man", "Stan Lee"] } ] }
```

Fonctions narratives reconnues : `accroche`, `contexte`, `explication`, `révélation`, `liste`,
`conclusion`, `transition`.

## Commandes

```bash
npm run bench -- pages  pages.json  "D:/Comics/Pages annotées" --out docs/benchmark
npm run bench -- pages  pages.json  "D:/Comics/Pages annotées" --ocr fra+eng
npm run bench -- search queries.json "D:/Comics/Bibliothèque" --out docs/benchmark
npm run bench -- script spiderman.json
npm run bench -- template "D:/Projets/Spider-Man/Spider-Man.psproj" > judgements.json
npm run bench -- shots  judgements.json --out docs/benchmark
```

`--ocr` exige Tesseract installé par vous ; il n'est jamais téléchargé automatiquement.

## Métriques

| Jeu | Mesure | Définition |
|---|---|---|
| B1 | précision et rappel des cases | appariement un à un, IoU ≥ 0,5 |
| B1 | IoU moyenne, pages au critère | critère de la matrice : ≥ 85 % des cases à IoU ≥ 0,8 |
| B1 | ordre de lecture | τ de Kendall sur les cases appariées |
| B1 | calibration | parmi les pages à confiance ≥ 0,7, combien sont réellement correctes |
| B1 | OCR | taux d'erreur caractères (CER) sur le texte annoté |
| B2 | rappel@10, nDCG@10 | sur les fichiers jugés pertinents |
| B3 | fonction narrative | exactitude et κ de Cohen |
| B3 | intensité | ρ de Spearman avec vos notes de 1 à 5 |
| B3 | entités | rappel et précision |
| B4 | pertinence | note moyenne ; part des plans notés ≥ 4 ; nombre d'images trompeuses |
| B4 | origine des correspondances | note des plans choisis sur les seuls noms, comparée à celle des plans fondés sur une description, l'OCR ou votre choix |
| B4 | calibration | note moyenne par tranche de confiance (< 0,3, 0,3–0,6, ≥ 0,6) |

Seuils proposés par l'audit, à valider avec vous :
- pertinence ≥ 4/5 sur 80 % des plans ;
- aucune image trompeuse ;
- jugement global « retouches mineures » au plus.

## Déroulé

1. **v0** : mesurer l'état actuel sur B1 à B4, sans OCR. On attend une pertinence faible avec des noms
   de fichiers génériques : c'est la référence honnête.
2. Avec descriptions et OCR (si Tesseract est installé) : relancer B2 et B4 pour mesurer l'apport.
3. Après chaque chantier : relancer les mesures automatiques. Faire un jugement humain à chaque jalon.
