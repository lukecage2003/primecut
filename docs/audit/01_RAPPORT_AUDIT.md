# Audit global — intelligence réelle de Primestone Motion Studio

13 novembre 2026. Commit audité : `40ee644`, branche `claude/gallant-hawking-c8govj`.
**Audit uniquement** : aucune modification du code, aucun commit, aucun téléchargement.

Méthode :
- lecture des implémentations, pas des noms ni de la documentation ;
- exécution de la suite de tests existante ;
- relecture des rapports de campagnes réelles déjà produits (dossier de travail, lecture seule).

Les **niveaux** vont de N0 (absent) à N5 (niveau professionnel) ; la **confiance** est indiquée pour chaque niveau.

---

## A. Diagnostic exécutif

### Réponse à la question centrale
**Non.** Aujourd'hui, Primestone ne comprend ni un scénario, ni une page de comics, ni le contenu d'une
image. C'est un **pipeline de production déterministe, bien construit et robuste techniquement**, qui
assemble une vidéo à partir de **règles explicites, de correspondances de noms et de mesures du
signal**. Il produit une vidéo complète, synchronisée, mixée, sous-titrée et vérifiée. Mais la qualité
éditoriale du résultat dépend presque entièrement **de la façon dont l'utilisateur a nommé ses fichiers**.

### Ce qui est réellement solide (prouvé)
- **Voix** :
  - transcription locale (whisper.cpp intégré, sans Python) ;
  - alignement mot à mot (66 min de documentaire : 6 ms d'écart médian, 94,5 % des phrases à moins de 250 ms) ;
  - nettoyage piloté par mesures, loudness, true peak ;
  - prise ratée finale retirée sur votre vraie narration.
- **Rendu** :
  - export segmenté et reprenable, vérifié (durée, LUFS, écrans noirs) ;
  - aucun écran noir, prouvé sur 66 min ;
  - P-CORE avec transparence.
- **Robustesse logicielle** :
  - orchestrateur de tâches ;
  - sauvegarde atomique et récupération après plantage (testée par arrêt brutal) ;
  - journal anonymisé ;
  - installateur Windows testé en CI.
- **Hygiène** :
  - fonctionnement 100 % local ;
  - aucune dépendance à Claude, à Anthropic ni à une API (vérifié par recherche dans le code) ;
  - licences tenues à jour ;
  - aucune génération d'image.

### Ce qui n'existe pas (et qui constitue le cœur de l'ambition)
1. **Compréhension du contenu des images** : aucune vision, aucun OCR, aucun embedding. Une page est
   pour le logiciel un rectangle avec des gouttières blanches et un nom de fichier.
2. **Reconnaissance des personnages** : aucune. Un « personnage reconnu » signifie que **son nom figure
   dans le nom du fichier** ou dans le texte du script.
3. **Compréhension narrative** :
   - les entités sont trouvées par dictionnaire (52 entrées intégrées, dont 34 personnages, plus les
     noms propres du script) ;
   - le type de vidéo est deviné par expressions régulières ;
   - l'« intensité » est calculée à partir des points d'exclamation, de quelques mots dramatiques et du
     débit de parole.
   - Il n'y a aucune analyse de thèse, d'arguments, de faits ou théories, ni de structure narrative.
4. **Décisions de montage contextuelles** :
   - le mouvement de caméra est tiré **pseudo-aléatoirement** (`pickMotion`, tirage pondéré par une
     fonction sinus), sauf pour trois règles : couverture → zoom avant, webtoon → panoramique vers le
     bas, planche → lecture case par case ;
   - la durée des plans dépend d'un objectif fixe modulé par l'intensité.
5. **Musique pendant la production** : l'index musical existe, mais **il n'est pas relié à la
   production**. Celle-ci utilise une seule piste, choisie à la main et bouclée, avec ducking.
6. **EDG, assistant local, apprentissage par décision** : absents. L'apprentissage actuel ajuste
   quelques préférences numériques globales à partir des modifications de style.

### Découverte majeure : la pertinence visuelle n'a jamais été mesurée
- Votre vraie narration (Spider-Man, 6 min) a été produite **sans aucune image** (bibliothèque vide,
  donc compositions graphiques seules). Rapport de campagne `real-spidey` : `library.mode = none`.
- Les campagnes avec bibliothèque (documentaire, analyse de comics) utilisent des **dégradés de couleur
  synthétiques, nommés d'après les entités du script** (`scripts/eval/campaign.ts`, `makeLibrary`).
  - La « mesure de pertinence » de ces campagnes vérifie donc qu'un nom correspond à un nom : elle est
    **circulaire**.
  - Elle ne dit rien de la capacité à choisir la bonne case dans une vraie bibliothèque.
- Les tests de détection de cases et de formats de page utilisent des **pages synthétiques** (cases
  pleines sur fond blanc). La détection n'a **jamais été validée sur une vraie page de comics**.

### Principaux risques
1. **Impression trompeuse d'intelligence** : les explications (« montre Spider-Man ») sont sincères, mais
   elles décrivent une correspondance de nom, pas un contenu vu. Un fichier mal nommé produit une image
   fausse avec une explication convaincante.
2. **Sur un vrai fonds** (fichiers nommés « page 12.jpg », CBZ de numéros entiers) : presque toutes les
   pages ont le même score, et le choix se fait alors surtout par diversité et par ordre. Le montage
   devient décoratif plutôt qu'illustratif.
3. **Pas de source de vérité des décisions** (EDG) : impossible de recalculer partiellement, de verrouiller
   une décision, ou d'apprendre d'une correction précise.
4. **La qualité perçue n'a jamais été évaluée par un humain** sur un montage réel avec images réelles.

### Écart avec l'ambition « studio professionnel »
- Fondations techniques : **proches du niveau requis** (N3 à N4).
- Intelligence éditoriale et compréhension des comics : **au début du chemin** (N0 à N2).
- L'écart principal ne se comble pas avec plus de règles. Il faut **percevoir le contenu** des images et
  du texte : vision, OCR, embeddings, et un LLM local en option. Ensuite, **raisonner sur des décisions
  explicites** (EDG), puis **mesurer avec un benchmark humain**.

---

## B. Cartographie technique

### Architecture actuelle (réelle)
```
Renderer React (UI française, verre)  ── IPC typée (shared/api.ts) ──▶  Main Electron
                                                                         │
  main/ipc.ts, productionIpc.ts, pcoreRender.ts ─────────────────────────┤
                                                                         ▼
  engine/ (effets) : ffmpeg.ts · probe · media (import, proxies, dHash) · exporter (segmenté)
                     transcribe (whisper.cpp | faster-whisper) · models (catalogue whisper)
                     voice (nettoyage, resserrement) · audioAnalysis (silences, LUFS)
                     production.ts (ORCHESTRATION de la production, 421 l.) · archive (CBZ)
                     musicLibrary (index, non relié à la production) · tasks (orchestrateur)
                     log · deps · ffmpegCaps · hardware (diagnostic) · generators (compositions)
  production/ (pur) : script, scriptImport, transcriptScript · align · entities + knowledge (52 entrées)
                     narrationFormat (regex) · pacing (règles) · planner (score des images) · builder
                     visuals (choix de composition) · qc · compare · preferences (apprentissage simple)
                     voiceChain · disfluency · pauses · comicRefs · music (analyse du signal)
  core/ (pur)      : model (projet, séquences, clips) · timeline (édition, historique) · panels (XY-cut)
                     comicFormat (règles) · phash · transitions · captions · generators (spécifications)
  pcore/           : présence 3D réactive à la voix (Three.js), expression, placement
```
- **Taille** : ~15 700 lignes TypeScript. Dépendances livrées : React, immer, three, pdf.js, listes de mots.
- **Modèles locaux** : un seul, Whisper (ggml, via whisper.cpp). Aucun modèle de vision, d'OCR,
  d'embedding ni de langage.
- **Stockage** : projet JSON (`.psproj`) avec sauvegarde atomique, cache de dérivés par empreinte, index
  musical JSON. **Pas de base de données** : pas de SQLite ni de FTS. Les bibliothèques sont rescannées
  à chaque production (sauf la musique, qui est incrémentale).

### Pipeline de production réel (`engine/production.ts`, `produceVideo`)
1. Script importé, ou reconstruit depuis la transcription (mode sans script).
2. Analyse de la narration (silences, LUFS).
3. Nettoyage de la voix (copie dérivée).
4. Option : resserrement des pauses et coupe des hésitations (copie dérivée).
5. Alignement script/voix (DP sur les mots Whisper, sinon sur les pauses).
6. Scan des dossiers : import, cases par XY-cut, saturation, dHash, format de page, extraction CBZ.
7. Détection du type de narration (regex), puis préréglage de réalisation.
8. `buildSequence` :
   - découpage en *beats* (règles de durée et de changement d'entité) ;
   - score des images (nom de fichier) ;
   - mouvement (tirage pondéré) ;
   - composition procédurale quand il n'y a pas d'image (règles) ;
   - sous-titres, SFX, P-CORE, musique unique.
9. Contrôle qualité et autocorrection (trous, répétitions, plans trop courts ou trop longs, sous-titres,
   droits, attribution).
10. Rapport de production : raisons par plan, constats du contrôle, voix, type de narration.

### Connexions et isolement
- **Relié au pipeline** : tout ce qui précède.
- **Isolés, non reliés à la production** :
  - `engine/musicLibrary` (index musical) ;
  - `scripts/eval/*` (évaluation) ;
  - `engine/ffmpegCaps` (seulement auto-test et diagnostic).
- **Chevauchements** : la détection du format (`narrationFormat`), l'intensité (`pacing`) et le choix de
  composition (`visuals`) analysent chacun le texte avec leurs propres listes de mots-clés. Il n'existe
  pas de représentation commune du sens d'une phrase.
- **Dépendances circulaires** : aucune constatée. La séparation pur/effets est respectée.

---

## C. Audit fonctionnel

### C.1 Comic Intelligence

| Capacité | Réalité dans le code | Niveau | Confiance |
|---|---|---|---|
| Import de pages, PDF de script, CBZ/ZIP | `engine/archive.ts` (lecteur ZIP borné), import d'images ; **PDF de comics non lu comme pages** (pdf.js ne sert qu'aux scripts) | N3 (CBZ), N0 (PDF de BD) | élevée |
| Limites de page, marges | non détectées ; seules les gouttières entre cases sont cherchées | N0 | élevée |
| Segmentation des cases | `core/panels.ts` : XY-cut récursif sur les gouttières claires et uniformes | N2 | moyenne |
| Cases imbriquées, sans bordure, débordantes, inclinées | impossible par construction (coupes droites, pleine largeur ou hauteur) | N0 | élevée |
| Pleine page, double page, couverture, webtoon | `core/comicFormat.ts` : proportions, nombre de cases, mots du nom de fichier | N2 | moyenne |
| Ordre de lecture | cases triées ; manga (droite à gauche) si nom « manga » ou page en niveaux de gris | N2 | moyenne |
| Lectures non conventionnelles | non | N0 | élevée |
| Validation sur vraies pages | **aucune** (tests : pages synthétiques) | non vérifiée | — |
| Contenu d'une case (personnages, actions, émotions, décor, objets, combats) | **rien** | N0 | élevée |
| Reconnaissance visuelle d'un personnage, costumes, variantes | **rien** ; un « personnage » = un nom trouvé dans le nom du fichier ou le dossier | N0 | élevée |
| Bulles, OCR, type de texte, attribution des dialogues | **rien** | N0 | élevée |
| Continuité entre cases, chronologie, flashbacks, réalités alternatives | **rien** visuellement ; côté texte, références série, volume, numéro, année (`comicRefs.ts`) | N0 (visuel), N2 (références écrites) | élevée |
| Distinction des versions d'un personnage | uniquement par la référence lue (série, volume, année), écartée si elle contredit la source citée | N2 | moyenne |
| Doublons | dHash et couleur moyenne (`core/phash.ts`), regroupés pour la répétition | N3 | élevée |

**Recherche visuelle** (« une case où Black Panther combat Namor ») :
- **impossible** aujourd'hui ;
- la seule recherche existante passe par le nom de fichier, les balises et le dossier (`planner.indexLibrary`) ;
- ni OCR, ni embeddings, ni multimodal ;
- la recherche de l'interface (Médias) filtre par nom.

### C.2 Narrative Intelligence

| Capacité | Réalité | Niveau | Confiance |
|---|---|---|---|
| Phrases, paragraphes, sections, titres | `production/script.ts`, `scriptImport.ts` : réels scripts PDF, TXT et MD, blocs VISUELS, SOURCES, textes à l'écran | N3 | élevée |
| Script depuis la voix | `transcriptScript.ts` : phrases par pauses, sections par longues pauses | N3 | élevée |
| Personnages, lieux, équipes | dictionnaire de 52 entrées et noms propres du script (`entities.ts`) ; pas de coréférence (« il », « le héros ») | N2 | élevée |
| Sujet, thèse, arguments, faits/théories, révélations, conclusion | **non** | N0 | élevée |
| Structure (hook, contexte, enjeux, retournements) | **non** ; sections = titres ou pauses | N0 | élevée |
| Fonction narrative d'un paragraphe | **non** | N0 | élevée |
| Type de vidéo | `narrationFormat.ts` : 7 types par fréquence de regex et durée ; modifie le rythme, les transitions et les cartes | N2 | élevée |
| Émotion, suspense, humour, solennité | `pacing.ts` : « !», mots dramatiques ou calmes, longueur des phrases, débit ; calme, neutre ou intense | N1 | élevée |
| Contradictions, répétitions dans le script | **non** | N0 | élevée |

### C.3 Visual et Media Intelligence

| Capacité | Réalité | Niveau | Confiance |
|---|---|---|---|
| Qualité technique (résolution, format) | sondée (`probe`) ; fond flouté si les proportions diffèrent ; **pas de score de netteté ou de lisibilité** | N1 | élevée |
| Composition, sujet, zones importantes | **non** ; recadrage centré ou par case | N0 | élevée |
| Pertinence narrative | score par nom (`planner.scoreItem`) : entités, indications VISUELS, sources, mots-clés | N2 | élevée |
| « Bon personnage, mauvais événement » | partiellement, seulement si le nom porte un numéro ou une année qui contredit la source citée (score −10) | N1 | élevée |
| Signalement d'un manque | oui : `missing-visual` et `weak-match` dans le contrôle ; repli sur une composition graphique, jamais une image inventée | N3 | élevée |
| Variété, répétition | fenêtre anti-répétition, doublons perceptuels, réserve des images indiquées | N3 | élevée |

### C.4 Intelligence éditoriale et montage

| Capacité | Réalité | Niveau | Confiance |
|---|---|---|---|
| Lien phrase → image | par *beat* (groupe de phrases), au temps exact de la voix | N2 (pertinence), N4 (synchro) | élevée |
| Quand changer d'image, durée | règles : objectif de durée modulé par l'intensité, changement de section ou d'entité ; mini et maxi | N2 | élevée |
| Plan large ou gros plan, case complète ou recadrée | case par case si planche, sinon mouvement aléatoire pondéré | N1 | élevée |
| Plusieurs images, comparaison, split-screen | **non** | N0 | élevée |
| Transitions | fondus aux changements de section (préréglage) ; pas de choix contextuel | N1 | élevée |
| Respirations, montée en intensité | pauses respectées par l'alignement ; montée non construite | N1 | moyenne |
| Mouvements (zoom, panoramique) | Ken Burns sur 6 directions et parcours de cases ; **pas de 2.5D, parallaxe, masques ni détourage** | N2 | élevée |
| Respect de la composition originale | pas de déformation (ratio conservé, fond flouté) ; mais un zoom peut couper une bulle ou un visage, faute de les connaître | N2 | moyenne |
| Validation humaine de la qualité | **jamais faite** sur un montage avec vraies images | non vérifiée | — |

### C.5 Audio, musique, sound design

| Capacité | Réalité | Niveau | Confiance |
|---|---|---|---|
| Transcription FR | whisper.cpp et faster-whisper ; votre voix : confiance 0,91 (small) | N4 | élevée |
| Alignement | DP mot à mot ; 66 min mesurées | N4 | élevée |
| Nettoyage, EQ, compression, de-esseur, loudness, true peak | chaîne pilotée par mesures, latence compensée, réelle | N3 à N4 | élevée |
| Hésitations | celles écrites par Whisper ; Whisper n'en écrit presque pas ; référence annotée en attente | N2 | élevée |
| Plusieurs prises | **non** | N0 | élevée |
| Index musical | réel, testé ; classification par règles, **validée seulement sur des signaux synthétiques** | N2 | élevée |
| Musique par section, transitions, verrouillage | **non relié** ; une piste bouclée | N1 | élevée |
| Ducking, mixage voix/musique | réel, mesuré | N3 | élevée |
| SFX | whoosh et impacts synthétisés localement, aux changements de section et sous les titres | N2 | élevée |

### C.6 Motion, timeline, QA, assistant

| Capacité | Réalité | Niveau | Confiance |
|---|---|---|---|
| Compositions procédurales (cartes, chronologie, cosmique, typographie) | réelles, déterministes, réactives à la voix ; **aucune image générée par IA** | N3 | élevée |
| P-CORE | réel, 4 niveaux mesurés | N3 | élevée |
| Timeline (pistes, couper, trim, ripple, transitions, liens, zoom, annuler) | réelle, E2E | N3 | élevée |
| Keyframes, courbes, copier/coller, groupement libre | **non** | N0 | élevée |
| Contrôle technique (écran noir, durée, LUFS, crête, sous-titres trop rapides ou trop longs) | réel | N3 | élevée |
| Contrôle éditorial (pertinence, continuité, rythme perçu) | proxies : correspondance faible ou manquante, répétition, plans courts ou longs | N1 | élevée |
| Texte coupé, mauvais recadrage, rupture sonore, mauvaise transition | **non** | N0 | élevée |
| Assistant conversationnel | **non** | N0 | élevée |
| Apprentissage | `adaptPreferences` : moyenne glissante sur quelques réglages globaux, à partir du style mesuré après retouche | N1 | élevée |

### C.7 Expérience utilisateur (parcours vérifiés en E2E et captures)
- **Parcours complet** : créer, importer, Script → Vidéo, rapport, inspecteur, timeline, export,
  réouverture. Opérationnel et en français.
- **Absents** :
  - validation des décisions une par une (accepter ou refuser un plan avec sa raison) ;
  - vue « ce que l'IA fait » en dehors du journal des tâches ;
  - choix du style au-delà de quelques préréglages ;
  - aperçu de la bibliothèque comics analysée (cases, format) avant production.
- **Accessibilité** : navigation clavier partielle, contrastes du mode clair corrigés récemment, pas
  d'audit d'accessibilité formel.

### C.8 Performances mesurées (machine de développement, CPU, sans GPU)
- **Documentaire de 66 min** (sur la machine de développement, pas votre PC) :
  - transcription faster-whisper small : 0,40× le temps réel ;
  - export : 0,63× le temps réel ;
  - mémoire de crête du processus de campagne : 255 Mo.
- **Votre narration de 6 min** : export en 0,91× la durée.
- **P-CORE**, 150 images en 1080² : de 9 à 79 s selon le niveau. Analyse musicale : 2,2 s pour 3 min.
- **15, 30 et 90 min** : non mesurés. 60 à 66 min l'a été une fois.
- **VRAM, GPU, NPU, grandes bibliothèques** (plus de 1 000 images) : **non mesurés**. La bibliothèque est
  rescannée à chaque production : risque réel au-delà de quelques centaines d'images.

### C.9 Tests
- **Suite** : 27 fichiers, 155 tests et 1 ignoré, tous verts (relancés pour cet audit). 7 E2E.
- **CI** : verte (run 45).
- **Jamais validé avec des ressources réelles** :
  - pages de comics ;
  - personnages ;
  - bibliothèque d'images conséquente ;
  - vraie musique ;
  - bibliothèque réelle et vraie narration réunies dans un même montage ;
  - évaluation humaine d'un montage.

---

## H. Décisions attendues de votre part
1. **Données de référence** (indispensables, rien ne peut les remplacer) :
   - 20 à 50 pages de comics réelles que vous possédez, avec vos annotations de cases, bulles et
     personnages (un outil d'annotation peut être fait) ;
   - un vrai script de 10 à 15 min avec sa narration et la bibliothèque d'images que vous utiliseriez ;
   - 5 à 10 musiques avec leurs licences ;
   - vos 42 annotations d'hésitations.
2. **Modèles** (téléchargements à autoriser, licences à confirmer une à une) : voir
   `03_PROPOSITION_ARCHITECTURE_PLAN_BENCHMARK.md` §8.
3. **Architecture** : création de l'EDG, et d'un index des médias en SQLite, pour les grandes bibliothèques.
4. **Matériel** : le rapport de diagnostic de votre PC (Réglages → Enregistrer le rapport). Sans lui, je
   ne peux choisir ni taille de modèle ni profil GPU.
5. **Arbitrages** :
   - niveau d'autonomie par défaut (proposition : automatique au-dessus de 0,8 de confiance, validation
     entre 0,5 et 0,8, sinon repli signalé) ;
   - accepter qu'un LLM local soit **facultatif**, le montage restant possible sans lui ;
   - priorité entre la reconnaissance des personnages, qui demande votre galerie de référence, et la
     recherche par description (embeddings, sans galerie).
