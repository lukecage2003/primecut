# Étude : version figée et documentée de FFmpeg

13 novembre 2026. Rien n'a été publié ni remplacé. Le binaire a été téléchargé dans un dossier
temporaire, uniquement pour l'inspecter.

## 1. Le binaire utilisé aujourd'hui (installateur Windows)
- **Source** : `BtbN/FFmpeg-Builds`, release `latest`, archive `ffmpeg-n8.1-latest-win64-gpl-8.1.zip`.
- **Contrôle** : SHA-256 `7bc0ebd9…48989f2`, conforme au `checksums.sha256` publié.
- **Version exacte** : `n8.1.3-35-gf1acb0a266`, compilée le 13/11/2026. L'archive « latest » change
  **chaque jour** : deux installateurs produits à deux dates différentes n'embarquent pas le même FFmpeg.
- **Configuration** (lue dans l'exécutable) :
  - `--enable-gpl --enable-version3` → **GPL-3.0** ;
  - **pas de `--enable-nonfree`**, `--disable-libfdk-aac` : rien de non redistribuable ;
  - environ **60 bibliothèques liées en statique** : x264, x265, libvpx, aom, dav1d, svt-av1, rav1e,
    vvenc, openh264, libass, harfbuzz, freetype, fribidi, fontconfig, opus, vorbis, mp3lame, twolame,
    opencore-amr, vmaf, rubberband, zimg, placebo, shaderc, vulkan, sdl2, zmq, srt, ssh, xml2,
    chromaprint, frei0r, gmp, etc.

## 2. La redistribution est-elle autorisée ? Oui, sous conditions.
- La GPL-3.0 autorise la redistribution. Mais **héberger ce binaire dans une release Primestone fait de
  Primestone un distributeur** (GPL-3.0, §6). Il faut alors fournir la *source correspondante complète* :
  FFmpeg au commit exact, **les ~60 bibliothèques aux versions exactes**, et les scripts de compilation.
- BtbN publie ses scripts (versions des dépendances fixées dans `scripts.d`), mais **pas les archives
  sources**. Un lien vers les sites d'origine ne suffit pas à garantir leur disponibilité dans la durée.
- `openh264` : la licence de brevets de Cisco ne couvre que les binaires compilés par Cisco. Celui-ci
  est compilé par BtbN : point de vigilance (Primestone ne s'en sert pas).
- **Conclusion** : archiver le binaire BtbN tel quel demanderait d'archiver aussi environ 60 sources
  (plus d'1 Go) reconstituées à la main, avec un vrai risque d'erreur de conformité.
  **Je ne recommande pas cette voie**, et rien n'a été archivé.

## 3. Ce dont Primestone se sert réellement (relevé dans le code)
- **Encodeurs** : libx264, libx265, libvpx-vp9 (transparence P-CORE), libopus, aac, flac, pcm,
  prores_ks, qtrle, png, mjpeg. Plus h264/hevc en nvenc, qsv et amf, utilisés seulement s'ils passent
  un test réel.
- **Filtres** : scale, crop, overlay, fade, format, gblur, boxblur, `ass` (typographie : libass,
  freetype, harfbuzz, fribidi, fontconfig), ebur128, silencedetect, highpass, alimiter, amix,
  aselect, asetpts, afade, afftdn, deesser, etc.
- **Bibliothèques externes nécessaires** : une dizaine, contre ~60 embarquées.

## 4. Options

| Option | Reproductible | Conformité | Coût |
|---|---|---|---|
| A. Archiver le binaire BtbN dans une release | oui | lourde : ~60 sources à reconstituer et archiver | élevé, risqué |
| **B. Compiler notre FFmpeg minimal** depuis des archives sources figées (FFmpeg 8.1.3 + ~10 bibliothèques), comme pour whisper.cpp | **oui** | **simple** : chaque archive source a un SHA-256 et est publiée à côté du binaire | compilation CI de 20 à 40 min, puis mise en cache |
| C. Garder BtbN « latest » et mieux tracer | non | inchangée (pas d'hébergement : BtbN distribue) | nul |

**Recommandation : B**, avec C comme mesure immédiate (consigner la version exacte et la configuration
dans `SOURCE.txt` et dans l'auto-test, sans rien publier).

## 5. Critères d'acceptation de l'option B (avant de remplacer quoi que ce soit)
1. **Compilation et provenance**
   - Compilation depuis des archives sources dont le SHA-256 est fixé dans le script.
   - Configuration écrite dans `BUILDCONF.txt`, licence calculée (`ffmpeg -L`), aucune option `nonfree`.
2. **Contenu de la release** (publiée **seulement après votre accord**) :
   - binaire et `SHA256SUMS` ;
   - `BUILDCONF.txt` ;
   - texte de licence de chaque composant ;
   - **archives sources exactes** de FFmpeg et de chaque bibliothèque ;
   - script de compilation.
3. **Non-régression, avant de remplacer le binaire BtbN**
   - Chaque codec et chaque filtre de la liste du §3 est présent (test automatique).
   - Suite complète, E2E et auto-test de l'installateur sous Windows avec le nouveau binaire.
   - Export de référence comparé à BtbN : même durée, LUFS à ±0,1, transparence VP9 relue.
   - Benchmark d'encodage sans écart de plus de 10 %.
4. **Repli** : le script BtbN est conservé et peut être réactivé d'une seule option tant que B n'a pas
   passé ces tests.
