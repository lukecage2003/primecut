# Conception : sélection musicale à partir de votre bibliothèque

État actuel : une seule piste choisie à la main, mise en boucle, niveau relatif à la voix, ducking
sous la narration. Ce document propose la suite. **Rien n'est codé tant que vous ne l'avez pas validé.**

## Principes non négociables
- Analyse **100 % locale avec FFmpeg**, déjà livré. Aucun modèle, aucune API, aucun téléchargement.
- Fichiers d'origine **jamais modifiés**. L'index d'analyse est stocké dans le cache, indexé par
  l'empreinte du fichier, et peut être reconstruit.
- La **licence** de chaque piste est conservée et affichée. Une licence inconnue produit un
  avertissement dans le contrôle qualité et dans le rapport d'export.

## 1. Analyse de chaque piste
| Caractéristique | Mesure | Fiabilité annoncée |
|---|---|---|
| Durée, format, métadonnées (titre, artiste, genre, commentaire, copyright) | ffprobe | exacte |
| Licence | balises `copyright`/`license`, puis fichier voisin (`.txt`, `.json`, `LICENSE`), puis saisie manuelle | exacte si présente |
| Intensité, dynamique | EBU R128 : LUFS intégré, plage dynamique (LRA), crête vraie | exacte |
| Courbe d'énergie | niveau RMS toutes les 0,5 s : montées, creux, passages calmes | exacte |
| Tempo (BPM) | flux spectral puis autocorrélation de l'enveloppe des attaques, avec un indice de confiance | indicative ; les erreurs de moitié ou de double sont connues |
| Brillance, densité | centroïde spectral, densité d'attaques | indicative |
| Voix chantée probable | énergie dans la bande 300 Hz – 3 kHz et variation de hauteur | indicative ; une voix chantée gêne la narration |
| Boucle possible | ressemblance entre le début et la fin | indicative |

## 2. Classification
- **Énergie** (basse, moyenne, haute) et **rythme** (lent, modéré, rapide) : déduits des mesures.
- **Ambiance** (calme, mystère, tension, action, épique, mélancolie, lumineux) : règles explicites à
  partir des mesures, toujours avec leur explication (« tension : énergie moyenne, tempo 120,
  peu de brillance »). **Ce n'est pas une reconnaissance par IA**, et l'interface le dit.
- Vos corrections (étiquettes modifiées) sont mémorisées dans l'index et priment sur les règles.

## 3. Association avec la narration
- Pour chaque chapitre ou section, Primestone détermine une **cible** : ambiance et énergie voulues.
  Elle part du type de narration (classement, résumé, documentaire…), de l'intensité du texte (déjà
  calculée pour le rythme du montage), des mots-clés de la section et de sa position (introduction,
  montée, conclusion).
- Chaque piste reçoit un **score** : proximité avec la cible, durée suffisante (ou bouclable sans
  coupure audible), absence de voix chantée, pistes pas déjà utilisées, compatibilité avec la piste
  voisine.
- Le choix est **expliqué** dans l'inspecteur, comme pour les images.

## 4. Transitions, intensité, silences, ducking
- Changement de piste **aux frontières de section**, calé sur une pause de la narration : fondu
  enchaîné de 1 à 3 s.
- Fondu d'entrée et de sortie ; sortie calée sur la fin de la narration.
- **Variations d'intensité** : la musique remonte dans les longues pauses (respiration du montage)
  et redescend sous la voix (ducking existant, conservé).
- Les passages calmes de la piste sont placés sous les passages denses de la narration quand c'est
  possible.

## 5. Contrôles
- Répétitions : même piste dans deux sections consécutives, ou dans les dernières vidéos du projet.
- Incompatibilités : écart de tempo de plus de 25 % sans transition longue, saut de niveau de plus
  de 6 LU, voix chantée sous la narration, licence inconnue ou incompatible avec l'usage déclaré.

## 6. Interface
- Panneau **Musique** :
  - dossier de bibliothèque et tableau des pistes analysées (ambiance, énergie, BPM, licence) ;
  - écoute avant choix ;
  - correction des étiquettes.
- Pour chaque section, dans l'inspecteur : piste choisie et raison, **Remplacer** (avec une liste
  d'alternatives classées) et **Verrouiller**. Un choix verrouillé est conservé à la régénération.

## 7. Critères d'acceptation (mesurés, tests automatiques)
1. **Tempo** : sur des pistes de test générées par FFmpeg (BPM connu, 60 à 180), écart ≤ 4 %, ou
   moitié/double signalé comme tel. Sur votre bibliothèque, précision annoncée seulement après
   comparaison avec des BPM que vous aurez fournis.
2. **Énergie** : l'ordre est correct sur des pistes de test d'intensité croissante ; mesure LUFS à ±0,1.
3. **Choix** :
   - pas la même piste deux sections de suite quand une autre convient ;
   - un choix verrouillé ne change jamais ;
   - le résultat est déterministe (mêmes entrées, même choix).
4. **Mixage** : musique au moins 8 dB sous la voix pendant la parole, crête vraie ≤ −1 dBTP, aucun
   trou de silence non voulu aux transitions (détection automatique sur l'export).
5. **Originaux** : empreinte SHA-256 des fichiers inchangée après analyse et export.
6. **Licences** : une piste sans licence déclenche un avertissement dans le contrôle qualité et figure
   dans le rapport d'export.
7. **Performance** : analyse d'une piste de 3 min en moins de 5 s sur la machine de CI, avec cache
   (deuxième passage quasi instantané).

## 8. Découpage proposé
1. Analyse et index (moteur et tests).
2. Classification et score (cœur pur et tests).
3. Plusieurs pistes par section, transitions et intensité dans la timeline et l'export.
4. Interface : panneau Musique, Remplacer et Verrouiller (E2E et captures d'écran).

Pour valider sur du réel, j'aurai besoin de **quelques pistes de votre bibliothèque** (5 à 10, avec
leur licence), car il n'y en a aucune ici.
