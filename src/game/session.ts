import { COVERED, createBoard, type Board } from './board';
import { computeAdjacency, placeMines, reveal, revealAllMines, toggleFlag } from './rules';
import type { Peer, PlayerId, PlayerInfo, Rect } from '../../shared/protocol';

export type GameConfig = { n: number; mineCount: number };
export type Over = null | 'dead' | 'won';
export type Connection = 'local' | 'connecting' | 'online' | 'lost';

/**
 * Ce dont l'écran de jeu a besoin, qu'on joue seul ou à plusieurs.
 *
 * `GameScreen` ne connaît plus les règles : il lit un plateau, envoie des
 * intentions, et redessine quand on le lui dit. Ça permet au même écran de
 * servir une partie locale et une partie réseau sans un seul `if`.
 */
export interface Session {
  readonly board: Board;
  readonly over: Over;
  readonly remaining: number | null;
  /** Vide en solo : le HUD n'affiche la liste que s'il y a du monde. */
  readonly players: PlayerInfo[];
  readonly peers: Peer[];
  readonly selfId: PlayerId;
  readonly connection: Connection;
  /** Faux pour un invité en réseau : seul l'hôte relance. */
  readonly canRestart: boolean;
  readonly clockRunning: boolean;
  elapsedMs(): number;
  reveal(i: number): void;
  flag(i: number): void;
  moveCursor(x: number, y: number, view: Rect): void;
  /** Le plateau a changé : redessiner le canvas. Renvoie le désabonnement. */
  subscribeBoard(fn: () => void): () => void;
  /** Statut / joueurs / compteur ont changé : re-render React. */
  subscribeState(fn: () => void): () => void;
  /** Seuls les curseurs/vues des autres ont bougé. Canal séparé du plateau :
   *  la présence change 10 fois par seconde et ne doit surtout pas invalider
   *  le cache de la minimap, qui se reconstruit en O(n²). */
  subscribePresence(fn: () => void): () => void;
  dispose(): void;
}

/**
 * Partie solo. Reprend exactement la logique qui vivait dans `GameScreen`,
 * y compris le premier clic sûr et le garde sur les cases non couvertes.
 */
export class LocalSession implements Session {
  readonly board: Board;
  over: Over = null;
  remaining: number | null;
  readonly players: PlayerInfo[] = [];
  readonly peers: Peer[] = [];
  readonly selfId = 0;
  readonly connection: Connection = 'local';
  readonly canRestart = true;
  clockRunning = false;

  private boardListeners = new Set<() => void>();
  private stateListeners = new Set<() => void>();

  subscribeBoard(fn: () => void): () => void {
    this.boardListeners.add(fn);
    return () => this.boardListeners.delete(fn);
  }
  subscribeState(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  subscribePresence(): () => void {
    // Personne d'autre en solo : rien ne sera jamais émis.
    return () => {};
  }
  private emitBoard(): void {
    for (const fn of this.boardListeners) fn();
  }
  private emitState(): void {
    for (const fn of this.stateListeners) fn();
  }

  /** placeMines/computeAdjacency ne tournent qu'au premier reveal, pour que la
   *  première case cliquée puisse être garantie sans mine. */
  private seeded = false;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;

  constructor(config: GameConfig) {
    this.board = createBoard(config.n, config.mineCount);
    this.remaining = this.board.mineCount;
  }

  elapsedMs(): number {
    if (this.startedAt === null) return 0;
    return (this.stoppedAt ?? performance.now()) - this.startedAt;
  }

  private startClock(): void {
    if (this.startedAt !== null) return;
    this.startedAt = performance.now();
    this.clockRunning = true;
    this.emitState();
  }

  private finish(over: Exclude<Over, null>): void {
    this.over = over;
    this.stoppedAt = performance.now();
    this.clockRunning = false;
    this.emitState();
  }

  reveal(i: number): void {
    if (this.over) return;
    // Une case déjà révélée ou drapeautée ne doit consommer ni le chrono ni la
    // garantie de premier clic sûr : sans ce garde, un « r » sur une case
    // drapeautée sèmerait le plateau autour d'elle sans rien révéler, et le
    // premier vrai reveal, ailleurs, pourrait tomber sur une mine.
    if (this.board.state[i] !== COVERED) return;
    if (!this.seeded) {
      this.seeded = true;
      placeMines(this.board, i);
      computeAdjacency(this.board);
    }
    this.startClock();
    const outcome = reveal(this.board, i);
    if (outcome === 'boom') {
      revealAllMines(this.board);
      this.finish('dead');
    } else if (outcome === 'win') {
      this.finish('won');
    }
    this.emitBoard();
  }

  flag(i: number): void {
    if (this.over) return;
    this.startClock();
    const delta = toggleFlag(this.board, i);
    if (delta === 0) return;
    if (this.remaining !== null) this.remaining -= delta;
    this.emitBoard();
    this.emitState();
  }

  moveCursor(): void {
    /* personne à prévenir en solo */
  }

  dispose(): void {
    /* rien à libérer */
  }
}
