import {
  BONUS_DISCO,
  BONUS_HEART,
  BONUS_NONE,
  BONUS_SHIELD,
  COVERED,
  createBoard,
  type Board,
} from './board';
import {
  computeAdjacency,
  defuse,
  DISCO_ZONES,
  lastOpened,
  placeBonuses,
  placeMines,
  placeTestBonuses,
  randomOpening,
  reveal,
  revealAllMines,
  shield,
  takeBonus,
  toggleFlag,
} from './rules';
import type { GameEvent, Inventory, Item, PlayerId } from '../../shared/protocol';

export type GameConfig = {
  n: number;
  mineCount: number;
  bonus: boolean;
  /** Carte de test (solo) : un exemplaire garanti de chaque bonus, voir
   *  TEST_BONUSES. Jamais transmis au serveur. */
  testBonuses?: boolean;
};

/** Bonus d'une carte de test : deux de chaque, un de chaque d'abord pour
 *  qu'ils soient les premiers placés en bordure de la zone ouverte. */
const TEST_BONUSES = [
  BONUS_SHIELD, BONUS_DISCO, BONUS_HEART,
  BONUS_SHIELD, BONUS_DISCO, BONUS_HEART,
];
export type Outcome = 'dead' | 'won';

/** Vies cumulables au plus : au-delà, deviner ne coûterait plus rien. */
export const MAX_LIVES = 3;

export type ActionResult = {
  /** Cases passées à REVEALED par l'action, dans l'ordre d'ouverture. Vue sur
   *  un tampon interne : valable jusqu'à l'action suivante. */
  opened: Int32Array;
  /** Mines passées à DEFUSED par l'action. */
  defused: number[];
  events: GameEvent[];
  /** La réserve ou le compteur de bombes a changé. */
  inventoryChanged: boolean;
  /** Fin de partie provoquée par cette action, sinon null. */
  outcome: Outcome | null;
};

/**
 * Une partie, indépendamment de qui la joue : premier clic sûr, vies,
 * réserve d'objets, effets des bonus, fin de partie.
 *
 * Pur (aucune horloge, aucun DOM, aucun réseau) : `LocalSession` l'appelle
 * directement, `server/room.ts` l'appelle puis diffuse le résultat. Les deux
 * ne peuvent donc pas diverger sur les règles. Le chrono reste à l'appelant,
 * qui seul sait quelle horloge utiliser.
 */
export class GameEngine {
  readonly board: Board;
  /** null quand la partie se joue sans bonus. */
  readonly inventory: Inventory | null;
  over: Outcome | null = null;
  private readonly testBonuses: boolean;

  /** placeMines/computeAdjacency ne tournent qu'au premier reveal, pour que la
   *  première case cliquée puisse être garantie sans mine. */
  private seeded = false;
  private flags = 0;
  private defusedCount = 0;

  /* État de l'action en cours, remis à zéro par `begin`. */
  private opened: Int32Array;
  private openedCount = 0;
  private defused: number[] = [];
  private events: GameEvent[] = [];
  private inventoryChanged = false;
  /** Cases des boules à facettes ramassées pendant l'action, pas encore
   *  déclenchées. */
  private pendingDisco: number[] = [];
  private firstAction = false;
  private by: PlayerId = 0;

  constructor(config: GameConfig) {
    this.board = createBoard(config.n, config.mineCount);
    this.testBonuses = config.testBonuses === true;
    this.inventory = config.bonus || this.testBonuses ? { lives: 0, shields: 0 } : null;
    // Chaque case n'est ouverte qu'une fois par partie : n² suffit toujours,
    // même pour une boule à facettes qui en déclenche une autre.
    this.opened = new Int32Array(config.n * config.n);
  }

  /** Mines restant à trouver : total - drapeaux posés - mines désamorcées.
   *  Négatif si le joueur pose plus de drapeaux qu'il n'y a de mines. */
  get remaining(): number {
    return this.board.mineCount - this.flags - this.defusedCount;
  }

  get started(): boolean {
    return this.seeded;
  }

  private inBounds(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.board.state.length;
  }

  /* ── Actions ──────────────────────────────────────────────────────── */

  /** @returns null si l'action ne change rien (case déjà ouverte, drapeautée,
   *  partie finie) : ni le chrono ni le premier clic sûr ne sont consommés. */
  reveal(i: number, by: PlayerId = 0): ActionResult | null {
    const { board } = this;
    if (this.over || !this.inBounds(i) || board.state[i] !== COVERED) return null;
    this.begin(by);
    if (!this.seeded) {
      this.seeded = true;
      this.firstAction = true;
      placeMines(board, i);
      computeAdjacency(board);
      if (this.inventory && !this.testBonuses) placeBonuses(board, i);
    }
    if (this.open(i) === 'boom') this.boom(i);
    // Placés après la cascade du premier clic, qui ne ramasse rien : sinon ils
    // pourraient y être perdus.
    if (this.firstAction && this.testBonuses) placeTestBonuses(board, TEST_BONUSES);
    this.drainDisco();
    return this.finish();
  }

  /** @returns +1 drapeau posé, -1 retiré, 0 rien. */
  flag(i: number, by: PlayerId = 0): -1 | 0 | 1 {
    if (this.over || !this.inBounds(i)) return 0;
    const delta = toggleFlag(this.board, i);
    if (delta === 0) return 0;
    this.flags += delta;
    this.board.flagOwner[i] = delta === 1 ? by : 0;
    return delta;
  }

  /** Pose un objet de la réserve sur la case `i`.
   *  @returns null si l'objet n'est pas disponible ou la partie pas en cours. */
  use(item: Item, i: number, by: PlayerId = 0): ActionResult | null {
    const inv = this.inventory;
    if (this.over || !this.seeded || !inv || !this.inBounds(i)) return null;
    if (item !== 'shield' || inv.shields <= 0) return null;

    this.begin(by);
    this.inventoryChanged = true;
    this.events.push({ kind: 'use', item, i, by });

    inv.shields--;
    const safe: number[] = [];
    this.flags -= shield(this.board, i, this.defused, safe);
    this.defusedCount += this.defused.length;
    // Les mines du losange sont désamorcées avant : ces révélations ne
    // peuvent pas faire perdre. Une case peut avoir été ouverte entre-temps
    // par la cascade d'une voisine, d'où le test.
    for (const j of safe) if (this.board.state[j] === COVERED) this.open(j);
    this.drainDisco();
    return this.finish();
  }

  /* ── Mécanique interne ────────────────────────────────────────────── */

  private begin(by: PlayerId): void {
    this.by = by;
    this.openedCount = 0;
    // Tableaux neufs à chaque action : l'appelant peut garder ceux du
    // résultat précédent sans qu'on les réécrive sous ses pieds.
    this.defused = [];
    this.events = [];
    this.inventoryChanged = false;
    this.pendingDisco = [];
    this.firstAction = false;
  }

  /** `reveal` + accumulation des cases ouvertes + ramassage des bonus. */
  private open(i: number): ReturnType<typeof reveal> {
    const from = this.openedCount;
    const outcome = reveal(this.board, i);
    const got = lastOpened();
    this.opened.set(got, this.openedCount);
    this.openedCount += got.length;
    this.collect(from);
    return outcome;
  }

  private collect(from: number): void {
    const inv = this.inventory;
    // Premier clic : sa cascade est gratuite (aucune déduction), elle ne
    // ramasse rien. Sur une carte peu minée elle ouvre presque tout et
    // viderait la carte de ses bonus d'un seul coup. Ceux qu'elle découvre
    // sont perdus.
    if (this.firstAction) {
      for (let k = from; k < this.openedCount; k++) takeBonus(this.board, this.opened[k]);
      return;
    }
    if (!inv) return;
    for (let k = from; k < this.openedCount; k++) {
      const i = this.opened[k];
      const bonus = takeBonus(this.board, i);
      if (bonus === BONUS_NONE) continue;
      this.events.push({ kind: 'pickup', bonus, i, by: this.by });
      this.inventoryChanged = true;
      if (bonus === BONUS_HEART) inv.lives = Math.min(MAX_LIVES, inv.lives + 1);
      else if (bonus === BONUS_SHIELD) inv.shields++;
      else if (bonus === BONUS_DISCO) this.pendingDisco.push(i);
    }
  }

  /** Mine touchée : une vie la désamorce, sinon la partie est perdue. */
  private boom(i: number): void {
    const inv = this.inventory;
    if (inv && inv.lives > 0) {
      inv.lives--;
      defuse(this.board, i);
      this.defused.push(i);
      this.defusedCount++;
      this.inventoryChanged = true;
      this.events.push({ kind: 'life', i, by: this.by });
      return;
    }
    revealAllMines(this.board);
    this.over = 'dead';
  }

  /** Boules à facettes ramassées pendant l'action. Une zone ouverte peut en
   *  contenir une autre : la boucle s'arrête quand plus rien n'est en attente. */
  private drainDisco(): void {
    for (let k = 0; k < this.pendingDisco.length; k++) {
      const from = this.pendingDisco[k];
      for (let z = 0; z < DISCO_ZONES; z++) {
        const j = randomOpening(this.board);
        if (j < 0) break;
        this.events.push({ kind: 'zone', i: j, from, by: this.by });
        this.open(j);
      }
    }
  }

  private finish(): ActionResult {
    const { board } = this;
    if (!this.over && board.revealedCount === board.state.length - board.mineCount) this.over = 'won';
    return {
      opened: this.opened.subarray(0, this.openedCount),
      defused: this.defused,
      events: this.events,
      inventoryChanged: this.inventoryChanged,
      outcome: this.over,
    };
  }
}
