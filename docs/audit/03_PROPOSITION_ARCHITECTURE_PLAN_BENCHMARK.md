# Proposition — architecture cible, plan de finalisation, benchmark, IA locale

> **PROPOSITION À VALIDER.** Ce document n'est pas la feuille de route approuvée
> (`ROADMAP_MASTER.md`). Rien n'est développé avant votre accord.

## E. Architecture cible

### E.1 Principe
On n'ajoute pas une IA au-dessus du pipeline. On fait évoluer le pipeline en **quatre couches**, en
réutilisant l'existant, sans réécriture.
```
                ┌──────────────── PERCEPTION (modèles spécialisés, locaux, facultatifs) ─────────────┐
 Médias ──────▶ │ Pages → cases (détecteur) · bulles + OCR · embeddings image/texte · description   │
                │ de case (VLM) · personnages (galerie de référence) · musique (mesures existantes)│
 Script ──────▶ │ structure narrative, entités, faits/théories (LLM local facultatif + règles)     │
 Voix ────────▶ │ ASR + alignement (existant) · prosodie, intensité, hésitations                   │
                └──────────────┬───────────────────────────────────────────────────────────────────┘
                               ▼  (résultats versionnés, mis en cache par empreinte, en SQLite)
                ┌──────────── CONNAISSANCE DU PROJET (index unique) ─────────────┐
                │ MediaIndex (SQLite + FTS + vecteurs) · ScriptGraph · VoiceMap   │
                └──────────────┬──────────────────────────────────────────────────┘
                               ▼
                ┌──────────── DÉCISION (déterministe, explicable) ───────────────┐
                │ Edit Decision Graph : candidats → score multi-critères → choix  │
                │ + confiance ; règles de réalisation par type de vidéo ; musique  │
                │ par section ; autonomie adaptative (seuils)                     │
                └──────────────┬──────────────────────────────────────────────────┘
                               ▼
                ┌──────────── MATÉRIALISATION ET CONTRÔLE (existant) ─────────────┐
                │ timeline (core) · rendu et export · QC technique + éditoriale    │
                └──────────────────────────────────────────────────────────────────┘
```
Les modèles **perçoivent** ; ils ne décident pas seuls. La **décision** reste un moteur déterministe qui
combine des perceptions dont la confiance est connue. Elle est reproductible et expliquée.

Chaque perception a un **repli** :
- sans OCR ni embeddings → nom de fichier (comportement actuel) ;
- sans LLM → règles actuelles.

### E.2 Edit Decision Graph (proposition technique)
```
Decision {
  id            hash stable(type, ancre)            // ex. plan:phrase-12
  type          plan | cadrage | mouvement | transition | musique | sfx | titre | coupe-voix
  ancre         { phrases[], section, t0, t1 }
  candidats     [{ ressource, score, critères{pertinence, identité, événement, qualité, variété,
                   continuité, droits}, preuves[] }]       // preuves : OCR, embedding, nom, référence…
  choix         index du candidat | 'repli' | 'manque'
  confiance     0–1 (marge entre les 2 meilleurs × fiabilité des preuves)
  dépendances   ids (ex. mouvement → plan → phrase)
  état          proposée | à valider | validée | verrouillée | rejetée
  auteur        ia | utilisateur ; historique[] (qui, quand, avant/après, pourquoi)
}
```
- **Recalcul incrémental** : une modification du script, de la voix ou des médias invalide un ensemble
  d'ancres ; seules les décisions dépendantes sont recalculées. Les verrouillées sont conservées.
- **Timeline** : matérialisée depuis l'EDG. Une retouche manuelle importante devient une décision
  `utilisateur, verrouillée`. Annuler/rétablir s'applique à l'EDG.
- **Autonomie** :
  - confiance ≥ 0,8 → automatique ;
  - entre 0,5 et 0,8 → « à valider » ;
  - sous 0,5 → repli signalé (composition, autre plan) ;
  - jamais d'image trompeuse imposée.
- **Implications** :
  - migration des projets existants (l'EDG est construit depuis `ProductionMeta`) ;
  - champ versionné ;
  - environ 1 500 lignes de cœur pur testable ;
  - risque principal : la synchronisation timeline/EDG pendant l'édition manuelle.

### E.3 Runtime IA local
- **Gestionnaire unique**, en extension de `engine/models.ts`. Chaque modèle est décrit par : famille,
  format (ggml, onnx, gguf, traineddata), licence, taille, RAM et VRAM mesurées, fonctionnement CPU,
  empreinte, source. Il n'est téléchargé qu'avec votre accord.
- **Exécution** :
  - un processus de travail séparé (isolé du processus principal) ;
  - un seul modèle lourd chargé à la fois ;
  - files de l'orchestrateur existant, avec priorité et annulation ;
  - résultats mis en cache par (empreinte du média, id et version du modèle).
- **Sélection selon le matériel** :
  - profil « Qualité maximale » → plus grands modèles compatibles ;
  - « Rapide » → petits modèles ou repli déterministe.
- **Traçabilité** : chaque production inscrit dans son rapport les modèles, versions et paramètres utilisés.

## F. Plan de finalisation (ordre proposé)

| # | Chantier | Contenu | Dépend de | Risque | Critère d'acceptation |
|---|---|---|---|---|---|
| 0 | **Données de référence** | vos 20 à 50 pages annotées, 1 script réel avec voix et bibliothèque, 5 à 10 musiques ; outil d'annotation local | vous | indisponibilité des données | jeu figé et versionné (hors dépôt si privé) |
| 1 | **Benchmark v0** | protocole de G exécuté sur l'état actuel → scores de référence | 0 | — | rapport chiffré ; c'est la base de toute comparaison |
| 2 | **Index des médias SQLite** | import incrémental, FTS (noms, balises, puis OCR) | — | migration | 10 000 images ; mise à jour < 10 s |
| 3 | **Runtime de modèles et embeddings image/texte** | 1er modèle ONNX ; recherche par description | 2, accord | licence, CPU lent | rappel@10 ≥ 70 % (G) |
| 4 | **Cases (mesure, puis modèle si nécessaire), bulles et OCR** | segmentation mesurée ; OCR des bulles | 0, 3 | lettrage comics difficile | seuils de la matrice |
| 5 | **EDG** | décisions, confiance, verrouillage, recalcul | — | synchronisation timeline | critères de E.2 |
| 6 | **Score multi-critères dans l'EDG** | nom, OCR, embedding, référence, qualité, variété | 3, 4, 5 | pondération | pertinence humaine ≥ 80 % |
| 7 | **Musique par section** | index → sections → transitions → verrouillage | 5 | — | conception musique §7 |
| 8 | **Analyse narrative** | règles améliorées, puis LLM local facultatif (structure, fonction, intensité) | accord | coût CPU, licence | accord humain ≥ 75 % |
| 9 | **Cadrage intelligent** | éviter bulles et visages coupés, plan large ou serré selon la fonction | 4, 8 | — | 0 bulle coupée détectée |
| 10 | **Personnages** | galerie de référence de l'utilisateur et embeddings, avec incertitude | 3 | faux positifs | précision ≥ 90 % au-dessus du seuil |
| 11 | **QC éditoriale et interface de validation** | décisions « à valider » dans l'inspecteur | 5, 6 | — | parcours E2E |
| 12 | **Benchmark v1, puis test final de 15 min** | comparaison avec v0 et jugement humain | tout | — | seuils de G atteints |
| 13 | Assistant, apprentissage par portée, Motion 2.5D | — | 5, 8 | — | P2 |

**À ne pas réécrire** : alignement, voix, export, timeline, orchestrateur, P-CORE, contrôle technique.
Ils sont solides et seront réutilisés tels quels.

## G. Benchmark proposé

### G.1 Jeux de données (privés, hors dépôt)
- **B1 — Pages** : 50 pages réelles (planches, doubles pages, couvertures, manga, webtoon), annotées :
  cases (rectangles), bulles et texte, personnages présents, ordre de lecture.
- **B2 — Recherche** : 50 requêtes en français (« Thanos utilise le Gant ») avec les images pertinentes
  de votre bibliothèque.
- **B3 — Script** : 3 scripts réels (biographie, analyse, théorie), annotés par paragraphe : fonction,
  entités, intensité de 1 à 5.
- **B4 — Production** : 1 projet complet de 10 à 15 min (script, voix, bibliothèque réelle, musique).
- **B5 — Voix** : votre dossier d'écoute des hésitations (42 extraits).

### G.2 Métriques
**Mesures automatiques** :

| Domaine | Métrique | Définition |
|---|---|---|
| Cases | rappel et précision à IoU 0,5, IoU moyenne | cases détectées appariées aux annotées |
| Ordre de lecture | τ de Kendall | entre ordre prédit et ordre annoté |
| OCR | CER, WER | sur le texte des bulles appariées |
| Recherche | rappel@10, nDCG@10 | B2 |
| Personnages | précision et rappel au-dessus du seuil, taux « incertain » | B1 |
| Entités du script | rappel, précision | B3 |
| Fonction narrative | exactitude, κ de Cohen avec l'annotation | B3 |
| Synchronisation voix/image | écart entre le début du plan et le début du passage illustré | B4 ; cible ≤ 250 ms (déjà mesuré pour la voix) |
| Variété | images distinctes / plans ; répétitions dans une fenêtre de 4 plans | B4 |
| Rythme | distribution des durées de plan ; part hors [1,5 s ; 12 s] | B4 |
| Audio | LUFS intégré, crête vraie, LRA, écart musique/voix pendant la parole (≥ 8 dB) | B4 |
| Technique | écrans noirs, images manquantes, sous-titres hors temps | B4 |

**Évaluation humaine** (vous, et idéalement un second évaluateur) :
- note de 1 à 5 par plan sur « l'image illustre ce qui est dit » ;
- note de 1 à 5 par séquence sur le rythme, la lisibilité du cadrage et la cohérence visuelle ;
- note globale « publiable sans retouche / retouches mineures / majeures » ;
- temps de retouche nécessaire en minutes.

**Seuils à fixer avec vous** (proposition) :
- pertinence ≥ 4/5 sur 80 % des plans ;
- 0 image trompeuse ;
- « retouches mineures » au plus.

### G.3 Protocole
1. Benchmark v0 sur l'état actuel : il donne la référence honnête. On s'attend à une pertinence faible
   avec des noms de fichiers génériques.
2. Après chaque chantier, relance automatique des mesures, et évaluation humaine à chaque jalon.
3. Résultats versionnés dans `docs/benchmark/` (scores seulement, sans vos médias).

## 8. IA locale — candidats à étudier

> **Données issues de la documentation publique connue à ce jour, NON mesurées ici.** Tailles et
> mémoire : ordres de grandeur. Licence à **revérifier sur la fiche exacte** avant tout téléchargement.
> Rien n'est téléchargé sans votre accord.

| Fonction | Candidat | Licence (code / poids) | Taille indicative | Exécution, Windows | Remarques |
|---|---|---|---|---|---|
| ASR | whisper.cpp + Whisper small ou large-v3-turbo (**en place**) | MIT / MIT | 466 Mo – 1,6 Go | CPU, GPU facultatif | ✅ |
| Alignement forcé (amélioration) | modèle CTC wav2vec2 français en ONNX | Apache-2.0 en général ; à vérifier | 300 Mo – 1,2 Go | CPU | seulement si le benchmark montre un besoin |
| Embeddings image et texte (recherche) | SigLIP (base) en ONNX | Apache-2.0 | ~400 – 900 Mo | CPU (indexation en tâche de fond), GPU via DirectML | multilinguisme limité : traduire la requête ou utiliser une variante multilingue |
| Idem | OpenCLIP ViT-B/32 | MIT (code) ; poids selon le jeu d'entraînement | ~350 Mo | CPU | alternative |
| Embeddings de texte (script) | multilingual-e5-small ou base, bge-m3 | MIT | 120 Mo – 2,2 Go | CPU | relie phrases, OCR et descriptions |
| Description de case (VLM) | Florence-2 (base ou large) | MIT | 0,2 – 0,8 Md de paramètres | ONNX possible, CPU lent | légende, OCR, détection ; à mesurer sur du comics |
| Idem, plus riche | Qwen2-VL-2B ou 7B | Apache-2.0 | 2 – 7 Md (4 bits : 1,5 – 5 Go) | GPU conseillé | coûteux ; facultatif |
| OCR | PaddleOCR (PP-OCR) en ONNX | Apache-2.0 | ~10 – 20 Mo | CPU | à comparer à Tesseract sur le lettrage comics |
| Idem | Tesseract 5 | Apache-2.0 | ~20 Mo / langue | CPU | faible sur le lettrage manuscrit en capitales |
| Détection de cases et de bulles | détecteur entraîné (RT-DETR, DETR) en ONNX | **à vérifier** | 40 – 200 Mo | CPU ou GPU | ⚠ les modèles comics publics courants sont souvent non commerciaux, AGPL (Ultralytics YOLO) ou GPL (outils de traduction de BD) → **à exclure** ; il faudra peut-être entraîner le nôtre sur vos pages annotées |
| Segmentation (2.5D, détourage, non générative) | SAM 2 ou MobileSAM | Apache-2.0 | 40 Mo – 900 Mo | GPU conseillé | P2 |
| LLM local (narration, assistant) | llama.cpp (MIT) + Qwen2.5-7B-Instruct ou Mistral-7B-Instruct v0.3 | Apache-2.0 | 4 bits : ~4,5 Go ; RAM ~6 – 8 Go | CPU lent, GPU de 8 Go ou plus conseillé | **facultatif** ; Llama et Gemma ont des licences conditionnelles ; Qwen2.5-3B **n'est pas** Apache-2.0 |
| Petit LLM | Phi-3.5-mini | MIT | 4 bits : ~2,3 Go | CPU acceptable | repli |
| Classification musicale | règles actuelles (mesures) ; éventuellement PANNs pour l'étiquetage audio | MIT | ~80 – 300 Mo | CPU | Essentia est sous AGPL et ses modèles sont non commerciaux → **exclu** |

**Architecture hybride recommandée** :
- des petits modèles spécialisés (embeddings, OCR, détecteur) pour la **perception à grande échelle**,
  exécutés en indexation de fond sur CPU ;
- un VLM ou un LLM **facultatif** pour l'analyse fine, sur GPU si disponible ;
- la décision et le rendu restent déterministes.

Le choix effectif dépendra du **rapport de diagnostic de votre PC** et des résultats du benchmark v0.
