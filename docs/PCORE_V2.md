# P-CORE V2 — entité numérique en couches, dirigée par la narration

13 novembre 2026. Évolution de P-CORE V1.1. V1.1 reste intact pour les projets existants : un clip
sans `pcore.engine = 'v2'` est rendu exactement comme avant (même scène, même clé de cache).

## 1. Audit de V1.1 (code lu, pas supposé)

| Domaine | État constaté | Verdict |
|---|---|---|
| Analyse audio (`pcore/audio.ts`) | RMS, niveau normalisé sur la voix elle-même, enveloppe, 3 bandes, attaques, silences avec hystérésis, débit | **Solide, réutilisé tel quel** |
| Expressions (`pcore/expression.ts`) | 9 états, chacun une cible fixe ; lissage exponentiel ; seuils adaptés au narrateur | Fonctionnel mais mécanique : pas d'inertie, pas de composition, une table par état |
| Sémantique | expressions régulières phrase par phrase (révélation, question, explication, exclamation) | Ni contexte ni mémoire : chaque révélation fait le même tour, chaque section déclenche une décomposition |
| Scène (`pcore/scene.ts`) | logo extrudé (silhouette officielle tracée, illustration sur la face), fragments, anneaux plats, particules en orbite, halo | Fidèle mais plat : pas de structure interne, anneaux 2D, particules sans organisation |
| Placement (`pcore/placement.ts`) | central, côté ou coin selon V1 ; position fixe ; agrandissement aux révélations | Bon, mais il ignore les titres (défaut visible : titres sur le logo), les zones de texte, les zones protégées ; transitions coupées par un fondu au noir |
| Rendu et export (`main/pcoreRender.ts`, `engine/pcore.ts`) | fenêtre cachée WebGL2, alpha droit, FFmpeg, validation par relecture | **Solide, réutilisé** (V2 ajoute le choix de scène et les mesures) |
| Qualité (`pcore/quality.ts`) | 4 niveaux : échelle de rendu, densité de particules, effort VP9 | Réutilisé, plus des budgets propres à V2 |
| Timeline | clips sur V2, marqueurs « P-CORE: REVEAL » | Réactions non modifiables, sauf par marqueurs |
| Tests | 10 unitaires, 1 intégration (composition alpha), 2 E2E | Réutilisés comme non-régression |

## 2. Architecture V2

```
voix (WAV) ──► audio.ts (V1, inchangé) ─┐
script / transcription alignés ─► v2/narrative.ts (lecture en contexte)
                                        ├─► v2/director.ts ─► réactions (PCoreCue[]) ─► production.pcore (projet)
modifications de l'utilisateur ─────────┘          │                                   │
                                                    ▼                                   ▼
                                    v2/animation.ts (ressorts, composition) ─► sceneV2.ts (5 couches) ─► rendu alpha
timeline (V1, titres, OCR, zones) ─► placement.ts (présence A/B/C) ─► clips sur V2 et V3, en fondu enchaîné
```

| Module | Rôle |
|---|---|
| `src/pcore/v2/config.ts` | 5 couches (noyau, structure interne, système orbital, champ d'énergie, atmosphère), réglages Identité, Animation et Narration, **5 préréglages** qui changent réellement le moteur, budgets par niveau de qualité |
| `src/pcore/v2/expressions.ts` | **12 expressions** : veille, éveil, noyau actif, concentration, expansion d'énergie, mouvement orbital, fragmentation, reconstruction, révélation, transition cinématique, silence, stabilisation finale. Chacune a une pose fonction de sa progression, de son intensité et de sa variante, ses durées, ses enveloppes d'entrée et de sortie, sa priorité, ses conditions et son coût |
| `src/pcore/v2/narrative.ts` | Lecture d'une phrase en contexte : position, phrases voisines, connecteurs en tête, forme (question, exclamation, phrase courte après une longue), marqueurs pondérés. Catégories : introduction, présentation, contexte, explication, analyse, question, opposition, montée, révélation, conclusion |
| `src/pcore/v2/director.ts` | Directeur d'évolution. Il fusionne voix et texte (le texte est facultatif). Sa mémoire : seuils distincts pour les expressions discrètes et spectaculaires, espacement des moments forts arbitré par importance (le plus important garde sa place), variantes en rotation, densité plafonnée, fusion des répétitions. Les modifications de l'utilisateur (verrou, désactivation, durée, intensité, expression) sont prioritaires. Journal des choix |
| `src/pcore/v2/animation.ts` | Moteur d'animation : base continue (veille ↔ actif) ; expressions composées par priorité ; réactions vocales mesurables ; micro-mouvements déterministes ; ressorts amortis critiques (inertie) ; tours intégrés ; ondes d'énergie |
| `src/pcore/sceneV2.ts` | Scène en 5 couches indépendantes, une matière par couche ; silhouette officielle conservée |
| `src/pcore/placement.ts` (étendu) | Présence : centrale, d'accompagnement, **cinématique** (retour bref au premier plan sur une révélation forte). Évite les titres et les noms à l'écran (positions réelles), les zones OCR, les zones protégées ; respecte la position verrouillée |
| `src/production/builder.ts` (étendu) | Clips V2 porteurs de leurs réactions et réglages (rendu déterministe) ; placements successifs en **fondu enchaîné sur deux pistes** (V2 et V3) |
| `src/engine/production.ts`, `src/engine/pcore.ts` | Planification sur toute la narration (voix à 4 kHz, 10 images/s) ; images d'un clip avec préchauffage des ressorts |
| `src/main/pcoreRender.ts` | Choix de scène V1/V2 par clip, cache V2, mesures du rendu (temps, images/s, processeur et mémoire de la fenêtre de rendu et du processus GPU, GPU actif). Aperçu, export et analyse du studio en V2 |
| `src/renderer/components/PCoreV2.tsx` | Studio (moteur, préréglages, onglets Identité, Animation, Narration, Présence, Expressions, Performance) et direction P-CORE dans le rapport |
| `scripts/pcore/v2-validate.ts`, `v2-demo.ts` | Validation mesurée et démonstration par le vrai pipeline (Electron) |

## 3. Données réellement utilisées pour la présence
Prises en compte :
- bande des sous-titres ;
- titres de section et noms à l'écran, avec leurs positions de rendu réelles ;
- cases détectées ;
- zones de texte lues par l'OCR (si activé) ;
- zones protégées dessinées par vous ;
- position verrouillée.

**Non détectés** : les visages et les bulles en tant que telles, faute de modèle de vision. Protégez ces
zones à la main.

## 4. Mesures (`npm run pcore:validate`, 13/11/2026)

Les mesures ont été faites ici en **rendu logiciel (SwiftShader, 4 vCPU, aucun GPU)**. Elles ne sont pas
représentatives d'une RTX 3050.

| Contrôle | Résultat |
|---|---|
| Fidélité du logo (noyau seul, au repos, comparé à la silhouette officielle) | IoU **0,967** ; proportions 0,812 rendues contre 0,809 officielles |
| Indépendance des couches (différence de luminance moyenne quand la couche est ajoutée seule au noyau, 0–255) | orbitale 1,89 · atmosphère 0,47 · structure interne 0,28 · **énergie 0,11 (très discrète)** |
| Préréglages (différence de luminance moyenne au même instant) | 10,5 à 23,8 entre chaque paire : les 5 sont distincts |
| Scintillement au repos (différence image à image) | moyenne 0,14, maximum 0,17 niveau par pixel |
| Pas maximal par image (séquence des 12 expressions) | lueur 0,05 · échelle 0,007 · fragmentation 0,14 · rotation 0,10 rad |
| Réaction à la voix (corrélation enveloppe et lueur du noyau, 20 s) | **0,69** |
| Exports alpha | WebM VP9 ✓ · ProRes 4444 (yuva444p12le) ✓ · QuickTime Animation (argb) ✓ · PNG (rgba) ✓, alpha 0–255 |

Rendu de 90 images en 1080×1080 (avec une révélation), logiciel :

| Qualité | Temps | Images/s | Mémoire de la fenêtre de rendu | Mémoire du processus GPU | Processeur du processus GPU |
|---|---|---|---|---|---|
| Aperçu | 5,1 s | 17,6 | 203 Mo | 149 Mo | 41 % |
| Standard | 16,0 s | 5,6 | 255 Mo | 197 Mo | 40 % |
| Haute qualité | 31,1 s | 2,9 | 262 Mo | 262 Mo | 40 % |
| Rendu final | 47,9 s | 1,9 | 292 Mo | 359 Mo | 48 % |

Mémoire vidéo : non mesurable (non exposée par Chromium).

**Démonstration** : production complète Script → Vidéo d'une narration de test de 42 s (voix de synthèse
espeak-ng, avec une veille, une introduction, une explication, une montée, une révélation et une
conclusion), en 16:9 et en 9:16. Résultat : 19 réactions, 10 clips P-CORE, contrôle 100/100, environ
5 min par format en rendu logiciel. Choix du directeur :
- veille, puis éveil ;
- transition de partie, puis concentration sur les explications (« parce que », « pour comprendre ») ;
- « mais ce n'est pas tout » joué en mouvement orbital, parce que la révélation suit de près ;
- **révélation à 29,8 s** (« en réalité »), avec un tour complet ;
- stabilisation finale.

**Non validé sur une vraie voix** : la synchronisation a été mesurée sur une voix de synthèse et sur des
signaux de test. La voix réelle du créateur (`annotation/`, extraits courts) n'a pas servi de
validation complète.

## 5. Tester sur votre PC (Windows, RTX 3050)
1. `npm ci` puis `npm run pcore:validate -- "C:\chemin\narration.wav" "C:\chemin\sortie"` : rapport JSON,
   planches des préréglages, des couches et des expressions, temps de rendu par qualité **sur votre
   GPU**.
2. `npm run pcore:demo -- narration.wav script.md sortie --format 16:9 --preset cinematic` : vidéo complète.
3. Dans l'application : Script → Vidéo avec P-CORE, puis le rapport (section « Direction de P-CORE ») et
   P-CORE Studio, onglet Performance après un aperçu.

## 6. Limites connues
- La lecture du texte se fait par règles explicables, sans modèle de langue. Les tournures inhabituelles
  restent « narration ».
- Pas de détection d'émotion dans la voix : le volume module l'amplitude, jamais le choix d'expression.
- Les transitions de placement sont des fondus enchaînés entre deux positions, pas un déplacement
  continu : la timeline n'a pas d'images clés.
- La continuité des phases (rotation des anneaux) entre deux clips successifs n'est pas exacte. Elle est
  masquée par le fondu enchaîné.
- La mémoire vidéo n'est pas mesurable : Chromium ne l'expose pas.
- La performance GPU n'est pas mesurée : aucun GPU n'est disponible dans l'environnement de
  développement.
