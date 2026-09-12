import { COVERED, FLAGGED, REVEALED, type Board } from './board';

/**
 * Règles du jeu : les seules fonctions du projet qui mutent `board.mines`,
 * `board.state` et `board.adj`. Tout le reste (rendu, viewport, minimap, HUD)
 * se contente de lire ces tableaux.
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
  if (state[i] === REVEALED) return 0;
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
