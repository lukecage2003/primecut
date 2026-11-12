# Rapport de livraison — Primestone Motion Studio 0.6.0

Date : 12 novembre 2026 · Branche : `claude/gallant-hawking-c8govj`

Ce rapport ne présente comme « terminé » que ce qui a été exécuté et vérifié. Le produit **n'est pas
complet** : plusieurs fonctions importantes du cahier des charges sont absentes (§ 3).

## 1. Version livrée

- **Primestone Motion Studio 0.6.0**, application de bureau Windows (Electron 45, TypeScript,
  React) avec FFmpeg 8.1 embarqué (build GPL BtbN).
- **Installateur** : `Primestone Motion Studio Setup 0.6.0.exe` — 228,1 Mo, NSIS, installation par
  utilisateur (sans droits administrateur), choix du dossier, raccourcis Bureau et menu Démarrer,
  désinstalleur.

### Où se trouve l'installateur

Il est produit par l'intégration continue à chaque version, **après** les tests :
GitHub → `lukecage2003/primecut` → **Actions** → dernier run vert de la branche → **Artifacts** →
`primestone-windows-installer`. Exemple vérifié : run 21,
`https://github.com/lukecage2003/primecut/actions/runs/43312493476` (les artefacts GitHub expirent
après 90 jours ; chaque nouveau run en produit un neuf).

Procédure d'installation : `INSTALLATION_WINDOWS.md`. Premiers pas : `DEMARRAGE_RAPIDE.md`. Manuel :
`GUIDE_UTILISATEUR.md`.

## 2. Fonctionnalités terminées (testées)

| Domaine | Ce qui fonctionne | Preuve |
|---|---|---|
| Projets | création, sauvegarde atomique + 20 sauvegardes, autosave, récupération après plantage, médias déplacés (**Locate…**) | E2E « crash recovery », « vertical slice » |
| Montage | timeline multipiste à l'image près, coupe, trim, ripple, roll, slip, slide, transitions, fondus, marqueurs, annuler/rétablir | tests unitaires timeline + E2E |
| Script | import PDF/TXT/MD de vos scripts réels ; bibliographies et annexes jamais lues | 5 scripts réels ; tests unitaires |
| Voix | transcription locale (faster-whisper, optionnelle), alignement mot à mot, détection des paroles hors script (prises ratées) | campagne + votre narration réelle |
| Réalisation automatique | choix des images avec raisons, lecture case par case, mouvements de caméra, rythme selon les sections, compositions procédurales quand une image manque, jamais d'écran noir | campagne (5 scénarios) |
| Références comics | série / volume / numéros / année lus dans les sources, la narration et les noms de fichiers ; les œuvres homonymes d'une autre époque sont exclues | tests unitaires |
| Son | nettoyage de la voix mesuré et réversible, ducking de la musique, effets sonores procéduraux, limiteur master (−16 LUFS, crête vraie −1,4 dBFS) | tests d'intégration + votre voix |
| P-CORE | présence 3D construite sur le logo, réactive à la voix (9 états), placement adaptatif, piste propre, export alpha vérifié | E2E P-CORE Studio, tests unitaires |
| Sous-titres | générés, synchronisés, incrustés, **SRT et VTT** à côté de la vidéo | test unitaire + E2E |
| Formats | 16:9, 9:16, 1:1, 4:5 : chaque format est une version recomposée | tests d'intégration 4:5 et 1:1 |
| Export | MP4/MOV/MKV, H.264/H.265, vérification automatique, rendu segmenté reprenable pour les vidéos longues | tests d'intégration, documentaire 66 min |
| Apprentissage | **Learn from my edits** (adaptation de paramètres, pas d'entraînement de modèle) ; historique et **Restore** | tests unitaires |
| Installation | installation silencieuse, auto-test de l'application installée, désinstallation propre, sur Windows propre | CI run 21 |

## 3. Partiellement terminé / non disponible

| Fonction | État |
|---|---|
| Recherche d'illustrations sur Internet | ⛔ non disponible (aucun fournisseur connecté ; rien n'est envoyé en ligne) |
| Commandes vocales / assistant en langage naturel | ⛔ non disponible |
| Choix automatique d'une musique selon l'ambiance | ⛔ non disponible (vous choisissez le morceau ; ducking automatique disponible) |
| Comparaison chiffrée de deux versions | ⛔ non disponible (les versions sont conservées et consultables) |
| Gestionnaire de modèles (téléchargement avec accord, empreintes) | ⛔ non disponible : le modèle Whisper et Python s'installent à la main (`INSTALLATION_WINDOWS.md` § 8) |
| Sous-titres « mot par mot » (karaoké) | ⛔ non disponible |
| Interface en français | ⛔ l'interface est en anglais ; les guides sont en français |
| Intelligence comics | ⚠ partielle : ~50 entités de référence + noms appris du script ; pas de base de publications/dates |
| Mise à jour automatique | ⚠ manuelle (relancer le nouvel installateur) |
| Signature de code | ⚠ installateur non signé → avertissement SmartScreen |
| Accélération GPU | ⚠ **non mesurée** sur une RTX 3050 ; encodeurs matériels utilisés seulement s'ils passent un test réel |
| P-CORE | ⚠ rendu à l'avance (pas en temps réel dans le lecteur) ; validé en rendu logiciel seulement |

## 4. Tests exécutés et résultats

| Suite | Résultat |
|---|---|
| Vérification de types | ✅ 0 erreur |
| Tests unitaires | ✅ 84 / 84 |
| Tests d'intégration (FFmpeg réel) | ✅ 27 / 27 |
| Tests de bout en bout (application réelle, Linux + Windows CI) | ✅ 6 / 6 |
| CI Windows (tests + installateur + installation/auto-test/désinstallation) | ✅ run 21 |
| CI Linux | ✅ run 21 |

### Campagne de production (fichiers réellement exportés et mesurés)

Voix de synthèse (espeak) avec vérité terrain exacte, sauf mention « réelle ».

| Scénario | Durée | Sync médiane / ≤ 250 ms | Export | Son | Écran noir |
|---|---|---|---|---|---|
| Short vertical (Despair) | 2 min 26 | 1 ms / 93 % | 1,78× temps réel | −16,0 LUFS / −1,4 dBFS | aucun |
| Analyse comics, nombreuses références (Télépathie) | 10 min | 58 ms / 83 % | 1,27× | −16,1 / −1,4 | aucun |
| Sans illustrations (Apocalypse) | 8 min 46 | 44 ms / 85 % | 1,05× | −16,1 / −1,4 | aucun |
| Documentaire (5 scripts) | 66 min | **6 ms / 94,5 %** (après correction, voir § 4.2) | 0,63× (segmenté, vérifié) | −16,1 / −1,4 | aucun (revérifié) |
| **Narration réelle** *Midnight Spider-Man* (votre MP3), sans images | 6 min 08 | non mesurable (pas de vérité terrain) | 0,91× (vérifié) | −15,9 / −1,5 | aucun |

Mémoire maximale ≤ 255 Mo sur tous les scénarios.

### 4.1 Votre narration réelle

- Transcription locale : 937 mots en 117 s (0,32× la durée), confiance moyenne 0,91.
- Voix : −35,5 LUFS à l'origine (très faible) → −16,1 LUFS ; sibilance −9 dB ; aucune saturation ;
  traitement en 13 s. Aucun débruitage appliqué (le fond est déjà silencieux, mesuré à −88 dBFS).
- La prise ratée à la fin (348,5–367,6 s) est détectée et laissée hors du montage.
- P-CORE : après recalibrage sur votre voix, emphase 13 % du temps (au lieu de 40 %).
- Montage complet sans images (55 plans animés), contrôle qualité 100, export 1080p de 348,7 s en
  316 s, vérifié, −15,9 LUFS, aucun écran noir, 155 Mo de mémoire maximale.
- Le script utilisé est **reconstruit à partir de la transcription** (vous n'avez pas fourni le
  script de cette vidéo) : la précision de synchronisation ne peut donc pas être mesurée contre une
  vérité terrain sur cet enregistrement.

### 4.2 Bug de mesure découvert grâce à votre narration

Les pauses (et, dans la campagne, les écrans noirs) détectées dans la première partie des
enregistrements de plus de ~4 minutes étaient perdues : le journal de FFmpeg était tronqué. Corrigé
et couvert par un test. Sur le documentaire de 66 min, mesuré contre la vérité terrain : erreur
médiane 58 ms → **6 ms**, 90 % des phrases sous 15 ms, 94,5 % sous 250 ms. La vérification des
écrans noirs du documentaire a été refaite après correction sur les 66 min : aucun écran noir.

### Ce que les tests ne prouvent pas

Ils prouvent que le logiciel fonctionne et que les fichiers produits sont valides et synchronisés.
Ils **ne mesurent pas la qualité éditoriale** (pertinence artistique, rythme ressenti) : seule votre
relecture des vidéos le peut.

## 5. Compatibilité Windows

- Testé sur Windows Server 2025 (runner GitHub `windows-latest`, propre à chaque run) : tests,
  application réelle, installateur, auto-test, désinstallation.
- **Non testé** sur votre PC ni sur une machine avec carte NVIDIA.

## 6. Performances mesurées et configuration testée

Machine de développement : 4 vCPU Xeon, 15 Go RAM, **sans GPU** (rendu logiciel).
- Génération : 3 s à 18 min selon la quantité d'animations à calculer (≈ 2× la durée de la vidéo
  quand il n'y a aucune image).
- Export 1080p : 1,05× à 1,78× la durée ; 720p segmenté : 0,63×.
- Nettoyage de la voix : ≈ 30 à 36× plus rapide que la durée.
- P-CORE (rendu logiciel) : ≈ 3 images/s en 1080×1080.
- Votre RTX 3050 : **non mesurée**. Utilisez **Settings → Save diagnostics report…** et
  envoyez-moi le fichier.

## 7. Dépendances et licences

Détail : `docs/LICENSES.md`. Résumé : code de l'application sous licence du projet ; Electron, React,
Three.js, pdf.js (MIT/Apache-2.0) ; listes de mots FR/EN (MIT) ; FFmpeg build GPL (redistribution du
binaire avec sa licence et ses sources) ; faster-whisper / Whisper (MIT) **non inclus**, installés par
l'utilisateur ; aucune police, musique ou image tierce n'est incluse. Aucune API payante, aucun
compte, aucune donnée envoyée.

## 8. Limitations connues

`docs/KNOWN_LIMITATIONS.md` (à jour). Les plus importantes : § 3 ci-dessus ; seuils de nettoyage
validés sur une seule voix réelle ; la synchronisation sans transcription reste approximative (≈ 3 s).

## 9. Prochaines améliorations recommandées

1. Tester sur votre PC : installer, produire « test spidey » avec son vrai script, envoyer le
   rapport de diagnostic (mesure RTX 3050).
2. P-CORE V1.1 (demandé) : rendu natif, niveaux de qualité, mesures GPU, placement manuel permanent.
3. Gestionnaire de modèles : transcription installable en un clic, avec votre accord, sans Python.
4. Fournisseurs d'images en ligne autorisés (désactivés par défaut, licences vérifiées).
5. Interface en français ; musique automatique ; comparaison de versions ; commandes en langage
   naturel.
