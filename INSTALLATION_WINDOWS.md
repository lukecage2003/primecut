# Installer Primestone Motion Studio sous Windows

Ce guide est écrit pour une personne qui n'a jamais installé de logiciel « technique ». Suivez les
étapes dans l'ordre. Version décrite : **0.7.0**.

> L'interface du logiciel est en français. Les noms des boutons sont indiqués en **gras**.

---

## 1. Ce qu'il faut avant de commencer

- Un PC sous **Windows 10 ou Windows 11, 64 bits**.
- Une connexion Internet **uniquement pour télécharger l'installateur**. Ensuite, tout fonctionne
  hors ligne : vos scripts, votre voix et vos images ne quittent jamais votre ordinateur.
- Aucun compte, aucun abonnement, aucune clé d'API.
- Rien d'autre à installer : le moteur vidéo (FFmpeg) est **inclus** dans l'installateur.

## 2. Caractéristiques du PC

| | Minimum | Recommandé |
|---|---|---|
| Processeur | 4 cœurs (Intel Core i5 / Ryzen 5 récents) | 6 cœurs ou plus |
| Mémoire (RAM) | 8 Go | 16 Go |
| Carte graphique | compatible DirectX 11 (pour P-CORE) | NVIDIA RTX (ex. RTX 3050 Laptop 4 Go) |
| Espace disque | 2 Go pour le logiciel + 10 Go pour vos projets | SSD avec 50 Go libres |
| Écran | 1366 × 768 | 1920 × 1080 |

Ce qui a été mesuré réellement (sur une machine de test à 4 cœurs **sans** carte graphique) :
une vidéo de 66 minutes s'exporte en environ 42 minutes en 720p ; une vidéo de 10 minutes en
1080p s'exporte en environ 13 minutes. Sur votre PC, utilisez **Réglages → Enregistrer le rapport de
diagnostic…** (voir § 12) pour mesurer vos propres performances. Les performances avec la RTX 3050
**n'ont pas encore été mesurées**.

## 3. Où trouver l'installateur

L'installateur s'appelle **`Primestone Motion Studio Setup 0.7.0.exe`** (228 Mo).

Il est fabriqué et testé automatiquement à chaque version sur un Windows propre (installation,
démarrage, auto-test, désinstallation) :

1. Ouvrez la page du projet sur GitHub : `https://github.com/lukecage2003/primecut`.
2. Cliquez sur l'onglet **Actions**.
3. Cliquez sur la dernière ligne marquée d'une coche verte ✅ (branche
   `claude/gallant-hawking-c8govj`).
4. En bas de la page, dans **Artifacts**, cliquez sur **primestone-windows-installer**.
   Un fichier `.zip` se télécharge.
5. Ouvrez le `.zip` (double-clic) et faites glisser `Primestone Motion Studio Setup 0.7.0.exe` sur
   votre Bureau.

## 4. Installation pas à pas

1. Double-cliquez sur `Primestone Motion Studio Setup 0.7.0.exe`.
2. Si Windows affiche **« Windows a protégé votre ordinateur »** (écran bleu SmartScreen) :
   cliquez sur **Informations complémentaires**, puis sur **Exécuter quand même**.
   Ce message apparaît parce que le logiciel n'est pas encore signé par un certificat payant ;
   ce n'est pas un virus.
3. Choisissez **« Pour moi uniquement »** (recommandé : aucun droit administrateur nécessaire).
4. Laissez le dossier proposé (`C:\Users\<vous>\AppData\Local\Programs\Primestone Motion Studio`)
   ou choisissez-en un autre, puis cliquez sur **Installer**.
5. Cliquez sur **Terminer**. Une icône **Primestone Motion Studio** est ajoutée sur le Bureau et
   dans le menu Démarrer.

## 5. Premier lancement

1. Double-cliquez sur l'icône **Primestone Motion Studio**.
2. L'écran d'accueil s'ouvre (fond sombre, accent jaune). Vous pouvez passer en thème clair dans
   **Réglages** (icône ⚙) → **Thème** → **Clair**.
3. Créez un premier projet : voir `DEMARRAGE_RAPIDE.md`.

## 6. Avertissements Windows possibles

- **SmartScreen** au premier lancement : voir § 4, étape 2.
- **Pare-feu** : Primestone n'a pas besoin d'Internet. Si Windows demande une autorisation réseau,
  vous pouvez refuser.
- **Antivirus** : certains antivirus analysent longuement les gros fichiers vidéo pendant l'export ;
  c'est normal.

## 7. Où sont mes fichiers ?

- **Vos projets** : dans le dossier que vous choisissez à la création du projet. Chaque projet
  contient :
  - `NomDuProjet.psproj` — le projet (double-cliquez pour l'ouvrir) ;
  - `Autosave\` — les sauvegardes automatiques (récupération après plantage) ;
  - `Backups\` — les versions précédentes du fichier projet ;
  - `Cache\` — fichiers recalculables (voix nettoyée, animations, P-CORE, transcriptions).
    Vous pouvez le supprimer pour gagner de la place : il sera recréé.
- **Vos médias d'origine** (voix, images) ne sont **jamais modifiés ni déplacés**.
- **Réglages du logiciel** : `C:\Users\<vous>\AppData\Roaming\Primestone Motion Studio\`.

## 8. Transcription locale (facultative mais recommandée)

Sans transcription, Primestone synchronise le texte avec la voix en se basant sur les pauses :
c'est utilisable, mais moins précis (≈ 3 s d'écart moyen mesuré). Avec la transcription locale,
l'écart médian mesuré est de **58 ms**.

La transcription nécessite deux éléments que **vous installez vous-même, une seule fois** (aucun
téléchargement automatique n'est fait par Primestone) :

1. **Python** : téléchargez « Python 3.12 pour Windows » sur `https://www.python.org/downloads/`,
   lancez l'installateur et **cochez « Add python.exe to PATH »** avant de cliquer sur
   *Install Now*.
2. **faster-whisper** : ouvrez le menu Démarrer, tapez `cmd`, ouvrez **Invite de commandes**, puis
   copiez-collez cette ligne et appuyez sur Entrée :

   ```bat
   python -m pip install faster-whisper
   ```

   (C'est la seule étape qui utilise une fenêtre de commande.)
3. **Un modèle Whisper** (licence MIT) : téléchargez le dossier du modèle *faster-whisper-small*
   (≈ 0,5 Go, bon compromis) ou *faster-whisper-medium* (≈ 1,5 Go, plus précis, plus lent) et
   placez-le par exemple dans `Documents\Primestone\modeles\`.
4. Dans Primestone : **Réglages → Transcription locale** → cochez **Utiliser la transcription locale pour
   Script → Vidéo**, choisissez le moteur **faster-whisper**, sélectionnez le dossier du modèle,
   puis cliquez sur **Vérifier**. Un message vert confirme que tout fonctionne.

Mesure réelle (processeur 4 cœurs, sans carte graphique, modèle *small*) : une narration de 6 min
est transcrite en 2 min.

## 9. Vérifier le moteur vidéo (FFmpeg)

FFmpeg est inclus. Pour vérifier : **Réglages** (⚙) → ligne **FFmpeg** : la version s'affiche (et
« NOT FOUND » en cas de problème). Un auto-test complet est aussi possible : il est exécuté
automatiquement sur chaque installateur avant sa publication (encodage vidéo + audio réel,
présence des ressources P-CORE et de la transcription).

## 10. Désinstaller

1. Menu Démarrer → **Paramètres** → **Applications** → **Applications installées**.
2. Cherchez **Primestone Motion Studio** → **⋯** → **Désinstaller**.
3. Vos projets et vos médias **ne sont pas supprimés**. Pour effacer aussi les réglages, supprimez
   le dossier `C:\Users\<vous>\AppData\Roaming\Primestone Motion Studio\`.

La désinstallation silencieuse est vérifiée automatiquement à chaque version (aucun fichier du
programme ne reste).

## 11. Mettre à jour

Il n'y a pas encore de mise à jour automatique. Pour installer une nouvelle version :

1. Téléchargez le nouvel installateur (§ 3).
2. Lancez-le : il remplace l'ancienne version. Inutile de désinstaller avant.
3. Vos projets, réglages et préférences de montage sont conservés.

## 12. Problèmes courants

| Problème | Solution |
|---|---|
| « Windows a protégé votre ordinateur » | **Informations complémentaires → Exécuter quand même** (§ 4). |
| La synchronisation texte/voix est approximative | Installez la transcription locale (§ 8) puis relancez **Générer la vidéo**. |
| **Vérifier** de la transcription affiche une erreur Python | Réinstallez Python en cochant **Add python.exe to PATH**, puis refaites l'étape 2 du § 8. |
| L'export échoue sur un disque presque plein | Libérez de la place ou supprimez le dossier `Cache` d'un ancien projet. |
| P-CORE n'apparaît pas dans la vidéo | Le rapport de génération indique pourquoi (ex. pilote graphique). Mettez à jour le pilote de la carte graphique. La vidéo est produite quand même. |
| Un média est marqué **HORS LIGNE** | Le fichier a été déplacé ou renommé : cliquez sur **Localiser…** à côté du média et indiquez son nouvel emplacement. |
| Le logiciel a planté | Rouvrez le projet : la question **Récupérer les modifications non enregistrées ?** apparaît ; cliquez sur **Récupérer** pour retrouver le travail non enregistré. |
| Mesurer les performances de mon PC | **Réglages → Enregistrer le rapport de diagnostic…** : un fichier JSON est créé (carte graphique, VRAM, processeur, mémoire, test d'encodage réel). Rien n'est envoyé. |
