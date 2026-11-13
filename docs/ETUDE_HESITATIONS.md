# Étude : détection des hésitations (« euh », « hum »)

13 novembre 2026. Aucun modèle n'a été téléchargé pour cette étude. Le comportement actuel est
inchangé : les hésitations écrites par la transcription sont signalées, et la coupe reste désactivée
par défaut.

## 1. Silero VAD répond-il au besoin ? Non.
- D'après sa documentation officielle (README, licence MIT vérifiée dans le fichier `LICENSE`), Silero
  VAD est un *Voice Activity Detector* : il donne, par tranche de 30 ms ou plus, la probabilité qu'il y
  ait de la parole (`get_speech_timestamps`). Il ne reconnaît pas ce qui est dit.
- Un « euh » est de la voix : Silero le classe « parole » exactement comme un mot. Il ne peut pas
  séparer une hésitation d'un mot ; il ne peut que délimiter la parole, ce que Primestone fait déjà
  avec la mesure d'énergie (pauses).
- Remarque : le badge du README affiche « CC BY-NC 4.0 » mais pointe vers la licence MIT ; le
  fichier `LICENSE` du dépôt est bien MIT.

## 2. Solutions locales évaluées (sans nouveau modèle)

| Méthode | Principe | Votre narration (6,1 min, voix réelle) | Voix synthétiques (21,2 min, **0 hésitation par construction**) |
|---|---|---|---|
| A. Transcription actuelle (Whisper `small`) | mots écrits par Whisper | 0 « euh » écrit | 0 fausse alarme |
| B. Whisper guidé (consigne initiale remplie de « euh ») | astuce connue pour que Whisper écrive les hésitations | 0 « euh » écrit (seul « Ben », prénom, a été exclu) | non mesuré : la méthode n'apporte rien sur la voix réelle |
| C1. Acoustique, critères larges (plage voisée hors mots ≥ 0,15 s, hauteur stable < 1,5 demi-ton) | un « euh » est un son voisé, stable, que Whisper n'a attribué à aucun mot | 6 candidates | **26 fausses alarmes** (≈ 1,2 par minute) |
| C2. Acoustique, critères stricts (≥ 0,25 s, < 1,0 demi-ton) | idem | 0 candidate | 3 fausses alarmes (≈ 0,14 par minute) |

Script reproductible : `scripts/eval/hesitations-acoustic.ts`.

## 3. Ce que l'on peut conclure honnêtement
- **Faux positifs** : mesurés, sur une vérité certaine (voix synthétiques). C1 est inacceptable ;
  C2 est proche du seuil acceptable.
- **Précision et rappel : non mesurables aujourd'hui.** Aucune des narrations de référence ne
  contient d'hésitations annotées. Votre narration en contient peut-être très peu : ni Whisper (A, B)
  ni l'acoustique stricte (C2) n'en trouvent. Annoncer un rappel serait inventer un chiffre.
- Les 6 candidates de C1 sur votre voix (69,7 s ; 147,5 s ; 241,6 s ; 243,3 s ; 273,2 s ; 281,2 s)
  sont toutes courtes (0,16 à 0,24 s) : fin de syllabe, respiration voisée ou vrai « euh ».
  Seule une écoute peut trancher.

## 4. Proposition (à valider)
1. **Constituer une référence annotée**, sans rien télécharger :
   - Primestone extrait chaque candidate, avec 1 s de contexte, dans un dossier d'écoute.
   - Vous l'étiquetez (« euh » / respiration / mot / autre) dans une page simple.
   - Idéalement, ajoutez 2 à 3 minutes enregistrées en parlant naturellement, avec de vraies hésitations.
   - Précision, rappel et taux de fausses alarmes seront ensuite calculés sur cette référence.
2. **Critère d'acceptation** pour activer un détecteur acoustique dans l'application :
   - précision ≥ 0,8 sur la référence annotée ;
   - fausses alarmes ≤ 0,2 par minute sur les voix synthétiques ;
   - en mode « signalement » seulement, la coupe restant facultative et désactivée par défaut.
3. **Si la référence montre un rappel insuffisant**, la piste suivante est un modèle de reconnaissance
   qui écrit les hésitations (wav2vec2 ou CTC phonétique, licences à vérifier). Elle demandera votre
   accord explicite avant tout téléchargement.
