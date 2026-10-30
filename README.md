# MixLab

Application desktop (macOS, Windows) de création automatique de mixtapes à partir de fichiers audio locaux. On importe des MP3, MixLab les analyse (tempo, temps, mesures, tonalité, loudness, structure), propose des enchaînements et des ordres de lecture, fait écouter les transitions et exporte tout le mix dans **un seul MP3** (ou WAV).

Tout le traitement est local : aucun fichier n'est envoyé à un service distant, et les fichiers originaux sont uniquement lus.

## Télécharger

Les versions prêtes à installer (`.dmg` pour macOS, installeur `.exe` pour Windows) sont sur la page [Releases](https://github.com/ja2a/mixlab/releases). L'application n'est pas signée : sous macOS, au premier lancement, faites clic droit sur MixLab → **Ouvrir**. FFmpeg doit être installé sur la machine (voir ci-dessous).

## Installation et lancement (développement)

Dépendances système :

| Outil | Version testée | Rôle |
|---|---|---|
| Node.js | 26 (≥ 22 requis) | build, outillage |
| FFmpeg + ffprobe | 9.0 (≥ 6) | décodage, resampling, encodage MP3 (libmp3lame) |

- macOS : `brew install node ffmpeg`
- Windows : `winget install OpenJS.NodeJS FFmpeg` (ou placer `ffmpeg.exe`/`ffprobe.exe` dans le `PATH`)

MixLab cherche FFmpeg dans cet ordre : `MIXLAB_FFMPEG_DIR`, `resources/bin` de l'application packagée, `/opt/homebrew/bin`, `/usr/local/bin`, puis le `PATH`. Si le SoX resampler est disponible dans FFmpeg, il est utilisé ; sinon MixLab passe par swresample avec un filtre long.

```bash
npm install
npm start        # build + lancement
npm run dev      # mode développement (Vite + rechargement)
```

### Package installable

```bash
npm run dist:dir   # MixLab.app non signée dans release/mac-arm64 (vérifiée)
npm run dist       # .dmg (macOS) / installeur NSIS (Windows, à lancer sous Windows)
```

Pour une application autonome sans FFmpeg installé, copiez des binaires **statiques** `ffmpeg` et `ffprobe` dans `vendor/bin/` avant `npm run dist` : ils sont embarqués dans `resources/bin`. Les binaires Homebrew sont liés dynamiquement et ne conviennent pas. Attention : les builds statiques courants sont sous licence GPL.

## Utilisation

1. **Importer** : glisser des fichiers ou dossiers n'importe où sur la fenêtre, ou utiliser `+` / ⌘I. Les doublons (contenu identique) sont ignorés, les doublons probables (même titre et même artiste) sont signalés. Les fichiers illisibles restent visibles avec un message explicite.
2. **Construire la playlist** : glisser des morceaux de la bibliothèque vers la playlist, puis les réordonner à la poignée. Le cadenas fige la position d'un morceau.
3. **Générer une mixtape** : propose plusieurs ordres (Fluide, Montée en puissance, Harmonique, Contrastes maîtrisés) à comparer avec l'ordre actuel. Votre ordre manuel est conservé et récupérable via le bouton « Ordre manuel ». « Garder mon ordre, optimiser les transitions » ne change que les transitions.
4. **Studio** : un clic sur une capsule de transition affiche 4 propositions expliquées et écoutables. Vous pouvez ensuite régler le type, la durée (en mesures ou en secondes), les courbes, l'échange des basses, les points de sortie et d'entrée, les gains, et verrouiller la transition. Un clic sur un morceau donne accès aux points de début et de fin (poignées calées sur les mesures) et au gain. Les corrections manuelles du BPM, de la tonalité et de la grille sont disponibles depuis la fiche du morceau.
5. **Écouter** : barre d'espace, timeline cliquable, sauts de transition en transition. La préécoute utilise exactement le moteur et les paramètres de l'export.
6. **Exporter** : MP3 192/256/320 kb/s ou WAV 24 bits, avec métadonnées, chapitres ID3 par morceau et fiche `.cue` en option. Le rendu tourne en arrière-plan, avec progression et annulation propre ; aucun fichier partiel n'est laissé.
7. **Projets** (`.mixlab`) : plusieurs mixtapes par projet, avec l'ordre, les transitions, les points de début et de fin, les gains, les réglages de tempo et les corrections. Si des fichiers ont été déplacés, « Rechercher… » les retrouve par empreinte de contenu, même renommés.

## Architecture

```
src/
  core/                 logique pure TypeScript, testée sans Electron
    analysis/           FFT, onsets, tempo, beat tracking, downbeats, tonalité, BS.1770, structure
    audio/              FFmpeg (probe, décodage → cache PCM float32), lecteur PCM à accès aléatoire
    music/              Camelot, compatibilité, propositions de transitions, optimisation d'ordre
    mix/                plan de mix, WSOLA, EQ Linkwitz-Riley, limiteur, renderer par blocs
    export/             export MP3/WAV en flux, chapitres, .cue, rapport qualité
    project/            sauvegarde/chargement, empreintes, relink
  main/                 processus principal Electron + worker_threads (analyse ×N, préécoute, export)
  preload/              API IPC typée exposée au renderer (contextIsolation, sandbox)
  renderer/             React 19 + Zustand + dnd-kit ; design system Liquid Glass
tests/                  Vitest (cœur audio) et Playwright/Electron (scénarios UI)
```

**Pourquoi cette stack.** Electron fournit les matériaux natifs (vibrancy macOS, acrylic Windows), donc un vrai effet verre, et un runtime Node pour piloter FFmpeg et les worker threads. Le moteur audio est en TypeScript : l'analyse et le mixage de quelques flux stéréo restent largement plus rapides que le temps réel, et le même code tourne dans les workers de préécoute et d'export, ce qui garantit l'identité préécoute/export. FFmpeg n'est utilisé que pour ce qu'il fait le mieux : décoder tous les formats, resampler et encoder en LAME. Aucune bibliothèque d'analyse fermée ou non maintenue n'est requise.

### Analyse (à l'import, en parallèle sur plusieurs workers, mise en cache par empreinte)

- **Décodage** : un seul passage FFmpeg produit un cache PCM float32 stéréo 44,1 kHz (accès aléatoire, la mixtape n'est jamais chargée entièrement en RAM) et une copie mono 11 025 Hz pour l'analyse.
- **Tempo** : flux spectral sur bandes logarithmiques (¼ d'octave), autocorrélation, score en peigne sur 4 harmoniques avec a priori log-normal, puis correction d'octave.
- **Temps** : programmation dynamique (Ellis 2007), puis ajustement robuste d'une grille constante (période par moyenne d'intervalles, phase par moyenne circulaire, rejet itératif des points aberrants). Les inversions de demi-phase déclenchent le passage au double tempo. On obtient une confiance et un indice de stabilité.
- **Mesures** : la phase des premiers temps est déduite des changements harmoniques, des accents de basses et des sauts d'énergie.
- **Tonalité** : spectrogramme harmonique (filtre médian temporel), estimation de l'accordage, chroma et chroma de basse, corrélation avec les profils Krumhansl-Kessler et Temperley. Résultat en code Camelot avec un indice de confiance.
- **Niveau** : loudness intégrée BS.1770-4 (pondération K, gating), LRA, true peak suréchantillonné ×4, silences de début et de fin.
- **Structure** : nouveauté sur une matrice d'auto-similarité par mesure, calée sur les phrases de 4 mesures, avec les étiquettes intro, couplet, refrain, drop, break et outro.
- **Énergie** : loudness, densité d'attaques, brillance et tempo. La présence vocale ou mélodique est estimée de façon heuristique.

### Intelligence musicale

- **Score de paire** : tempo (y compris demi et double tempo, limite de stretch), harmonie (relations Camelot), énergie, structure (outro de A et intro de B) et chevauchement vocal. Les confiances de l'analyse pondèrent chaque critère.
- **4 propositions par paire** : la plus fluide, la plus énergique (entrée sur le drop de B), la plus harmonique (longueur selon la compatibilité) et une surprenante (demi-tempo, modulation assumée, entrée sur un break). Chacune est expliquée.
- **Ordres** : recuit simulé avec un départ glouton, sous contraintes (morceaux verrouillés à leur position, transitions verrouillées gardées adjacentes) et quatre objectifs différents, dont un arc d'énergie.

### Moteur de mixage

- **Plan** : pour chaque transition synchronisable (grilles fiables, écart ≤ ±6 % configurable), le début est calé sur un premier temps de mesure de A en fin de phrase, et B entre sur un premier temps de mesure. B est étiré pour suivre A pendant le chevauchement, puis revient progressivement à son tempo d'origine (rampe de 16 mesures). Si la synchronisation est impossible, MixLab bascule sur un fondu non calé et l'indique explicitement.
- **Time-stretch** : WSOLA à ratio variable, qui préserve la hauteur. La chaîne de trames est déterministe, mise en cache, et donne un rendu identique après un seek.
- **Transitions** : courbes (puissance constante, S, exponentielle, logarithmique, linéaire), EQ 3 bandes Linkwitz-Riley actif pendant toute la vie de la voix (pas de saut de phase), échange progressif des basses, faders conçus pour éviter les creux de volume.
- **Master** : normalisation par morceau vers −14 LUFS, puis limiteur à anticipation avec détection true-peak ×4. Le plafond de −1 dBTP est garanti par construction et mesuré à l'export.
- **Rendu** : par blocs, avec une automation alignée sur la position absolue. La sortie est identique au bit près quelle que soit la taille des blocs (préécoute = export).
- **Préécoute** : des blocs de 16 384 échantillons rendus dans un worker sont planifiés sur l'horloge Web Audio, sans trou. La pause suspend l'horloge, ce qui évite toute désynchronisation à la reprise.
- **Export** : l'encodage LAME est en CBR, en un seul flux continu. Comme la mixtape est encodée d'un bloc, il n'y a aucune frontière d'encodage entre les morceaux. Le délai et le padding du codec sont déclarés dans l'en-tête Xing/LAME : la durée décodée correspond au plan à la milliseconde près (vérifié).

## Tests

```bash
npm test          # 51 tests Vitest (analyse, mixage, export, intelligence, projets, acceptation sur 25 fichiers)
npm run test:e2e  # 7 scénarios Playwright sur l'application Electron réelle
npm run fixtures  # régénère le matériel de test dans ./fixtures
```

Le matériel de test est **synthétisé** par `src/core/testing/synth.ts` : 22 morceaux à tempo, tonalité et structure connus, une nappe sans pulsation, un fichier corrompu et un fichier tronqué. Aucune musique commerciale n'est distribuée.

Ce que les tests couvrent, en correspondance avec les critères d'acceptation :

| # | Critère | Test |
|---|---|---|
| 1–2 | Import de 20+ MP3, durées, BPM | `acceptance`, e2e 1–2 |
| 3 | Glisser-déposer bibliothèque → playlist, réordonnancement | e2e 3 |
| 4 | Propositions calculées sur les fichiers réels | `intelligence`, e2e 4–6 |
| 5 | Ordre alternatif sans écraser l'ordre manuel | `intelligence`, `acceptance`, e2e 5 |
| 6–7 | Écoute d'une transition, puis de plusieurs successives | e2e 4–7 |
| 8 | Export en un seul MP3 | `export`, `acceptance`, e2e 8 |
| 9 | Durée = somme − chevauchements (écart < 50 ms, mesuré via ffprobe et décodage) | `mix`, `export`, `acceptance` |
| 10 | Aucun silence artificiel | `mix`, `export`, `acceptance` |
| 11 | Aucun clipping (true peak ≤ plafond) | `mix`, `export`, `acceptance` |
| 12 | L'export ne bloque pas l'interface (latence de la boucle principale < 80 ms) | `export`, e2e 8 |
| 13 | Sauvegarde et rechargement d'un projet | `project`, e2e 13 |
| 14 | Fichier corrompu, BPM indétectable | `analysis`, `acceptance`, e2e 1 |

D'autres propriétés sont vérifiées : alignement des temps de B sur ceux de A (< 1 ms au calcul, < 12 ms mesuré sur l'audio rendu), absence de clic aux raccords, conservation de la hauteur par WSOLA, LUFS conforme au filtre `ebur128` de FFmpeg (écart < 0,3 LU), true peak inter-échantillons, seek identique à la lecture continue, annulation propre et performances (mix de 20 min sur 25 fichiers rendu à environ 22× le temps réel, mesuré pendant que les autres tests tournent en parallèle).

## Limites connues

- **Mesures à 4 temps uniquement** : les mètres impairs (3/4, 7/8) ne sont pas modélisés.
- **Tempo constant supposé** : un morceau joué live avec un tempo qui dérive aura une stabilité faible, et ses transitions ne seront pas synchronisées (comportement voulu, signalé dans l'interface).
- **Tonalité** : précision typique des méthodes à profils. Les confusions avec la relative majeur/mineur restent possibles et sont visibles via l'indice de confiance. Une correction manuelle est disponible.
- **Structure, énergie et présence vocale** : ce sont des estimations heuristiques, signalées comme telles. Il n'y a pas de séparation de sources, et la détection vocale ne repose pas sur un modèle entraîné.
- **Time-stretch WSOLA** : la qualité est très bonne jusqu'à environ ±4 % ; au-delà, des artefacts peuvent apparaître sur les sons tenus, et MixLab l'indique. Une intégration de Rubber Band est envisageable via l'interface `PcmSource`/`WsolaChain`.
- **Validation** : la validation automatique repose sur du matériel synthétique. Le comportement sur une vraie bibliothèque commerciale doit encore être éprouvé, notamment la détection du premier temps de mesure et la tonalité.
- **Formats** : WAV, FLAC, AAC/M4A et OGG sont importés via le même pipeline. Seuls MP3, WAV et FLAC ont été testés automatiquement.
- **Packaging** : l'application n'est pas signée ni notarisée. L'installeur Windows doit être construit sous Windows, et le build Windows n'a pas été testé ici.

## Licence

MIT, voir [LICENSE](LICENSE).
