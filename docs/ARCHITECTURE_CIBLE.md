# Architecture cible — Primestone Local AI

13 novembre 2026. Évolution progressive de l'existant, **sans refonte**. Les changements majeurs
signalés ci-dessous (EDG, runtime de modèles) seront présentés avant leur développement.

## 1. Séparation vérifiée
| Couche | Rôle | Constat dans le dépôt |
|---|---|---|
| Claude Code | outil de développement | aucune trace dans l'application : `grep anthropic\|claude src package.json` → rien |
| Primestone Local AI | décisions de production | `src/production` (pur, testé) + `src/engine/production.ts` (orchestration) |
| Modèles locaux | reconnaissance vocale aujourd'hui | whisper.cpp embarqué ; modèles téléchargés seulement avec accord, SHA-1 vérifié |
| Moteurs déterministes | audio, vidéo, analyse | FFmpeg (sous-processus), analyses en TypeScript pur |
| Orchestrateur | tâches | `engine/tasks.ts` (priorités, dépendances, annulation, journal corrélé) |
| Timeline | représentation éditable | `core/model.ts`, `core/timeline` (historique, annuler/rétablir) |
| Rendu | export | `engine/exporter.ts` (segmenté, reprenable, vérifié), P-CORE |

Dépendances embarquées : React, immer, three, pdf.js, listes de mots. **Aucune API, aucun service
d'IA.** La seule adresse réseau du code est celle des modèles whisper (téléchargement consenti).

## 2. Correspondance avec les modules demandés
- Core, Timeline Engine : `core/`.
- Project Manager : `engine/projectStore.ts`.
- Media Library : `engine/media.ts` et `MediaLibrary`.
- Script Studio : `production/script*`, `engine/scriptFile.ts`.
- Voice Studio : `engine/voice.ts`, `production/voiceChain.ts`, `production/disfluency.ts`, `production/pauses.ts`.
- Music Studio : `production/music.ts` et `engine/musicLibrary.ts` (**nouveau**).
- Comic Intelligence : `core/comicFormat.ts`, `production/comicRefs.ts`, `engine/archive.ts`, détection de cases.
- Edit Decision Engine : `production/planner.ts` et `production/builder.ts`.
- Motion Studio : `engine/generators.ts`, `production/visuals.ts`, `pcore/`.
- Audio Engine et Render Engine : `engine/exporter.ts`.
- Quality Assurance : `production/qc.ts`, `production/compare.ts`.
- Model Manager : `engine/models.ts`.
- Learning System : `production/preferences.ts`.
- **Absents** : Local AI Runtime générique, EDG, assistant.

## 3. Écarts et évolution proposée

### 3.1 Edit Decision Graph (EDG) — écart principal
Aujourd'hui, les décisions vivent directement dans la séquence : chaque clip a sa raison
(`reason`), le rapport de production a ses constats. Il manque :
- un identifiant stable par décision ;
- la confiance ;
- les dépendances (phrase → plan → mouvement → musique) ;
- l'état de validation ;
- le **recalcul partiel**.

**Proposition** : un module pur `core/edg.ts`, sérialisé dans le projet (`sequence.production.edg`,
avec un champ de version).
```
Decision { id (stable : hash(type, ancre)), type: 'plan'|'mouvement'|'musique'|'titre'|'sfx'|'coupe-voix'|…,
           ancre: { phrase?, section?, t0, t1 }, source?: mediaId, action, raison, confiance 0–1,
           dépendances: id[], contraintes, état: 'proposée'|'validée'|'verrouillée'|'rejetée', auteur: 'ia'|'utilisateur' }
```
- La timeline est **matérialisée** depuis l'EDG. Une modification manuelle importante devient une
  décision `auteur: 'utilisateur'`, verrouillée.
- Une modification du script, de la voix ou des médias invalide seulement les décisions qui en
  dépendent ; seules celles-ci sont recalculées.
- L'autonomie dépend du mode choisi (automatique, avec validation, assisté, manuel) et de la confiance.

**Critères d'acceptation** :
- même entrée → même EDG ;
- une phrase modifiée → seuls ses plans changent ;
- un plan verrouillé est conservé à la régénération ;
- annuler/rétablir compatible ;
- les projets existants s'ouvrent toujours (migration).

C'est une **modification architecturale majeure** : je la présenterai en détail avant de la coder.

### 3.2 Runtime de modèles locaux
Généraliser le contrat de `engine/models.ts` (déjà en place pour whisper : catalogue, consentement,
reprise, empreinte) à d'autres familles :
```
ModelEntry { id, famille: 'asr'|'ocr'|'vision-embedding'|'texte-embedding'|'llm', format: 'ggml'|'onnx'|'gguf'|'traineddata',
             taille, licence, ramMo, vramMo?, cpuOk, sha, url }
Runtime    { charger(model), exécuter(entrée) → sortie typée, décharger() }   // un seul modèle lourd à la fois
```
- Chaque fonction qui utilise un modèle a un **repli déterministe** (aujourd'hui : mots-clés, règles,
  mesures). Elle ne bloque jamais une production.
- La version du modèle, de l'outil et des paramètres est inscrite dans le rapport de chaque production.

### 3.3 Technologies candidates (à revérifier au moment de chaque intégration)
| Besoin | Candidat | Licence (code / poids) | Exécution | Remarque |
|---|---|---|---|---|
| Reconnaissance vocale | whisper.cpp (en place) | MIT / MIT | CPU, GPU facultatif | ✅ intégré |
| OCR des bulles | Tesseract 5 | Apache-2.0 / Apache-2.0 | CPU | texte comics majuscule : précision à mesurer |
| Détection des bulles et des cases | modèle de détection ONNX | variable : **à vérifier par modèle** | ONNX Runtime (MIT), CPU ou DirectML | beaucoup de modèles comics publics sont sous licence non commerciale ou AGPL : à exclure |
| Recherche sémantique d'images | encodeur image et texte (famille CLIP ou SigLIP) en ONNX | dépend des poids (Apache-2.0 ou MIT existent) | CPU acceptable en indexation de fond | réponse au point 3 du chemin critique |
| Embeddings de texte (script) | e5 ou MiniLM multilingue en ONNX | MIT ou Apache-2.0 selon les poids | CPU | relie les phrases aux descriptions et à l'OCR |
| Raisonnement éditorial, assistant | llama.cpp (MIT) avec un modèle GGUF de 3 à 8 Md de paramètres | **licence des poids à vérifier par modèle** | CPU lent, GPU conseillé | facultatif : le montage ne doit jamais en dépendre |

Aucun de ces modèles n'est téléchargé sans votre accord. Les tailles, la RAM et la VRAM seront
**mesurées sur votre machine** avant toute recommandation.

### 3.4 Matériel
- **Machine de développement** (ce conteneur cloud, pas votre PC) : 4 cœurs Xeon à 2,3 GHz,
  15 Go de RAM, aucun GPU.
- **Votre PC** : inconnu. Réglages → Matériel en fait l'inventaire (CPU, RAM, GPU, encodeurs vérifiés par
  un vrai test). Sans cet inventaire, je ne recommande ni taille de modèle ni profil GPU.

### 3.5 Premier pipeline « Voice-First » (état réel)
1. Voix → transcription ✅
2. → script reconstruit ✅
3. → type de narration ✅
4. → nettoyage ✅
5. → pauses et hésitations ✅ / 🧪
6. → association aux médias (mots-clés, références, formats de planche) ✅
7. → plans, mouvements et compositions ✅
8. → **musique par section** ⛔ (lot en cours, index fait)
9. → sous-titres ✅
10. → contrôle ✅
11. → export vérifié ✅

La production complète fonctionne déjà de bout en bout sur une vraie narration (6 min, puis 66 min).
Il manque : la musique par section, l'EDG (reprise et recalcul) et la compréhension visuelle du contenu.
