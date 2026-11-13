# Journal des modifications

## Non publié
- **Bibliothèque musicale** (nouveau panneau « Musique ») :
  - analyse locale de vos fichiers par FFmpeg : métadonnées, LUFS, dynamique, crête vraie, énergie,
    tempo avec indice de confiance (valeur double ou moitié signalée en cas d'ambiguïté), brillance,
    voix chantée probable, aptitude à boucler ;
  - ambiances estimées par des règles expliquées, et corrigeables ;
  - licences lues dans les balises, un fichier voisin ou le dossier, sinon « inconnue » ;
  - doublons et pistes semblables, historique d'utilisation ;
  - index persistant et incrémental : un fichier inchangé n'est pas réanalysé, un fichier déplacé est
    reconnu, l'écriture est atomique avec points de reprise. Originaux jamais modifiés.
  - Une piste de 3 min est analysée en 2,2 s.
- **Contrôle des capacités de FFmpeg** : tous les codecs, filtres et formats utilisés, et absence de
  `nonfree`. Il est vérifié dans l'auto-test de l'installation et dans Réglages → Dépendances.
- **FFmpeg minimal reproductible, étape 1** : sources figées, script de compilation croisée vers Windows
  et workflow séparé avec tests de non-régression. Il ne remplace pas le binaire livré.
- **Dossier d'écoute des hésitations** : extraits avec identifiants stables, contrôles aléatoires, page
  d'annotation hors ligne, calcul de la précision, du rappel et des fausses alarmes (`scripts/eval/`).
- **Interface « verre »** inspirée du matériau d'Apple : verre plus épais, reflet en bordure, contrôles
  en capsule, rayons concentriques, en mode sombre et clair.
- Titres de fenêtre restants traduits en français.
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
- Correctif de confidentialité (Windows) : le dossier personnel restait visible dans le journal technique
  (détecté par la CI, run 38), corrigé avant toute publication.
- CI Windows : le test CBZ ne dépend plus de l'outil `zip` (runs 33–35 en échec, corrigé).

## 0.7.0
- Transcription intégrée (whisper.cpp v1.9.5), gestionnaire de modèles, mode sans script, types de
  narration, formats de planche, archives CBZ, doublons d'images, comparaison des versions,
  resserrement des pauses, nettoyage de la voix, interface et installateur en français,
  4 niveaux de qualité P-CORE. Détail : `RAPPORT_AUDIT_GLOBAL.md`.
