# Journal des modifications

## Non publié
- **Hésitations et répétitions** (Voice Studio) : les « euh », « hum » et les mots répétés (« le le »,
  « c'est un c'est un ») sont repérés dans la transcription et signalés dans le contrôle qualité avec
  leur instant. Nouvelle option « Couper les « euh » et les répétitions » (désactivée par défaut) :
  coupe dans une copie dérivée, l'enregistrement d'origine reste intact, le montage reste synchronisé.
  Les doublons grammaticaux (« nous nous »), les intensifs (« très très »), les exclamations
  (« oh lala lala »), les fins de phrase et les énumérations ne sont jamais pris pour des erreurs.
  Les « euh » ne figurent plus dans un script reconstruit à partir de la voix ni dans les sous-titres.
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
