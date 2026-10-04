/**
 * Modèle de plateau : des TypedArrays plates indexées par `i = y * n + x`.
 *
 * Coût mémoire : 5 octets par case (mines, state, adj, flagOwner, bonus).
 *   100×100  ->   50 Ko
 *   500×500  ->  1,2 Mo
 *  1000×1000 ->    5 Mo
 */

export const COVERED = 0;
export const REVEALED = 1;
export const FLAGGED = 2;
/** Mine connue et neutralisée (sonde, bouclier, ou vie consommée) : elle
 *  s'affiche, ne fait plus perdre, et ne peut plus recevoir de drapeau. */
export const DEFUSED = 3;

export type CellState = typeof COVERED | typeof REVEALED | typeof FLAGGED | typeof DEFUSED;

/* Bonus cachés sous des cases sûres, ramassés quand la case est découverte. */
export const BONUS_NONE = 0;
/** Objet : révèle les mines d'un carré 5×5. */
export const BONUS_PROBE = 1;
/** Objet : découvre sans risque un carré 3×3. */
export const BONUS_SHIELD = 2;
/** Immédiat : une vie de plus (dans la limite du maximum). */
export const BONUS_HEART = 3;
/** Immédiat : ouvre plusieurs zones vides au hasard sur la carte. */
export const BONUS_DISCO = 4;

export type Board = {
  /** Largeur ET hauteur : les cartes sont carrées. */
  n: number;
  /** Nombre total de mines demandé à la création. */
  mineCount: number;
  /** n*n valeurs 0|1. Rempli par `placeMines` (rules.ts). */
  mines: Uint8Array;
  /** n*n valeurs COVERED|REVEALED|FLAGGED|DEFUSED. Muté uniquement par rules.ts. */
  state: Uint8Array;
  /** n*n valeurs 0..8. Rempli par `computeAdjacency` (rules.ts). */
  adj: Uint8Array;
  /** n*n valeurs BONUS_*. Rempli par `placeBonuses` (rules.ts), vidé case par
   *  case au ramassage. Secret comme `mines` : en co-op il reste à zéro chez
   *  les clients, qui n'apprennent un bonus qu'au moment où il est ramassé. */
  bonus: Uint8Array;
  /** Nombre de cases REVEALED. Tenu à jour par `reveal` ; comparé à
   *  `n*n - mineCount` pour détecter la victoire en O(1). */
  revealedCount: number;
  /** Auteur du drapeau posé sur chaque case : identifiant de joueur 1..8,
   *  0 si aucun. Sert au co-op à teinter les drapeaux ; en solo tout reste à 0
   *  et le rendu est strictement identique. */
  flagOwner: Uint8Array;
  /** Passe à true à la défaite (`revealAllMines`). Tant que c'est false, le
   *  rendu n'a AUCUN moyen de savoir ce qui se cache sous un drapeau — c'est
   *  ce qui empêche d'y lire la position des mines en cours de partie. */
  minesExposed: boolean;
};

export const idx = (n: number, x: number, y: number): number => y * n + x;
export const xOf = (n: number, i: number): number => i % n;
export const yOf = (n: number, i: number): number => (i / n) | 0;

export function createBoard(n: number, mineCount: number): Board {
  const total = n * n;
  // Borné à total - 1 : il doit rester au moins une case sûre, sinon la cible
  // de victoire (`total - mineCount`) devient nulle ou négative et la partie
  // est ingagnable. L'UI valide déjà cette contrainte ; ceci garantit qu'un
  // Board est toujours cohérent quel que soit l'appelant.
  const count = Math.max(0, Math.min(mineCount, total - 1));
  return {
    n,
    mineCount: count,
    mines: new Uint8Array(total),
    state: new Uint8Array(total),
    adj: new Uint8Array(total),
    bonus: new Uint8Array(total),
    flagOwner: new Uint8Array(total),
    revealedCount: 0,
    minesExposed: false,
  };
}

/**
 * Appelle `fn` pour chacun des 8 voisins de `i` existant réellement
 * (gère les bords sans allocation ni modulo piégeux).
 */
export function forEachNeighbor(n: number, i: number, fn: (j: number) => void): void {
  const x = i % n;
  const y = (i / n) | 0;
  const xMin = x > 0 ? x - 1 : 0;
  const xMax = x < n - 1 ? x + 1 : n - 1;
  const yMin = y > 0 ? y - 1 : 0;
  const yMax = y < n - 1 ? y + 1 : n - 1;
  for (let yy = yMin; yy <= yMax; yy++) {
    const row = yy * n;
    for (let xx = xMin; xx <= xMax; xx++) {
      const j = row + xx;
      if (j !== i) fn(j);
    }
  }
}
