import { COVERED, FLAGGED, REVEALED, createBoard, type Board } from '../game/board';
import { revealAllMines } from '../game/rules';
import type { Connection as SessionConnection, Over, Session } from '../game/session';
import {
  applyMines,
  applyReveal,
  applySnapshot,
  FRAME_MINES,
  FRAME_REVEAL,
  FRAME_SNAPSHOT,
  type ClientMessage,
  type NetConfig,
  type Peer,
  type Phase,
  type PlayerId,
  type PlayerInfo,
  type Rect,
  type ServerMessage,
} from '../../shared/protocol';

/** Limite d'émission du curseur : inutile d'envoyer plus vite que le serveur
 *  ne rediffuse (10 Hz). */
const CURSOR_MS = 100;
const RECONNECT_MS = [250, 500, 1000, 2000, 4000];

/**
 * Client du mode co-op.
 *
 * Le plateau local est un miroir partiel de celui du serveur : `state` et
 * `adj` sont remplis au fil des révélations, et **`mines` reste entièrement à
 * zéro tant que la partie n'est pas perdue**. Il n'y a donc rien à lire dans la
 * mémoire du client pour tricher.
 */
export class NetworkSession implements Session {
  board: Board;
  config: NetConfig;
  selfId: PlayerId = 0;
  players: PlayerInfo[] = [];
  peers: Peer[] = [];
  phase: Phase = 'lobby';
  remaining: number | null = null;
  connection: SessionConnection = 'connecting';
  lastError: string | null = null;

  /** `over` et `clockRunning` complètent le contrat `Session` ; `phase` reste
   *  la source de vérité côté réseau (il connaît en plus l'état 'lobby'). */
  get over(): Over {
    return this.phase === 'dead' || this.phase === 'won' ? this.phase : null;
  }
  get canRestart(): boolean {
    return this.players.some((p) => p.id === this.selfId && p.isHost);
  }
  private boardListeners = new Set<() => void>();
  private stateListeners = new Set<() => void>();
  private presenceListeners = new Set<() => void>();

  /** Le plateau a changé : redessiner. Plusieurs composants peuvent écouter —
   *  un créneau unique laisserait le dernier monté écraser les précédents. */
  subscribeBoard(fn: () => void): () => void {
    this.boardListeners.add(fn);
    return () => this.boardListeners.delete(fn);
  }
  subscribeState(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  subscribePresence(fn: () => void): () => void {
    this.presenceListeners.add(fn);
    return () => this.presenceListeners.delete(fn);
  }
  private emitBoard(): void {
    for (const fn of this.boardListeners) fn();
  }
  private emitState(): void {
    for (const fn of this.stateListeners) fn();
  }
  private emitPresence(): void {
    for (const fn of this.presenceListeners) fn();
  }

  private ws: WebSocket | null = null;
  private name: string;
  private url: string;
  private disposed = false;
  private attempt = 0;

  /** Chrono : dernière valeur reçue du serveur + le temps écoulé localement
   *  depuis. Évite toute synchronisation d'horloge. */
  private serverElapsed = 0;
  private stampedAt = 0;
  /** Tenu à jour par `stampClock` au rythme des messages du serveur. */
  clockRunning = false;

  private lastCursorSent = 0;
  private pendingCursor: { x: number; y: number; view: Rect } | null = null;
  private lastSent: { x: number; y: number; view: Rect } | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, name: string, config: NetConfig) {
    this.url = url;
    this.name = name;
    this.config = config;
    this.board = createBoard(config.n, config.mineCount);
    this.connect();
  }

  /* ── Cycle de vie ─────────────────────────────────────────────────── */

  private connect(): void {
    if (this.disposed) return;
    this.connection = this.attempt === 0 ? 'connecting' : 'lost';
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.connection = 'online';
      this.send({ t: 'join', name: this.name });
      this.emitState();
    };
    ws.onmessage = (e: MessageEvent) => this.receive(e.data);
    ws.onclose = () => {
      if (this.disposed) return;
      this.connection = 'lost';
      this.emitState();
      const delay = RECONNECT_MS[Math.min(this.attempt++, RECONNECT_MS.length - 1)];
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      /* onclose suit toujours : la reconnexion est gérée là. */
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /* ── Actions ──────────────────────────────────────────────────────── */

  // Aucune application optimiste : on envoie, le serveur tranche, on applique
  // son écho. Sur un LAN c'est imperceptible, et ça supprime tout rollback.
  reveal(i: number): void {
    if (this.phase === 'playing') this.send({ t: 'reveal', i });
  }
  flag(i: number): void {
    if (this.phase === 'playing') this.send({ t: 'flag', i });
  }
  setConfig(config: NetConfig): void {
    this.send({ t: 'config', config });
  }
  start(): void {
    this.send({ t: 'start' });
  }
  restart(): void {
    this.send({ t: 'restart' });
  }
  /** Hôte : ramène tout le monde au lobby pour changer de carte. */
  backToLobby(): void {
    this.send({ t: 'lobby' });
  }

  /** Position du curseur et rectangle de vue, limités à 10 Hz. */
  moveCursor(x: number, y: number, view: Rect): void {
    if (this.phase !== 'playing') return;
    // Rien de neuf : ne pas réémettre. Chaque présence reçue provoque un
    // redessin, qui rappelle moveCursor — sans ce garde on entretiendrait une
    // boucle d'échos entre le client et le serveur.
    const last = this.lastSent;
    if (
      last &&
      last.x === x &&
      last.y === y &&
      last.view.x0 === view.x0 &&
      last.view.y0 === view.y0 &&
      last.view.x1 === view.x1 &&
      last.view.y1 === view.y1
    ) {
      return;
    }
    this.pendingCursor = { x, y, view };
    const now = Date.now();
    const wait = CURSOR_MS - (now - this.lastCursorSent);
    if (wait <= 0) {
      this.flushCursor();
    } else if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        this.flushCursor();
      }, wait);
    }
  }

  private flushCursor(): void {
    if (!this.pendingCursor) return;
    const { x, y, view } = this.pendingCursor;
    this.pendingCursor = null;
    this.lastCursorSent = Date.now();
    this.lastSent = { x, y, view };
    this.send({ t: 'cursor', x, y, view });
  }

  /* ── Chrono ───────────────────────────────────────────────────────── */

  elapsedMs(): number {
    if (!this.clockRunning) return this.serverElapsed;
    return this.serverElapsed + (Date.now() - this.stampedAt);
  }

  private stampClock(elapsedMs: number, running: boolean): void {
    this.serverElapsed = elapsedMs;
    this.stampedAt = Date.now();
    this.clockRunning = running;
  }

  /* ── Réception ────────────────────────────────────────────────────── */

  private receive(data: unknown): void {
    if (typeof data === 'string') {
      this.onJson(JSON.parse(data) as ServerMessage);
      return;
    }
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBufferLike);
    this.onBinary(bytes);
  }

  private resetBoard(config: NetConfig): void {
    this.config = config;
    this.board = createBoard(config.n, config.mineCount);
    this.remaining = this.board.mineCount;
    this.peers = [];
    this.stampClock(0, false);
  }

  private onJson(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.selfId;
        this.players = msg.players;
        this.phase = msg.phase;
        if (this.board.n !== msg.config.n || this.phase === 'lobby') this.resetBoard(msg.config);
        this.stampClock(msg.elapsedMs, msg.phase === 'playing');
        this.emitState();
        break;

      case 'players':
        this.players = msg.players;
        this.emitState();
        break;

      case 'config':
        if (this.phase === 'lobby') this.resetBoard(msg.config);
        this.emitState();
        break;

      case 'started':
        this.phase = 'playing';
        this.resetBoard(this.config);
        this.emitState();
        this.emitBoard();
        break;

      case 'reset':
        this.phase = 'playing';
        this.resetBoard(msg.config);
        this.emitState();
        this.emitBoard();
        break;

      case 'lobby':
        this.phase = 'lobby';
        this.resetBoard(msg.config);
        this.emitState();
        this.emitBoard();
        break;

      case 'flag': {
        const { board } = this;
        board.state[msg.i] = msg.on ? FLAGGED : COVERED;
        board.flagOwner[msg.i] = msg.owner;
        this.remaining = msg.remaining;
        this.emitBoard();
        this.emitState();
        break;
      }

      case 'presence':
        this.peers = msg.peers.filter((p) => p.id !== this.selfId);
        this.stampClock(msg.elapsedMs, this.phase === 'playing');
        // Surtout pas emitBoard() : le plateau n'a pas changé, et bumper sa
        // version reconstruirait la minimap 5 fois par seconde pour rien.
        this.emitPresence();
        break;

      case 'over':
        this.phase = msg.outcome;
        this.stampClock(msg.elapsedMs, false);
        this.emitState();
        this.emitBoard();
        break;

      case 'error':
        this.lastError = msg.message;
        this.emitState();
        break;
    }
  }

  private onBinary(bytes: Uint8Array): void {
    const { board } = this;
    switch (bytes[0]) {
      case FRAME_REVEAL: {
        const delta = applyReveal(bytes, board.state, board.adj, REVEALED);
        board.revealedCount = delta.revealedCount;
        this.emitBoard();
        break;
      }
      case FRAME_SNAPSHOT: {
        const meta = applySnapshot(bytes, board.state, board.adj, board.flagOwner, REVEALED, FLAGGED);
        board.revealedCount = meta.revealedCount;
        this.emitBoard();
        break;
      }
      case FRAME_MINES: {
        // Seul moment où les mines traversent le réseau : la partie est finie.
        applyMines(bytes, board.mines);
        // Même fonction que le serveur : l'écran de défaite est garanti identique.
        revealAllMines(board);
        this.emitBoard();
        break;
      }
    }
  }
}
