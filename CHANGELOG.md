# Journal des modifications

## Non publié

### Comics réels, mode histoire et retouches en français (14/11/2026)
- **PDF de comics** : chaque page est rendue en image (pdf.js et @napi-rs/canvas, licences libres) et lue
  comme une planche. Un PDF de texte (un script) est laissé de côté. Un dossier de pages numérotées est
  aussi traité comme un livre.
- **Correction** : dans l'application assemblée, pdf.js ne trouvait pas ses fichiers internes. La lecture
  des PDF, scripts compris, échouait sans le signaler.
- **Mode histoire** : les pages suivent la narration dans l'ordre du livre.
  - Ancrages : `[VISUEL: page N]`, texte lu dans les bulles, noms.
  - Jamais de retour en arrière, aucune page prévue n'est sautée.
  - Une page lue sur plusieurs phrases continue sa lecture case par case au lieu de recommencer.
- **Découpe des cases** :
  - nouvelle méthode par régions, avec découpe le long des gouttières inclinées, choisie page par page
    quand elle couvre mieux le dessin ;
  - mesurée sur 5 numéros réels (139 pages) ;
  - **une page incertaine n'est jamais découpée** : elle est montrée entière, puis parcourue en grandes
    fenêtres pleine largeur, sans couper de case.
- **Types de page** :
  - la page 1 est la couverture ;
  - une page unie et sans mise en page de cases (titre, auteurs, crédits, publicité) est classée
    « générique » et retirée de l'histoire ;
  - une page avec des bulles reste toujours une page d'histoire ;
  - une pleine page (« splash ») est une page d'histoire.
- **Cadrage** : la caméra reste sur la page, sans bande noire d'un seul côté. Autour de la page, un fond
  flou de la page remplace le noir.
- **OCR des bulles** : chaque bulle est découpée, agrandie, binarisée et lue seule, ce qui est bien plus
  fiable que la page entière. L'OCR est actif d'office dès que Tesseract est présent.
- **Voix** :
  - réglage « voix radio » (rondeur, présence, air, compression en deux étages) ;
  - coupe des hésitations activée par défaut ;
  - détection des sons non transcrits entre deux mots ;
  - Whisper est guidé pour écrire les « euh ».
- **Retouches en français** : texte ou voix (micro, transcription locale), par exemple « plans plus
  courts », « baisse la musique de 3 dB », « logo en haut à gauche ». Chaque changement est listé et ce qui
  n'est pas compris est signalé.
- **S'inspirer d'une vidéo** : mesure locale des coupes, de la durée des plans, du mouvement et du volume,
  proposés comme réglages.
- **Images libres sur Internet** (désactivé par défaut) : Openverse et Wikimedia Commons, licences
  CC0, domaine public, CC BY et CC BY-SA ; crédits joints à l'export.
- **P-CORE** : au premier plan quand rien n'est à l'écran, logo dans le coin dès qu'une image est affichée.
- Un titre de section qui répète les premiers mots dits n'est plus affiché par-dessus le sous-titre.

### Corrections de montage et matrice HUD (13/11/2026, démo « Apocalypse »)
- **Doubles sous-titres supprimés**, trois causes trouvées et corrigées :
  - les compositions « phrase clé » réaffichaient en grand les mots de la narration sous le sous-titre ;
  - les fichiers `.srt` et `.vtt` portaient le nom exact de la vidéo, d'où un chargement automatique par
    VLC, MPC ou Films et TV par-dessus les sous-titres incrustés. Ils sont désormais écrits dans un
    dossier séparé « — sous-titres (pour YouTube, TikTok) » ;
  - les bandeaux de nom doublaient une carte de personnage montrant déjà ce nom.
- **Sous-titres adaptés au format** : longueur de ligne calculée sur le cadre réel (42 caractères en 16:9,
  33 en carré, 27 en 9:16), avec une taille identique dans l'aperçu, l'export et le contrôle qualité.
  En vertical, ils faisaient 4 lignes.
- **Bandeaux de nom au-dessus des sous-titres** : ils se chevauchaient dans tous les formats.
- **Pas de texte sous un titre de section** ; pas de carte de personnage répétée avant 60 s.
- **Noms propres de la vidéo** (panneau Script → Vidéo) :
  - ils guident la transcription locale ;
  - les noms mal reconnus sont corrigés par proximité d'écriture et de son (« N. Sabanour » → « En Sabah
    Nur », « death-sid » → « Death Seed ») ;
  - élisions et petits mots conservés (« d'Apocalypse », « Age of Apocalypse »), singulier et pluriel
    respectés ;
  - chaque correction est listée dans le rapport.
- **P-CORE, matrice HUD** (nouvelle couche et préréglage « Primestone HUD ») :
  - spectre circulaire mesuré sur la voix (24 bandes) ;
  - balayage, anneaux segmentés, grille hexagonale, réticule ;
  - lectures de l'état, du niveau de voix et du temps.
  - Design original ; la couche est masquée quand P-CORE est en coin.
- **Directeur P-CORE** : « c'est là que l'histoire devient… » et « beaucoup plus intéressant » sont
  reconnus comme moments forts.
- **Rendu P-CORE** : la fenêtre de rendu est fermée avant le retrait de ses canaux (erreur « No handler
  registered for 'pcore:next' » en fin de rendu).

### P-CORE V2 (13/11/2026) — détails et mesures : `docs/PCORE_V2.md`
- **Entité en 5 couches indépendantes** autour de la silhouette officielle (fidélité mesurée : IoU 0,97 avec
  le tracé du logo) :
  - noyau extrudé en or miroir avec vernis et arêtes lumineuses ;
  - structure interne géométrique ;
  - anneaux orbitaux sur plusieurs plans 3D ;
  - champ d'énergie organisé en coques et spirales, avec ondes ;
  - atmosphère : halo, rayons, voile.
- **12 expressions** composables, avec variantes, durées, intensités, enveloppes et conditions : veille, éveil,
  noyau actif, concentration, expansion d'énergie, mouvement orbital, fragmentation, reconstruction,
  révélation, transition cinématique, silence, stabilisation finale.
- **Moteur d'animation** : ressorts amortis (inertie), composition par priorité, micro-mouvements
  déterministes, réactions vocales mesurées. Les tours se terminent toujours de face.
- **Lecture narrative en contexte** : position, phrases voisines, connecteurs, forme, marqueurs pondérés.
  Fonctionne aussi sans texte, d'après la voix seule.
- **Directeur d'évolution** : sa mémoire espace les moments forts en arbitrant par importance (une
  révélation n'est jamais sacrifiée à une montée moindre) ; variantes en rotation ; densité plafonnée ;
  journal des choix.
- **5 préréglages réels** : Classic, Cinematic, Cosmic, Minimal, Revelation.
- **Présence** :
  - mode cinématique sur les révélations fortes ;
  - s'écarte des titres et des noms à l'écran (défaut V1.1 corrigé), des zones OCR et des zones
    protégées ; respecte la position verrouillée ;
  - fondus enchaînés entre deux placements sur deux pistes.
- **Timeline** :
  - réactions P-CORE enregistrées dans la version, visibles sur les clips ;
  - accepter, verrouiller, changer d'expression, de durée ou d'intensité, désactiver, rétablir, ajouter
    à la tête de lecture ;
  - nouveau rendu des seuls clips concernés, annulable ; modifications conservées à la régénération.
- **P-CORE Studio** : choix du moteur V2 ou V1.1, préréglages, onglets Identité, Animation, Narration,
  Présence, Expressions (avec aperçu) et Performance (temps, images/s, processeur, mémoire, GPU actif).
- **Compatibilité** : les clips V1.1 sont rendus à l'identique (même scène, même cache).
- `npm run pcore:validate` et `npm run pcore:demo` : validation mesurée et démonstration par le vrai
  pipeline.

### Réalisation de l'audit (13/11/2026)
- **Graphe de décisions de montage (EDG)** (`src/core/edg.ts`) :
  - chaque choix automatique (image d'un passage, musique d'une partie) est une décision qui porte :
    - un identifiant stable, calculé à partir du texte du passage ;
    - ses candidats, ses critères et ses preuves ;
    - sa confiance et ses dépendances ;
    - son état (proposée, acceptée, verrouillée, rejetée) et son historique.
  - Le graphe est enregistré avec la version : projets au schéma 4, migration automatique des projets
    existants (graphe reconstitué depuis le rapport de production).
  - Toute retouche de la timeline le met à jour dans le même pas d'annulation : une image remplacée
    à la main devient votre choix verrouillé ; un plan supprimé rend la décision rejetée.
  - Annuler et rétablir restaurent le graphe avec la timeline.
- **Accepter, verrouiller, rejeter, remplacer** depuis le rapport ou l'inspecteur du clip :
  - un rejet place aussitôt la proposition suivante et le média rejeté n'est plus jamais proposé pour
    ce passage ;
  - les badges de la timeline signalent les plans verrouillés, acceptés, rejetés ou à vérifier.
- **Régénération** :
  - les décisions verrouillées ou acceptées sont reprises et les rejets restent exclus ;
  - avec « garder les plans des passages inchangés » (activé par défaut), modifier une phrase ne
    change que ses propres plans.
- **Correspondances honnêtes** :
  - une image sans aucun rapport avec le passage n'est plus placée automatiquement : elle est
    remplacée par une composition animée ou un « visuel manquant » (option contraire, désactivée par
    défaut) ;
  - chaque preuve indique son origine : nom du fichier, étiquette, dossier, référence comics,
    description écrite par vous, texte lu par l'OCR, votre choix ;
  - une correspondance fondée sur les seules métadonnées plafonne à 75 % de confiance ;
  - de simples mots-clés en commun ne font plus une correspondance « précise » ;
  - le rapport rappelle que le contenu des images n'est pas analysé.
- **Musique par section** :
  - quand aucune piste n'est imposée, chaque partie du script reçoit une piste de votre bibliothèque
    musicale, choisie selon son énergie et son ambiance ;
  - voix chantée évitée, licences NC et ND écartées ;
  - changements seulement aux frontières de section, placés sur une pause de la voix ;
  - remplacement et verrouillage par partie ; utilisation enregistrée dans l'historique de la piste.
- **Structure du script** (`src/production/narrative.ts`) :
  - fonction de chaque section (accroche, contexte, explication, révélation, liste, conclusion), lue
    par des règles explicites ;
  - indices cités, confiance plafonnée, estimation de l'intensité ;
  - rien n'est ajouté au script.
- **Index persistant des médias** (`src/engine/mediaIndex.ts`), partagé entre projets :
  - analyses réutilisées (cases, empreinte, format) ;
  - fichiers déplacés reconnus par leur contenu ;
  - fichiers modifiés réanalysés ;
  - fichiers disparus marqués « introuvables », jamais supprimés ;
  - écriture atomique ; un index endommagé est mis de côté puis reconstruit.
- **Recherche des médias** dans les noms, étiquettes, dossiers, descriptions et texte lu par l'OCR, avec
  le champ qui correspond.
- **Description d'image** : modifiable dans l'inspecteur, ou dans le fichier voisin `.json`. Elle sert à
  la correspondance et compte comme du contenu.
- **OCR local facultatif** (Tesseract, Apache-2.0, installé par vous ; jamais téléchargé) :
  - texte des bulles, zones de texte et confiance ;
  - Réglages → OCR local, avec vérification de l'installation.
- **Cases** :
  - tolérance adaptée au bruit des scans ;
  - seconde passe pour les gouttières traversées par le dessin ;
  - indice de confiance du découpage ;
  - aperçu de la page avec les cases numérotées et les zones de texte.
- **Contrôle éditorial** :
  - plans fondés sur les seuls noms ;
  - faible confiance ;
  - décisions rejetées sans remplaçant ;
  - lettrage coupé par le cadrage ou le zoom (quand les zones de texte sont connues) ;
  - découpage des cases incertain ;
  - musique sans licence déclarée.
  - Ces constats sont recalculés en direct après chaque décision.
- **Benchmark réel** (`docs/BENCHMARK.md`, `npm run bench`, `scripts/bench/annotate.html`) :
  - formats d'annotation B1 à B4 et métriques (IoU, τ de Kendall, CER, rappel@10, nDCG, κ, notes
    humaines) ;
  - outil d'annotation hors ligne ;
  - aucun résultat publié faute de données réelles.
  - La campagne synthétique est désormais signalée comme circulaire pour la pertinence.
- **Corrections** :
  - le glisser-déposer de fichiers dans la médiathèque ne fonctionnait pas : le type testé était
    « Fichiers » au lieu de « Files » ;
  - comparaison de versions : « Plans avec image pertinente » devient « correspondance précise (contenu
    non analysé) », sans flèche « meilleur » ;
  - mouvements de caméra affichés en français dans l'inspecteur ;
  - constats du contrôle accessibles au clavier.
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
