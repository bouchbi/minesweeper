import type { Board } from './board';
import { GameEngine, type ActionResult, type GameConfig } from './engine';
import {
  PLAYER_COLORS,
  type EndStat,
  type GameEvent,
  type Inventory,
  type Item,
  type Peer,
  type PlayerId,
  type PlayerInfo,
  type RecordInfo,
  type Rect,
} from '../../shared/protocol';

export type { GameConfig };
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
  /** Vies et objets en réserve ; null quand la partie se joue sans bonus. */
  readonly inventory: Inventory | null;
  /** Vide en solo : le HUD n'affiche la liste que s'il y a du monde. */
  readonly players: PlayerInfo[];
  readonly peers: Peer[];
  readonly selfId: PlayerId;
  readonly connection: Connection;
  /** Faux pour un invité en réseau : seul l'hôte relance. */
  readonly canRestart: boolean;
  readonly clockRunning: boolean;
  /** Compteurs par joueur, connus une fois la partie finie (null avant). */
  readonly endStats: EndStat[] | null;
  /** Place au classement obtenue par cette victoire ; toujours null en solo
   *  local, qui n'est pas classé (le navigateur pourrait tout truquer). */
  readonly record: RecordInfo | null;
  /** Adresse du classement (`/api/records`) ; null hors ligne. */
  readonly recordsUrl: string | null;
  /** Inscrit son nom sur le record solo qui vient d'être établi. */
  nameRecord(name: string): void;
  elapsedMs(): number;
  reveal(i: number): void;
  flag(i: number): void;
  /** Pose un objet de la réserve sur la case `i`. */
  use(item: Item, i: number): void;
  moveCursor(x: number, y: number, view: Rect): void;
  /** Le plateau a changé : redessiner le canvas. Renvoie le désabonnement. */
  subscribeBoard(fn: () => void): () => void;
  /** Statut / joueurs / compteur ont changé : re-render React. */
  subscribeState(fn: () => void): () => void;
  /** Seuls les curseurs/vues des autres ont bougé. Canal séparé du plateau :
   *  la présence change 10 fois par seconde et ne doit surtout pas invalider
   *  le cache de la minimap, qui se reconstruit en O(n²). */
  subscribePresence(fn: () => void): () => void;
  /** Bonus ramassés, objets posés, vies perdues : messages et flashs. */
  subscribeEvents(fn: (events: GameEvent[]) => void): () => void;
  /** Cases ouvertes par l'action dont les événements sont en cours de
   *  diffusion. Valable seulement pendant les rappels de `subscribeEvents` :
   *  c'est ce qui permet de retrouver les cases d'une zone de boule à
   *  facettes sans les confondre avec celles déjà ouvertes avant. */
  readonly lastOpened: ArrayLike<number>;
  dispose(): void;
}

/**
 * Partie solo : les règles vivent dans `GameEngine`, la session n'ajoute que
 * le chrono et les notifications.
 */
export class LocalSession implements Session {
  private readonly engine: GameEngine;
  readonly players: PlayerInfo[] = [];
  readonly peers: Peer[] = [];
  readonly selfId = 0;
  readonly connection: Connection = 'local';
  readonly canRestart = true;
  clockRunning = false;
  endStats: EndStat[] | null = null;
  readonly record = null;
  readonly recordsUrl = null;

  private boardListeners = new Set<() => void>();
  private stateListeners = new Set<() => void>();
  private eventListeners = new Set<(events: GameEvent[]) => void>();

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
  subscribeEvents(fn: (events: GameEvent[]) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
  private emitBoard(): void {
    for (const fn of this.boardListeners) fn();
  }
  private emitState(): void {
    for (const fn of this.stateListeners) fn();
  }

  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  lastOpened: ArrayLike<number> = [];

  constructor(config: GameConfig) {
    this.engine = new GameEngine(config);
  }

  get board(): Board {
    return this.engine.board;
  }
  get over(): Over {
    return this.engine.over;
  }
  get remaining(): number {
    return this.engine.remaining;
  }
  get inventory(): Inventory | null {
    return this.engine.inventory;
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

  /** Une case déjà révélée ou drapeautée renvoie null : elle ne consomme ni
   *  le chrono ni la garantie de premier clic sûr. */
  reveal(i: number): void {
    const result = this.engine.reveal(i);
    if (!result) return;
    this.startClock();
    this.apply(result);
  }

  flag(i: number): void {
    if (this.engine.over) return;
    this.startClock();
    if (this.engine.flag(i) === 0) return;
    this.emitBoard();
    this.emitState();
  }

  use(item: Item, i: number): void {
    const result = this.engine.use(item, i);
    if (result) this.apply(result);
  }

  private apply(result: ActionResult): void {
    if (result.outcome) {
      this.stoppedAt = performance.now();
      this.clockRunning = false;
      this.endStats = [...this.engine.stats()].map(([id, st]) => ({ ...st, id, name: 'Toi', color: PLAYER_COLORS[1] }));
    }
    if (result.events.length > 0) {
      this.lastOpened = result.opened;
      for (const fn of this.eventListeners) fn(result.events);
      this.lastOpened = [];
    }
    if (result.outcome || result.inventoryChanged) this.emitState();
    this.emitBoard();
  }

  moveCursor(): void {
    /* personne à prévenir en solo */
  }

  nameRecord(): void {
    /* solo local : jamais classé */
  }

  dispose(): void {
    /* rien à libérer */
  }
}
