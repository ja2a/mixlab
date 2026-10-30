# Design system MixLab — Liquid Glass

Source de vérité : `src/renderer/styles/tokens.css`. Les composants sont dans `src/renderer/components/ui.tsx` et leurs styles dans `app.css`. Aucune valeur de couleur, de rayon, d'ombre ou de durée n'est codée en dur hors des tokens, à l'exception des teintes de lumière d'ambiance.

## Matériaux

Le verre combine quatre couches :

1. une teinte fumée translucide (`--glass-*`) ;
2. `backdrop-filter: blur(30px) saturate(175%)` ;
3. un **liseré lumineux** en dégradé, dessiné par masque (`::before`), plus clair en haut à gauche comme sous une source de lumière ;
4. un **reflet spéculaire** (`::after`) et un `inset` haut et bas.

| Matériau | Usage |
|---|---|
| `glass-ultrathin` | superpositions légères |
| `glass-thin` | cartes de morceaux, capsules de transition, vue d'ensemble |
| `glass-regular` | barres latérales (bibliothèque, studio) |
| `glass-thick` | lecteur flottant, modales, menus, notifications, glisser-déposer |

Derrière le verre, trois sphères de lumière floutées dérivent lentement. Leur teinte suit le morceau sélectionné (`--ambient-hue`, transition de 1,4 s). Sur macOS, la fenêtre utilise la vibrancy native `under-window` ; sur Windows, l'acrylic.

## Couleurs

- **Neutres** : fond `#060608` → `#121218`. Les encres sont en blanc translucide : 94 %, 66 %, 44 %, 26 %, 12 %.
- **Accents** : bleu électrique `#5b8cff`, violet `#a07bff`, blanc lumineux.
- **Sémantique** : ok `#3ddc97`, attention `#ffb547`, problème `#ff5d6c`. Ces couleurs sont réservées aux états.
- **Codes musicaux** : la tonalité est colorée selon la roue Camelot (12 teintes). Les points de confiance BPM sont vert, orange ou rouge. Les formes d'onde ont trois bandes : basses en bleu, médiums en violet, aigus en blanc.

## Typographie

SF Pro Text et SF Pro Display (police système de macOS, via `-apple-system`), avec Segoe UI Variable sous Windows. Chiffres tabulaires (`.num`) pour le BPM, les temps et les scores.

| Rôle | Taille et graisse |
|---|---|
| Titre de mixtape | 28 / 680, suivi −0,03 em |
| Titre de panneau | 17 / 590 |
| Corps | 13 |
| Métadonnées | 11–12 |
| Étiquettes de section | 10 en capitales, suivi +0,06 em |

## Espacements, rayons, ombres

- **Espacements** : grille de 4 pt (`--s-1` à `--s-9`) ; gouttière de 12 px entre les panneaux.
- **Rayons** : 6 (puces), 8 (champs), 12 (cartes internes), 16 (morceaux), 22 (panneaux), 28 (lecteur, modales), pilule.
- **Ombres** : `--shadow-1` (posé), `--shadow-2` (panneau), `--shadow-float` (flottant), `--shadow-glow` (focus d'accent).

## Mouvement

| Durée | Usage |
|---|---|
| 120 ms | survol |
| 220 ms | changement d'état |
| 380 ms | ouverture de panneau |
| 640 ms | entrée de panneau |

Courbes : `ease-out` pour les entrées, ressort (`cubic-bezier(.34,1.5,.64,1)`) pour les segmented controls, interrupteurs et capsules. `prefers-reduced-motion` et le réglage système de macOS ramènent toutes les durées à 0 et figent les sphères de lumière et le liseré animé.

## États interactifs

| État | Rendu |
|---|---|
| Survol | remplissage `--fill-2` |
| Appui | `scale(.97)` |
| Désactivé | 38 % d'opacité |
| Sélection | anneau d'accent 1 px et halo bleu diffus |
| Focus clavier | `outline` 2 px accent |

Le bouton **Générer une mixtape** est le seul élément avec un liseré conique animé (bleu, violet, blanc, aqua) et une lueur : c'est l'action principale de l'application.
