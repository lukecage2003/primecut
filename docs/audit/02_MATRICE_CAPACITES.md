# Matrice globale des capacités et des lacunes (audit du 13/11/2026)

## Légende
**Niveaux** :
- N0 : absent ;
- N1 : fondations ;
- N2 : implémenté ;
- N3 : opérationnel ;
- N4 : robuste ;
- N5 : professionnel.

« non vérifiée » : la capacité n'a pas pu être évaluée faute de données réelles.

**Types** :
- D : déterministe (règles, signal) ;
- IA : modèle local ;
- H : humain ;
- Hyb : hybride.

**Priorités** :
- P0 : intelligence et montage autonome ;
- P1 : production professionnelle robuste ;
- P2 : amélioration importante ;
- P3 : confort.

**Effort** :
- S : quelques jours ;
- M : 1 à 2 semaines ;
- L : 3 à 6 semaines ;
- XL : plus de 6 semaines.

Ce sont des ordres de grandeur, argumentés, pour un développeur assisté.

Les lignes sont regroupées **par chantier**, pour éviter les doublons.

## Chantier 1 — Perception visuelle (Comic et Visual Intelligence)
| Fonction | État | Preuve | Type | Limite | Dépendances | Prio | Effort | Critère de réussite |
|---|---|---|---|---|---|---|---|---|
| Segmentation des cases | N2 | `core/panels.ts`, `tests/unit/panels.test.ts` (synthétique) | D | gouttières claires seulement ; jamais testée sur de vraies pages | jeu de pages annotées | P0 | M (mesure, puis modèle de détection si nécessaire) | IoU ≥ 0,8 sur ≥ 85 % des cases de 50 pages réelles annotées |
| Format de page et ordre de lecture | N2 | `core/comicFormat.ts`, `comicFormat.test.ts` | D | règles de proportions et de nom ; manga deviné | segmentation | P1 | S | ≥ 90 % de formats corrects et ≥ 90 % d'ordres de lecture corrects sur le jeu annoté |
| Bulles et OCR | N0 | — | IA | absent | modèle détecteur et OCR (accord) | P0 | L | rappel des bulles ≥ 85 % ; taux d'erreur caractères de l'OCR ≤ 10 % sur le lettrage du jeu annoté |
| Type de texte (dialogue, narration, bruitage, pensée) | N0 | — | IA ou Hyb | absent | OCR | P2 | M | ≥ 80 % de types corrects |
| Description sémantique d'une case | N0 | — | IA (VLM) | absent | modèle vision-langage (accord) | P1 | L | jugement humain « description fidèle » ≥ 80 %, aucune invention de personnage nommé |
| Reconnaissance des personnages | N0 | — | Hyb (embeddings et galerie de référence fournie par l'utilisateur) | absent ; aucun modèle grand public ne connaît les personnages Marvel ou DC de façon fiable | embeddings, galerie | P1 | L | précision ≥ 90 % quand la confiance est ≥ seuil ; sinon « incertain » affiché |
| Recherche visuelle par description | N0 | — (recherche par nom) | IA (embeddings image-texte) et OCR | absent | embeddings, index | **P0** | M | rappel@10 ≥ 70 % sur 50 requêtes réelles (« Thanos et le Gant ») |
| Continuité visuelle entre cases | N0 | — | IA | absent | description de case | P3 | XL | — |
| Doublons | N3 | `core/phash.ts`, tests U et I | D | variantes recadrées non regroupées | — | P2 | S | ≥ 95 % des doublons retrouvés sur un jeu réel |
| PDF de comics, pages multiples | N0 | pdf.js réservé aux scripts | D | absent | — | P2 | S | pages extraites dans l'ordre, sans perte |

## Chantier 2 — Compréhension du script (Narrative Intelligence)
| Fonction | État | Preuve | Type | Limite | Dépendances | Prio | Effort | Critère |
|---|---|---|---|---|---|---|---|---|
| Import PDF, TXT, MD et blocs du script | N3 | `scriptImport.ts`, tests et scripts réels | D | DOCX absent | — | P2 | S | DOCX importé à l'identique |
| Entités (personnages, lieux…) | N2 | `entities.ts`, 52 entrées | D | dictionnaire minuscule, pas de coréférence | base enrichie, LLM facultatif | P0 | M | rappel ≥ 90 % des entités annotées dans 5 scripts réels |
| Structure narrative et fonction des paragraphes | N0 | — | IA (LLM local) et D | absent | LLM (accord) | **P0** | L | accord humain ≥ 75 % sur la fonction (hook, contexte, explication, révélation, conclusion) |
| Faits, interprétations, théories | N0 | — | IA | absent | LLM | P1 | M | ≥ 80 % sur un jeu annoté |
| Émotion et intensité | N1 | `pacing.ts` (« ! », mots, débit) | D | superficiel | LLM et prosodie | P1 | M | corrélation ≥ 0,6 avec l'annotation humaine d'intensité |
| Type de vidéo | N2 | `narrationFormat.ts` (regex) | D | 7 types ; ne change que le rythme et les cartes | analyse narrative | P1 | M | ≥ 85 % de types corrects sur 20 scripts ; le type modifie la stratégie de sélection |
| Contradictions, répétitions | N0 | — | IA | absent | LLM | P3 | M | — |

## Chantier 3 — Décision éditoriale et EDG (Editing et Cinematic Intelligence)
| Fonction | État | Preuve | Type | Limite | Dépendances | Prio | Effort | Critère |
|---|---|---|---|---|---|---|---|---|
| Source de vérité des décisions (EDG) | N0 | décisions dispersées : `ProductionMeta.shots[].reasons`, clips | D | pas d'identifiant, de confiance, de dépendance ni de verrou | — | **P0** | L | régénération partielle : 1 phrase modifiée ne change que ses plans ; plan verrouillé conservé |
| Score image ↔ passage | N2 | `planner.scoreItem` (nom, balises, dossier) | D | aveugle au contenu | chantiers 1 et 2 | **P0** | M (une fois la perception disponible) | ≥ 80 % de plans jugés pertinents par un humain sur le benchmark |
| Confiance et autonomie adaptative | N1 | `quality: strong, weak, missing` | D | pas de seuils ni de validation | EDG | P0 | M | décisions sous le seuil présentées pour validation ; aucune image trompeuse sous le seuil |
| Durée des plans, rythme | N2 | `builder`, `pacing`, préréglages | D | règles fixes | analyse narrative | P1 | M | ≥ 70 % des plans jugés de durée appropriée ; aucun plan < 1,5 s ni > 12 s sans raison |
| Cadrage, plan large ou gros plan | N1 | `pickMotion` (tirage pondéré), lecture de cases | D | aléatoire ; ignore visages et bulles | perception | P1 | M | aucune bulle ni aucun visage coupé (contrôle automatique) ; jugement ≥ 75 % « cadrage juste » |
| Plusieurs images, comparaison, split | N0 | — | D | absent | EDG | P2 | M | — |
| Transitions contextuelles | N1 | fondus de section | D | préréglage | analyse narrative | P2 | S | — |
| 2.5D, parallaxe, masques, détourage | N0 | — | IA (segmentation) et D | absent ; segmentation non générative | modèle de segmentation (accord) | P2 | XL | — |

## Chantier 4 — Audio et musique
| Fonction | État | Preuve | Type | Limite | Dépendances | Prio | Effort | Critère |
|---|---|---|---|---|---|---|---|---|
| ASR et alignement | N4 | I, R (66 min) | IA et D | — | — | — | — | — |
| Nettoyage, loudness, true peak | N4 | `voice.ts`, `voiceChain.ts`, R | D | clics, plosives, réverbération absents | — | P2 | M | — |
| Hésitations | N2 | `disfluency.ts`, U et I | D | dépend de Whisper ; référence en attente | annotations | P1 | S (après référence) | précision ≥ 0,8 ; ≤ 0,2 fausse alarme/min |
| Plusieurs prises | N0 | — | D et IA | absent | alignement | P2 | L | — |
| Index musical | N2 | `musicLibrary.ts`, U, I, E | D | règles validées sur du synthétique | vos pistes | P1 | S | ≥ 80 % d'accord avec vos étiquettes d'énergie et d'ambiance |
| Musique par section, transitions, verrouillage | N1 | une piste bouclée (`builder`) | D | non relié | index, EDG | **P0** | M | changement aux frontières de section, sur une pause ; verrouillage respecté |
| SFX | N2 | `sfx.ts` | D | sons synthétisés seulement | — | P2 | M | — |

## Chantier 5 — Contrôle qualité et benchmark
| Fonction | État | Preuve | Type | Limite | Dépendances | Prio | Effort | Critère |
|---|---|---|---|---|---|---|---|---|
| QC technique | N3 | `qc.ts`, export vérifié | D | pas de texte coupé, de rupture sonore ni de recadrage fautif | perception | P1 | M | détection ≥ 90 % des défauts injectés |
| QC éditorial | N1 | correspondance faible ou manquante, répétition | D | proxies | EDG et perception | P0 | M | — |
| Benchmark avec jugement humain | N0 | campagnes circulaires (images nommées depuis le script) | H et D | aucune mesure réelle de pertinence | jeux de données | **P0** | M | protocole exécuté, scores publiés |

## Chantier 6 — Données, performance, plateforme
| Fonction | État | Preuve | Type | Limite | Dépendances | Prio | Effort | Critère |
|---|---|---|---|---|---|---|---|---|
| Runtime de modèles locaux | N1 | `models.ts` (Whisper seulement) | D | aucun ONNX ou GGUF | accord | **P0** | M | 1 modèle d'embedding chargé, mesuré et déchargé, avec repli |
| Index des médias persistant (SQLite et FTS) | N0 | rescan à chaque production | D | lent sur les grandes bibliothèques | — | P1 | M | 10 000 images indexées une fois, puis mises à jour incrémentales en moins de 10 s |
| Productions longues (15/30/60/90 min) | N3 (66 min, une fois) | campagne documentaire | D | 15, 30 et 90 non mesurés ; pas de reprise de production | EDG | P1 | M | 90 min sans erreur ; reprise après interruption sans tout refaire |
| Projets, autosave, récupération | N4 | E2E arrêt brutal | D | verrou multi-instance absent | — | P2 | S | — |
| Assistant local | N0 | — | IA | absent | LLM, EDG | P2 | L | ≥ 90 % des commandes du jeu de test converties en opérations EDG correctes |
| Apprentissage par décision | N1 | `adaptPreferences` (global) | D | pas de portée ni de décision | EDG | P2 | M | une correction de projet ne modifie pas le global sans confirmation |
