# Démineur

Démineur à grandes cartes : grille carrée jusqu'à ~1000×1000 (1 M de cases),
nombre de bombes libre (aucun ratio imposé — 99 bombes pour 100 cases marche),
rendu Canvas avec zoom/pan et navigation au clavier.

```bash
npm install
npm run dev        # solo, http://localhost:5173
npm run build      # tsc --noEmit && vite build
npm run serve      # co-op : compile puis sert le jeu + le serveur de partie
npm start          # sert ce qui est déjà compilé (npm run build:all)
```

`npm run serve` affiche les adresses à donner aux autres joueurs :

```
  Sur cette machine : http://localhost:8080
  Depuis le réseau  : http://192.168.1.24:8080
```

## Règles du jeu

Toute la logique de jeu tient dans [`src/game/rules.ts`](src/game/rules.ts) —
c'est le seul fichier qui écrit dans `mines` / `state` / `adj` ; tout le reste
du projet ne fait que les lire.

| Fonction | Rôle |
|---|---|
| `placeMines(board, safeIndex)` | remplit `board.mines`, en épargnant le premier clic |
| `computeAdjacency(board)` | remplit `board.adj` (0..8) |
| `reveal(board, i)` | révèle + cascade ; renvoie `'ok' \| 'boom' \| 'win' \| 'noop'` |
| `toggleFlag(board, i)` | `COVERED` ↔ `FLAGGED` ; renvoie `-1 \| 0 \| 1` |
| `revealAllMines(board)` | découvre les mines après un `'boom'` |
| `placeBonuses(board, safeIndex)` | cache les bonus sous des cases sûres |
| `defuse` / `probe` / `shield` / `randomOpening` | effets des bonus (voir plus bas) |

L'orchestration d'une partie (premier clic, vies, réserve, fin de partie) vit
dans `GameEngine` ([`src/game/engine.ts`](src/game/engine.ts)), pur lui aussi :
le solo l'appelle directement, le serveur l'appelle puis diffuse le résultat.

Choix notables :

- **Placement des mines** — échantillonnage séquentiel de Knuth (algorithme S) :
  une passe sur la grille, chaque case retenue avec la probabilité
  `mines restantes / candidates restantes`. Tirage uniforme, compte exact,
  **zéro allocation** (un Fisher-Yates demanderait 4 Mo sur une 1000×1000), et
  ça tient à n'importe quelle densité — là où un tirage par rejet s'effondre
  au-delà de ~70 %.
- **Premier clic sûr** — le bloc 3×3 autour du premier clic est épargné quand
  la densité le permet, sinon la seule case cliquée, sinon rien (à `n²-1`
  mines il n'y a qu'une case sûre, et c'est celle-là).
- **Cascade** — itérative, en largeur d'abord, avec une file `Int32Array`
  réutilisée : une carte 1000×1000 avec une seule mine ouvre 999 999 cases en
  40 ms, là où une récursion exploserait la pile d'appels. Les cases sont
  marquées à l'enfilement, donc chacune n'entre qu'une fois dans la file — et
  comme le curseur de lecture ne recule jamais, **le tampon contient à la fin
  exactement les cases ouvertes**. C'est ce que renvoie `lastOpened()`, sans
  mémoire ni calcul supplémentaires ; le mode co-op en a besoin pour diffuser
  ses deltas.
- **Victoire** — `board.revealedCount` est tenu à jour par `reveal`, la
  détection est en O(1) (`revealedCount === n² - mineCount`).
- **Défaite** — `revealAllMines` lève `board.minesExposed`. Les cases
  drapeautées gardent leur état `FLAGGED` ; c'est ce drapeau de plateau qui
  autorise le rendu à dessiner la bombe **sous** le drapeau. Tant qu'il est
  false, rien dans les données passées au rendu ne permet de deviner ce qui se
  cache sous un drapeau en cours de partie.

### Le modèle

Des `Uint8Array` plates indexées `i = y * n + x` (5 octets par case) :

```ts
type Board = {
  n: number;             // largeur = hauteur
  mineCount: number;
  mines: Uint8Array;     // 0 | 1
  state: Uint8Array;     // COVERED=0 | REVEALED=1 | FLAGGED=2 | DEFUSED=3
  adj: Uint8Array;       // 0..8
  bonus: Uint8Array;     // BONUS_* caché sous la case, 0 une fois ramassé
  flagOwner: Uint8Array; // poseur du drapeau (co-op)
  revealedCount: number; // pour la détection de victoire
  minesExposed: boolean;
};
```

`src/game/board.ts` fournit `idx`, `xOf`, `yOf`, `createBoard` et
`forEachNeighbor(n, i, fn)`.

## Commandes en jeu

| | |
|---|---|
| flèches | déplacer le curseur (la vue suit) |
| maj + flèches | sauter de 10 cases |
| `r` / `f` | révéler / drapeau |
| molette, `+` / `-` | zoom (centré sur le pointeur pour la molette) |
| glisser | déplacer la vue |
| `0` | vue globale |
| clic gauche / droit | révéler / drapeau |
| clic ou glisser sur la minimap | téléporter la vue |
| `1` / `2` | armer la Sonde / le Bouclier (bonus activés) |
| échap | annuler l'objet armé, sinon quitter la partie |

En fin de partie, **Rejouer** relance la même carte immédiatement et **Changer
de carte** revient à l'accueil. Les derniers paramètres joués sont mémorisés
(localStorage) et repré-remplissent l'accueil au prochain lancement.

## Bonus

Option **Bonus** à l'accueil (ou dans le lobby pour l'hôte), désactivée par
défaut : le démineur classique reste intact. Sur les grandes cartes, une partie
finit toujours par buter sur des situations où il faut deviner ; les bonus
servent à s'en sortir.

Ils sont cachés sous des cases sûres et ramassés en les découvrant, cascade
comprise :

| Bonus | Effet |
|---|---|
| 🔍 **Sonde** | en réserve ; posée sur une case, désamorce toutes les mines du carré 5×5 autour. Les cases sûres restent couvertes : la sonde donne l'information, la déduction reste au joueur. |
| 🛡 **Bouclier** | en réserve ; découvre sans risque le carré 3×3 (cases sûres révélées, mines désamorcées, drapeaux faux retirés). |
| ♥ **Vie** | immédiate, 3 au maximum ; une mine touchée est désamorcée au lieu de faire perdre. |
| 🪩 **Boule à facettes** | immédiate ; ouvre 4 zones vides au hasard sur la carte : de nouveaux fronts quand on tourne en rond. |

On pose un objet en l'armant (bouton du HUD ou touche `1` / `2`), puis d'un
clic, ou avec `r`, sur la case visée. La zone couverte s'affiche sous le
curseur. Une mine **désamorcée** s'affiche sur fond sarcelle, compte comme un
drapeau au compteur de bombes et ne peut plus être drapeautée.

Dosage : au plus un bonus pour 150 cases sûres **et** un pour 40 mines (les
devinettes suivent le nombre de mines, pas la taille de la carte). Répartition :
Sonde 40 %, Vie 25 %, Boule à facettes 20 %, Bouclier 15 %. Le premier clic ne
ramasse rien : sa cascade est gratuite, et sur une carte peu minée elle viderait
la carte de ses bonus d'un seul coup.

**Carte de test** : en développement (`npm run dev`), ou sur n'importe quel
déploiement avec `?test` dans l'URL, l'accueil propose « Test des bonus » : une
20×20 en solo avec 2 bonus de chaque type, placés après le premier clic en
bordure de la zone ouverte.

En co-op, la réserve est **commune** à la salle. Les bonus restent secrets
comme les mines : un client n'apprend l'existence d'un bonus qu'au moment où
il est ramassé, et une mine désamorcée est la seule position de mine publiée
avant la fin de partie.

## Comment ça tient à 1 M de cases

- **Culling** : seules les cases de `visibleRange` sont parcourues, jamais `n*n`.
- **Buckets par couleur** : un seul changement de `fillStyle` par classe de case,
  et les tableaux sont réutilisés d'une frame à l'autre (zéro allocation, zéro GC).
- **Trois niveaux de détail** (`src/render/palette.ts`) :
  - ≥ 14 px/case : reliefs, chiffres, drapeaux, mines. À la défaite, une mine
    correctement drapeautée s'affiche bombe + petit badge clair en coin : à
    taille pleine le drapeau masquait la bombe, et en rouge il se noyait dans
    le fond rouge de la mine.
  - 3–14 px : aplats teintés selon le nombre de bombes adjacentes
  - < 3 px : rendu par `ImageData` (1 pixel par case) agrandi d'un coup —
    en dézoom total le culling ne sert plus à rien, et 1 M de `fillRect`
    coûtait 258 ms/frame contre 16 ms par ce chemin.
- **Rendu hors React** : viewport, curseur et taille du canvas vivent dans
  `GameView` (`src/render/gameView.ts`), pas dans un state. Un pan ne provoque
  aucun re-render ; le canvas se redessine via un rAF à drapeau.
- **Minimap** : reconstruite au plus 5×/s, par vote majoritaire sur chaque bloc
  de cases (5 ms à 1 M de cases).

Mesures (Chrome headless, 1400×900, plateau rempli aléatoirement) :

| carte | démarrage + 1re image | frames pendant un pan (médiane / p95) |
|---|---|---|
| 100×100 (10 k) | 30 ms | 16,7 / 16,7 ms |
| 316×316 (100 k) | 19 ms | 16,7 / 16,7 ms |
| 500×500 (250 k) | 32 ms | 16,7 / 16,8 ms |
| 1000×1000 (1 M) | 94 ms | 16,7 / 16,7 ms |

Côté règles, sur une 1000×1000 : `placeMines` 10 ms, `computeAdjacency` 8 ms
(16 ms à 99 % de densité), cascade maximale 40 ms.

---

## Co-op (LAN ou serveur)

Plusieurs joueurs creusent **la même carte** en même temps, 8 joueurs maximum
par salle.

### Salles

Un même serveur héberge plusieurs parties indépendantes, chacune identifiée par
un **code de salle** (4 à 12 lettres ou chiffres, insensible à la casse). À
l'accueil, **Créer une salle** tire un code de 6 caractères sans caractères
ambigus, et **Rejoindre** entre dans la salle dont on a saisi le code. Le lobby
affiche un lien d'invitation (`https://…/?room=abc123`) qui pré-remplit ce code.

Une salle est créée au premier arrivant et libérée quand elle se vide : tout de
suite si elle est au lobby, sinon après le délai d'abandon (voir plus bas). Le
code fait office de clé : quiconque le connaît peut entrer.

### Architecture

Le **serveur fait autorité** : il détient le plateau et les positions des mines,
qui ne traversent le réseau qu'une fois la partie perdue. Un client ne reçoit
que ce qui a été révélé — `board.mines` y reste entièrement à zéro pendant toute
la partie, il n'y a donc rien à lire dans sa mémoire pour tricher.

`server/room.ts` importe `src/game/board.ts` et `src/game/rules.ts` **tels
quels** : ils sont purs (TypedArrays et boucles, aucune référence au DOM) et
tournent directement dans Node. Il n'y a pas deux implémentations des règles à
tenir synchronisées.

Côté client, `Session` (`src/game/session.ts`) masque la différence :
`LocalSession` joue en solo hors ligne, `NetworkSession` parle au serveur, et
`GameScreen` ne sait pas lequel des deux il affiche.

**Pas d'application optimiste** : on envoie, le serveur tranche, on applique son
écho. Sur un LAN le RTT est sous la milliseconde, sur un serveur distant chaque
clic attend un aller-retour (quelques dizaines de ms) — et ça supprime tout
besoin de rollback.

### L'encodage des deltas

Une cascade peut ouvrir un million de cases ; envoyer un million d'index est
exclu. La structure du démineur aide : l'intérieur d'une cascade est entièrement
en `adj = 0`, donc contigu ligne par ligne. `shared/protocol.ts` encode chaque
révélation en **séquences contiguës + les seules cases numérotées**.

Mesuré :

| cas | cases ouvertes | encodé | coût |
|---|---|---|---|
| 500×500, 1 % de mines | 247 348 | 42,7 Ko | 0,177 o/case |
| 1000×1000, 1 % de mines | 989 285 | 170,4 Ko | 0,176 o/case |
| plateau à une seule mine | 249 999 | 18 octets | — |

Soit ~22× moins que des index bruts sur 4 octets. Les séquences sont bon
marché ; ce sont les cases numérotées éparpillées dans la zone ouverte qui
dominent le volume.

Un joueur qui arrive en cours de partie ou se reconnecte reçoit un `SNAPSHOT`
(même encodage) et rejoint immédiatement.

### Présence

Chaque joueur a une couleur. Son curseur et son rectangle de vue sont diffusés à
10 Hz et affichés chez les autres — sur le plateau et sur la minimap. Les
drapeaux sont teintés par leur poseur (`board.flagOwner`). En solo tout vaut 0 :
un seul groupe de rendu, résultat strictement identique à avant.

### Règle en cas de mine

**Défaite partagée**, comme en solo : une mine et la partie est perdue pour tout
le monde, toutes les bombes sont dévoilées.

### Contrôle de la partie

Dans chaque salle, le premier joueur connecté est l'**hôte** (marqué ★). Si l'hôte part, le suivant
est promu automatiquement.

| Bouton | Qui | Effet |
|---|---|---|
| Rejouer | hôte, en fin de partie | même carte, plateau neuf |
| Changer de carte | hôte | ramène **tout le monde** au lobby pour en choisir une autre |
| Quitter | tout le monde | sort de la session ; la partie continue sans vous |

Quitter n'interrompt pas la partie : on peut revenir et reprendre là où elle en
est. Une partie que **plus personne** ne suit est libérée au bout d'une minute
et la salle retourne au lobby — assez long pour qu'un simple rechargement de
page ne la fasse pas perdre. Le délai est réglable par la variable
d'environnement `ABANDON_MS`.

### Déploiement

Le serveur est exposable sur Internet : il ignore les messages malformés, coupe
toute trame cliente au-delà de 16 Kio, et ferme par ping/pong (30 s) les
connexions mortes, qui sinon occuperaient une place dans leur salle.

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8080` | port HTTP + WebSocket (`/ws?room=<code>`) |
| `HOST` | `0.0.0.0` | interface d'écoute |
| `MAX_ROOMS` | `50` | salles ouvertes simultanément (une 1000×1000 pèse ~9 Mo) |
| `ABANDON_MS` | `60000` | délai avant de libérer une partie que plus personne ne suit |

**Docker / Coolify** — le `Dockerfile` compile client et serveur puis ne garde
que `ws` en dépendance. Dans Coolify, choisir le build pack *Dockerfile* et le
port exposé `8080`. Traefik, placé devant par Coolify, fournit le HTTPS et
relaie le WebSocket sans configuration : servie en https, la page se connecte
d'elle-même en `wss`. Sans Dockerfile (Nixpacks), `npm run build:all` puis
`npm start` font la même chose.

