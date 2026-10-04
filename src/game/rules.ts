import {
  BONUS_DISCO,
  BONUS_HEART,
  BONUS_NONE,
  BONUS_PROBE,
  BONUS_SHIELD,
  COVERED,
  DEFUSED,
  FLAGGED,
  REVEALED,
  forEachNeighbor,
  type Board,
} from './board';

/**
 * Règles du jeu : les seules fonctions du projet qui mutent `board.mines`,
 * `board.state`, `board.adj` et `board.bonus`. Tout le reste (rendu,
 * viewport, minimap, HUD) se contente de lire ces tableaux.
 */

/* ─────────────────────────────────────────────────────────────────────────
   Placement des mines
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Place exactement `board.mineCount` mines, en épargnant la case du premier
 * clic (et son voisinage quand la densité le permet).
 *
 * Utilise l'échantillonnage séquentiel de Knuth (algorithme S) : une seule
 * passe sur la grille, chaque case candidate étant retenue avec la probabilité
 * `mines restantes / candidates restantes`. Le tirage est uniforme sur tous
 * les placements possibles, le compte est exact, et **rien n'est alloué** —
 * là où un Fisher-Yates demanderait un Int32Array de 4 Mo sur une 1000×1000.
 *
 * Fonctionne à n'importe quelle densité, y compris 99 mines pour 100 cases,
 * contrairement à un tirage par rejet qui s'effondre au-delà de ~70 %.
 */
export function placeMines(board: Board, safeIndex: number): void {
  const { n, mines, mineCount } = board;
  const total = n * n;
  mines.fill(0);
  if (mineCount <= 0) return;

  // ── Zone épargnée autour du premier clic ────────────────────────────────
  // Le bloc 3×3 si la densité le permet (le premier clic ouvre alors une
  // cascade, comme dans le démineur classique), sinon la seule case cliquée,
  // sinon rien du tout — à mineCount == total il n'y a plus de case sûre.
  let x0 = 0;
  let x1 = -1; // rectangle vide par défaut
  let y0 = 0;
  let y1 = -1;
  let safeCount = 0;

  if (safeIndex >= 0 && safeIndex < total) {
    const sx = safeIndex % n;
    const sy = (safeIndex / n) | 0;
    const bx0 = sx > 0 ? sx - 1 : 0;
    const bx1 = sx < n - 1 ? sx + 1 : n - 1;
    const by0 = sy > 0 ? sy - 1 : 0;
    const by1 = sy < n - 1 ? sy + 1 : n - 1;
    const blockSize = (bx1 - bx0 + 1) * (by1 - by0 + 1);

    if (total - blockSize >= mineCount) {
      x0 = bx0; x1 = bx1; y0 = by0; y1 = by1;
      safeCount = blockSize;
    } else if (total - 1 >= mineCount) {
      x0 = x1 = sx; y0 = y1 = sy;
      safeCount = 1;
    }
  }

  // ── Algorithme S ────────────────────────────────────────────────────────
  let remaining = mineCount;
  let candidates = total - safeCount;

  for (let y = 0; y < n && remaining > 0; y++) {
    const row = y * n;
    const rowIsSafe = y >= y0 && y <= y1;
    for (let x = 0; x < n; x++) {
      if (rowIsSafe && x >= x0 && x <= x1) continue;
      // Quand remaining == candidates la condition est toujours vraie : les
      // dernières candidates sont toutes minées, le compte tombe juste.
      if (Math.random() * candidates < remaining) {
        mines[row + x] = 1;
        if (--remaining === 0) break;
      }
      candidates--;
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Nombre de mines adjacentes
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Remplit `board.adj[i]` avec le nombre de mines adjacentes à chaque case.
 *
 * On itère sur les mines et on incrémente leurs voisines, plutôt que d'itérer
 * sur les cases en comptant leurs voisines : le coût suit le nombre de mines
 * au lieu d'être systématiquement 8·n².
 */
export function computeAdjacency(board: Board): void {
  const { n, mines, adj } = board;
  adj.fill(0);
  const last = n - 1;

  for (let y = 0; y < n; y++) {
    const row = y * n;
    const yA = y > 0 ? y - 1 : 0;
    const yB = y < last ? y + 1 : last;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      if (mines[i] === 0) continue;
      const xA = x > 0 ? x - 1 : 0;
      const xB = x < last ? x + 1 : last;
      for (let yy = yA; yy <= yB; yy++) {
        const r = yy * n;
        for (let xx = xA; xx <= xB; xx++) {
          const j = r + xx;
          if (j !== i) adj[j]++;
        }
      }
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Révélation
   ───────────────────────────────────────────────────────────────────────── */

/* File de la cascade, réutilisée entre les appels et entre les parties : sur
   une carte 1000×1000 une seule cascade peut toucher ~1 M de cases, et une
   récursion exploserait la pile d'appels. */
let cascade: Int32Array | null = null;
/** Nombre d'entrées utiles dans `cascade` après le dernier `reveal`. */
let openedCount = 0;

/**
 * Révèle la case `i`, en propageant sur les cases adjacentes tant qu'on
 * traverse des cases à 0 mine adjacente.
 *
 * Le parcours est en LARGEUR d'abord : le curseur de lecture avance sans
 * jamais reculer, si bien que le tampon contient à la fin exactement les cases
 * ouvertes par l'appel — c'est ce que `lastOpened()` renvoie, sans mémoire ni
 * calcul supplémentaires. Le mode co-op en a besoin pour diffuser les deltas ;
 * en solo ça ne coûte rien.
 *
 * @returns 'boom' si la case portait une mine,
 *          'win'  si c'était la dernière case sûre du plateau,
 *          'noop' si la case était déjà révélée ou drapeautée,
 *          'ok'   sinon.
 */
export function reveal(board: Board, i: number): 'ok' | 'boom' | 'win' | 'noop' {
  const { n, state, mines, adj } = board;
  const total = n * n;
  openedCount = 0;
  if (i < 0 || i >= total) return 'noop';
  // Une case drapeautée est protégée du clic : c'est tout l'intérêt du drapeau.
  if (state[i] !== COVERED) return 'noop';

  if (!cascade || cascade.length < total) cascade = new Int32Array(total);
  const queue = cascade;

  if (mines[i] === 1) {
    state[i] = REVEALED;
    // Consigné aussi : le serveur doit pouvoir diffuser cette case-là.
    queue[0] = i;
    openedCount = 1;
    return 'boom';
  }

  const last = n - 1;

  // Les cases sont marquées à l'enfilement, jamais au défilement : chacune
  // n'entre donc qu'une fois dans la file, qui ne peut pas déborder.
  let head = 0;
  let tail = 0;
  queue[tail++] = i;
  state[i] = REVEALED;

  while (head < tail) {
    const c = queue[head++];
    // Une case numérotée ferme la cascade : on affiche le chiffre, on n'ouvre
    // pas ses voisines.
    if (adj[c] !== 0) continue;

    const x = c % n;
    const y = (c / n) | 0;
    const yA = y > 0 ? y - 1 : 0;
    const yB = y < last ? y + 1 : last;
    const xA = x > 0 ? x - 1 : 0;
    const xB = x < last ? x + 1 : last;

    for (let yy = yA; yy <= yB; yy++) {
      const r = yy * n;
      for (let xx = xA; xx <= xB; xx++) {
        const j = r + xx;
        // adj[c] == 0 garantit qu'aucune voisine n'est minée : inutile de
        // retester mines[j]. Les cases drapeautées, elles, sont préservées.
        if (state[j] !== COVERED) continue;
        state[j] = REVEALED;
        queue[tail++] = j;
      }
    }
  }

  openedCount = tail;
  board.revealedCount += tail;
  return board.revealedCount === total - board.mineCount ? 'win' : 'ok';
}

/**
 * Index des cases que le dernier `reveal` a fait passer à REVEALED, dans
 * l'ordre d'ouverture. Vide si l'appel a renvoyé 'noop'.
 *
 * ⚠ Vue sur un tampon interne : valable jusqu'au prochain appel à `reveal`.
 * À copier si le contenu doit survivre.
 */
export function lastOpened(): Int32Array {
  if (!cascade) return new Int32Array(0);
  return cascade.subarray(0, openedCount);
}

/* ─────────────────────────────────────────────────────────────────────────
   Drapeaux
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Bascule COVERED ↔ FLAGGED. Une case déjà révélée est intouchable.
 *
 * @returns +1 si un drapeau vient d'être posé, -1 s'il vient d'être retiré,
 *           0 si rien n'a changé. Alimente le compteur de bombes du HUD.
 */
export function toggleFlag(board: Board, i: number): -1 | 0 | 1 {
  const { state } = board;
  if (i < 0 || i >= state.length) return 0;
  // Une mine désamorcée est déjà connue : un drapeau dessus n'a pas de sens,
  // et la repasser en FLAGGED la ferait compter deux fois au compteur.
  if (state[i] === REVEALED || state[i] === DEFUSED) return 0;
  if (state[i] === FLAGGED) {
    state[i] = COVERED;
    return -1;
  }
  state[i] = FLAGGED;
  return 1;
}

/* ─────────────────────────────────────────────────────────────────────────
   Fin de partie
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Découvre le plateau après un 'boom'.
 *
 * Les cases drapeautées gardent leur état FLAGGED : c'est `minesExposed` qui
 * autorise le rendu à dessiner la bombe SOUS le drapeau, pour que le joueur
 * voie d'un coup d'œil lesquels de ses drapeaux étaient justes.
 *
 * Terminal : n'entretient pas `revealedCount`, aucune victoire ne peut plus
 * être détectée après coup.
 */
export function revealAllMines(board: Board): void {
  const { state, mines } = board;
  for (let i = 0; i < mines.length; i++) {
    if (mines[i] === 1 && state[i] === COVERED) state[i] = REVEALED;
  }
  board.minesExposed = true;
}

/* ─────────────────────────────────────────────────────────────────────────
   Bonus
   ───────────────────────────────────────────────────────────────────────── */

/** Au plus un bonus pour ce nombre de cases sûres… */
export const BONUS_EVERY = 150;
/** …et pour ce nombre de mines. Les situations où il faut deviner suivent le
 *  nombre de mines, pas la taille de la carte : sans ce plafond, une grande
 *  carte peu minée (qui se résout presque seule) croulerait sous les bonus. */
export const BONUS_PER_MINES = 40;
/** Côté du carré révélé par la sonde : 2 → 5×5. */
export const PROBE_RADIUS = 2;
/** Côté du carré découvert par le bouclier : 1 → 3×3. */
export const SHIELD_RADIUS = 1;
/** Zones vides ouvertes par une boule à facettes. */
export const DISCO_ZONES = 4;

/** Répartition des bonus tirés, en poids relatifs. */
const BONUS_WEIGHTS: readonly (readonly [number, number])[] = [
  [BONUS_PROBE, 40],
  [BONUS_HEART, 25],
  [BONUS_DISCO, 20],
  [BONUS_SHIELD, 15],
];
const BONUS_WEIGHT_TOTAL = BONUS_WEIGHTS.reduce((t, [, w]) => t + w, 0);

function drawBonusKind(): number {
  let r = Math.random() * BONUS_WEIGHT_TOTAL;
  for (const [kind, w] of BONUS_WEIGHTS) {
    if (r < w) return kind;
    r -= w;
  }
  return BONUS_WEIGHTS[0][0];
}

/**
 * Cache des bonus sous des cases sûres, après `placeMines`.
 *
 * Même algorithme S que les mines : une passe, tirage uniforme, compte exact,
 * aucune allocation. Le bloc 3×3 du premier clic est épargné : sans ça, la
 * première cascade ramasserait d'un coup tout ce qui traîne autour du départ.
 */
export function placeBonuses(board: Board, safeIndex: number): void {
  const { n, mines, bonus } = board;
  bonus.fill(BONUS_NONE);
  const sx = safeIndex % n;
  const sy = (safeIndex / n) | 0;
  const spared = (x: number, y: number) => Math.abs(x - sx) <= 1 && Math.abs(y - sy) <= 1;

  let candidates = 0;
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) if (!mines[row + x] && !spared(x, y)) candidates++;
  }

  let remaining = Math.round(Math.min(candidates / BONUS_EVERY, board.mineCount / BONUS_PER_MINES));
  for (let y = 0; y < n && remaining > 0; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      if (mines[row + x] || spared(x, y)) continue;
      if (Math.random() * candidates < remaining) {
        bonus[row + x] = drawBonusKind();
        if (--remaining === 0) break;
      }
      candidates--;
    }
  }
}

/** Ramasse le bonus de la case : le renvoie et l'efface du plateau. */
export function takeBonus(board: Board, i: number): number {
  const b = board.bonus[i];
  if (b !== BONUS_NONE) board.bonus[i] = BONUS_NONE;
  return b;
}

/**
 * Neutralise la mine `i` : elle passe en DEFUSED, quel que soit son état
 * (couverte, drapeautée, ou tout juste révélée par un 'boom' rattrapé par
 * une vie).
 *
 * @returns l'état précédent de la case, ou -1 si ce n'est pas une mine ou
 *          qu'elle était déjà désamorcée. L'appelant en a besoin pour tenir
 *          son compte de drapeaux.
 */
export function defuse(board: Board, i: number): number {
  const { mines, state } = board;
  if (mines[i] !== 1 || state[i] === DEFUSED) return -1;
  const prev = state[i];
  state[i] = DEFUSED;
  board.flagOwner[i] = 0;
  return prev;
}

/** Appelle `fn` pour chaque case du carré de rayon `r` centré sur `i`. */
function forEachInSquare(n: number, i: number, r: number, fn: (j: number) => void): void {
  const x = i % n;
  const y = (i / n) | 0;
  const x0 = Math.max(0, x - r);
  const x1 = Math.min(n - 1, x + r);
  const y0 = Math.max(0, y - r);
  const y1 = Math.min(n - 1, y + r);
  for (let yy = y0; yy <= y1; yy++) {
    const row = yy * n;
    for (let xx = x0; xx <= x1; xx++) fn(row + xx);
  }
}

/**
 * Sonde : désamorce toutes les mines du carré 5×5 autour de `i`. Les cases
 * sûres restent telles quelles — la sonde donne l'information, le joueur
 * garde la déduction.
 *
 * @param outDefused reçoit les mines désamorcées
 * @returns le nombre de drapeaux absorbés (posés sur des mines désormais
 *          désamorcées)
 */
export function probe(board: Board, i: number, outDefused: number[]): number {
  let flagsTaken = 0;
  forEachInSquare(board.n, i, PROBE_RADIUS, (j) => {
    const prev = defuse(board, j);
    if (prev === -1) return;
    outDefused.push(j);
    if (prev === FLAGGED) flagsTaken++;
  });
  return flagsTaken;
}

/**
 * Bouclier, première moitié : désamorce les mines du carré 3×3 autour de `i`
 * et retire les drapeaux posés à tort sur des cases sûres.
 *
 * La révélation des cases sûres est laissée à l'appelant, via `reveal` : il
 * doit pouvoir en suivre les cascades et les bonus ramassés.
 *
 * @param outDefused reçoit les mines désamorcées
 * @param outSafe    reçoit les cases sûres encore couvertes, à révéler
 * @returns le nombre de drapeaux retirés (sur mine comme sur case sûre)
 */
export function shield(board: Board, i: number, outDefused: number[], outSafe: number[]): number {
  const { mines, state, flagOwner } = board;
  let flagsTaken = 0;
  forEachInSquare(board.n, i, SHIELD_RADIUS, (j) => {
    if (mines[j]) {
      const prev = defuse(board, j);
      if (prev === -1) return;
      outDefused.push(j);
      if (prev === FLAGGED) flagsTaken++;
      return;
    }
    if (state[j] === FLAGGED) {
      state[j] = COVERED;
      flagOwner[j] = 0;
      flagsTaken++;
    }
    if (state[j] === COVERED) outSafe.push(j);
  });
  return flagsTaken;
}

/**
 * Boule à facettes : choisit une case vide (adj = 0) encore couverte, au
 * hasard sur toute la carte — la révéler ouvre une zone entière. À défaut de
 * case vide, n'importe quelle case sûre couverte.
 *
 * Deux passes sans tirage par case (compter, puis aller à la k-ième) : un
 * échantillonnage de réservoir appellerait Math.random un million de fois.
 *
 * @returns l'index choisi, ou -1 s'il ne reste aucune case sûre couverte.
 */
export function randomOpening(board: Board): number {
  const { mines, state, adj } = board;
  const total = mines.length;
  for (const wantEmpty of [true, false]) {
    let count = 0;
    for (let j = 0; j < total; j++) {
      if (state[j] === COVERED && !mines[j] && (!wantEmpty || adj[j] === 0)) count++;
    }
    if (count === 0) continue;
    let k = Math.floor(Math.random() * count);
    for (let j = 0; j < total; j++) {
      if (state[j] === COVERED && !mines[j] && (!wantEmpty || adj[j] === 0) && k-- === 0) return j;
    }
  }
  return -1;
}

function shuffle(a: number[]): void {
  for (let k = a.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [a[k], a[j]] = [a[j], a[k]];
  }
}

/**
 * Carte de test : place exactement les bonus `kinds`, dans l'ordre, sur des
 * cases sûres encore couvertes — en priorité en bordure de la zone déjà
 * ouverte, pour qu'on tombe dessus dès les premières déductions. À appeler
 * APRÈS la première révélation.
 */
export function placeTestBonuses(board: Board, kinds: readonly number[]): void {
  const { n, mines, state, bonus } = board;
  bonus.fill(BONUS_NONE);
  const frontier: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < state.length; i++) {
    if (state[i] !== COVERED || mines[i]) continue;
    let edge = false;
    forEachNeighbor(n, i, (j) => {
      if (state[j] === REVEALED) edge = true;
    });
    (edge ? frontier : rest).push(i);
  }
  shuffle(frontier);
  shuffle(rest);
  const pool = frontier.concat(rest);
  for (let k = 0; k < kinds.length && k < pool.length; k++) bonus[pool[k]] = kinds[k];
}
