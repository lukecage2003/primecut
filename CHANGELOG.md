# Journal des modifications

## Non publié
- **Journal technique** : fichier JSON par jour dans le dossier de l'application (`logs/`), catégories
  par module, niveaux, rotation (5 Mo, 14 jours), corrélation par tâche, dossier personnel remplacé
  par `~`. Enregistre le début et la fin de chaque tâche, les échecs de FFmpeg, les exceptions du
  programme et de l'interface. La journalisation ne peut jamais interrompre une production.
- **Dépendances défaillantes** : Réglages affiche l'état de FFmpeg, FFprobe, whisper.cpp et des
  modèles, le nombre de problèmes des 7 derniers jours et un bouton vers le dossier des journaux.
- Le rapport de diagnostic contient l'état des dépendances et les problèmes récents ; titre en français.
- CI Windows : le test CBZ ne dépend plus de l'outil `zip` (runs 33–35 en échec, corrigé).

## 0.7.0
- Transcription intégrée (whisper.cpp v1.9.5), gestionnaire de modèles, mode sans script, types de
  narration, formats de planche, archives CBZ, doublons d'images, comparaison des versions,
  resserrement des pauses, nettoyage de la voix, interface et installateur en français,
  4 niveaux de qualité P-CORE. Détail : `RAPPORT_AUDIT_GLOBAL.md`.
