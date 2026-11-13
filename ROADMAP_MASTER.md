# Feuille de route maître et matrice de progression

Mise à jour : 13 novembre 2026, v0.7.x. **Aucun pourcentage** : chaque ligne donne un état et la preuve
qui le justifie. États : ✅ livré et testé · 🟡 livré, à améliorer · 🟠 partiel · ⛔ absent.
Détail fonction par fonction : `RAPPORT_AUDIT_GLOBAL.md` (matrice A–L).

| Lot (MASTER EXECUTION V2) | Prio | État | Preuve | Reste à faire |
|---|---|---|---|---|
| 6.1 Journal technique | P0 | ✅ | `tests/unit/log.test.ts` (4), E2E Réglages | historique consultable dans l'application (aujourd'hui : résumé + dossier) |
| 6.2 Diagnostic matériel | P0 | 🟡 | rapport JSON (matériel, espace, 2 mesures réelles, dépendances, problèmes récents) | recommandations automatiques selon le matériel |
| 6.3 Gestionnaire de ressources | P0 | 🟡 | modèles whisper : consentement, reprise, SHA-1 (3 tests) ; état des dépendances | réparation guidée, VAD et ONNX dans le même registre |
| 6.4 Reproductibilité | P0 | 🟠 | whisper.cpp épinglé (tag + commit + SHA-256) ; FFmpeg tracé par SHA-256 | **FFmpeg épinglé : attend votre accord** pour archiver le build dans une release |
| 6.5 Robustesse | P0 | 🟡 | autosave + récupération (E2E), annulation, échec immédiat de FFmpeg, archives bornées | tests de pannes (disque plein, fichier verrouillé) |
| Voice Studio | P1 | 🟡 | nettoyage mesuré, pauses resserrées, prise ratée finale retirée ; **hésitations et répétitions** signalées, coupe facultative dans une copie dérivée (4 unitaires + 1 intégration ; 0 fausse alarme sur 3 transcriptions réelles, 14 500 mots, après correction) | les « euh » que Whisper n'écrit pas restent introuvables (VAD) ; respirations ; comparaison de prises |
| Music Intelligence | P1 | ⛔ | — | analyse de la bibliothèque, choix par section, fondus, ducking, droits |
| Script-to-Video | P1 | ✅ | intégration + E2E, production réelle (6 min, 66 min) | niveaux d'automatisation |
| Timeline : keyframes, courbes | P1/P2 | ⛔ | — | `core/keyframes` |
| Comic Intelligence (bulles, OCR, traduction) | P2 | 🟠 | formats de planche, cases, CBZ, doublons | bulles/OCR ONNX + Tesseract |
| Image Intelligence (recherche sémantique) | P2 | ⛔ | — | embeddings locaux (modèle avec consentement) |
| Thumbnail Studio, Motion Studio | P2 | ⛔ / 🟡 | compositions génériques | — |
| P-CORE performance | P2 | 🟡 | 4 niveaux mesurés (9 à 79 s pour 150 images 1080²) | NVENC validé sur une vraie machine |
| Catalogue i18n | P2 | ⛔ | interface en français en dur | `renderer/i18n` |
| Rapport qualité à chaque export | — | 🟡 | contrôle qualité de production ; export vérifié (durée, LUFS) | rapport écrit à côté de chaque export |
| P3 (apprentissage, lots, commandes vocales) | P3 | ⛔ | — | — |
