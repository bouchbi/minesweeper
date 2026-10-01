import { COVERED, createBoard, type Board } from '../src/game/board';
import {
  computeAdjacency,
  lastOpened,
  placeMines,
  reveal,
  revealAllMines,
  toggleFlag,
} from '../src/game/rules';
import { MAX_N, MIN_N } from '../src/game/presets';
import {
  DEFAULT_NET_CONFIG,
  encodeMines,
  encodeReveal,
  encodeSnapshot,
  MAX_PLAYERS,
  PLAYER_COLORS,
  type ClientMessage,
  type NetConfig,
  type Peer,
  type Phase,
  type PlayerId,
  type PlayerInfo,
  type Rect,
  type ServerMessage,
} from '../shared/protocol';
import { REVEALED, FLAGGED } from '../src/game/board';

/** Cadence maximale de diffusion de la présence. */
const PRESENCE_MS = 100;
/** Battement minimal même quand personne ne bouge, pour recaler le chrono. */
const HEARTBEAT_MS = 1000;
/** Délai avant d'abandonner une partie que plus personne ne suit. Assez long
 *  pour qu'un simple rechargement de page ne fasse pas perdre la partie.
 *  Surchargeable par ABANDON_MS, ce qui permet de le tester sans attendre. */
const ABANDON_MS = Number(process.env.ABANDON_MS ?? 60_000);

export type Connection = {
  id: PlayerId;
  name: string;
  connected: boolean;
  cursor: { x: number; y: number } | null;
  view: Rect | null;
  send(data: string | Uint8Array): void;
  close(): void;
};

/**
 * Partie autoritaire. Le serveur est le seul à détenir `board.mines` : les
 * clients ne reçoivent que ce qui a été révélé, et les positions des mines
 * uniquement à la défaite.
 *
 * Une Room = une salle, identifiée par son code (voir `server/main.ts`).
 */
export class Room {
  private clients = new Map<PlayerId, Connection>();
  private config: NetConfig = DEFAULT_NET_CONFIG;
  private phase: Phase = 'lobby';
  private board: Board | null = null;
  private flagOwner = new Uint8Array(0);
  private seeded = false;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private remaining = 0;

  /** Tampon de tri réutilisé : `lastOpened()` sort en ordre BFS, l'encodage
   *  RLE a besoin d'index croissants. */
  private sortBuf = new Int32Array(0);

  private presenceDirty = false;
  private lastPresence = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private abandonTimer: ReturnType<typeof setTimeout> | null = null;

  /** @param onEmpty appelé quand la salle est au lobby et que plus personne
   *  n'y est connecté : le serveur peut alors la libérer. */
  constructor(private readonly onEmpty: () => void = () => {}) {
    this.timer = setInterval(() => this.tickPresence(), PRESENCE_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.abandonTimer) clearTimeout(this.abandonTimer);
    this.abandonTimer = null;
  }

  /* ── Connexions ───────────────────────────────────────────────────── */

  private freeId(): PlayerId | null {
    for (let id = 1; id <= MAX_PLAYERS; id++) if (!this.clients.has(id)) return id;
    // Plus d'identifiant libre : on récupère celui d'un joueur déconnecté.
    for (const [id, c] of this.clients) if (!c.connected) return id;
    return null;
  }

  join(send: (d: string | Uint8Array) => void, close: () => void): Connection | null {
    const id = this.freeId();
    if (id === null) return null;
    const conn: Connection = {
      id,
      name: `Joueur ${id}`,
      connected: true,
      cursor: null,
      view: null,
      send,
      close,
    };
    this.clients.set(id, conn);
    if (this.abandonTimer) {
      clearTimeout(this.abandonTimer);
      this.abandonTimer = null;
    }
    return conn;
  }

  leave(conn: Connection): void {
    conn.connected = false;
    conn.cursor = null;
    conn.view = null;
    // En lobby on oublie le joueur ; en partie on le garde pour conserver la
    // couleur de ses drapeaux et lui permettre de revenir.
    if (this.phase === 'lobby') this.clients.delete(conn.id);
    this.broadcastPlayers();

    // Plus personne : la partie est abandonnée. Sans ça, elle resterait
    // éternellement en cours et le prochain arrivant tomberait dedans sans
    // pouvoir en sortir.
    if (this.isEmpty()) {
      if (this.phase === 'lobby') this.onEmpty();
      else if (!this.abandonTimer) {
        this.abandonTimer = setTimeout(() => {
          this.abandonTimer = null;
          this.toLobby();
          if (this.isEmpty()) this.onEmpty();
        }, ABANDON_MS);
      }
    }
  }

  private isEmpty(): boolean {
    for (const c of this.clients.values()) if (c.connected) return false;
    return true;
  }

  /** Ramène la salle au lobby : la configuration reste, le plateau disparaît. */
  private toLobby(): void {
    this.phase = 'lobby';
    this.board = null;
    this.flagOwner = new Uint8Array(0);
    this.seeded = false;
    this.startedAt = null;
    this.stoppedAt = null;
    // Les déconnectés n'étaient gardés que pour préserver leurs drapeaux le
    // temps de la partie.
    for (const [id, c] of [...this.clients]) if (!c.connected) this.clients.delete(id);
    for (const c of this.clients.values()) {
      c.cursor = null;
      c.view = null;
    }
    this.broadcastMsg({ t: 'lobby', config: this.config });
    this.broadcastPlayers();
  }

  private get hostId(): PlayerId | null {
    let best: PlayerId | null = null;
    for (const [id, c] of this.clients) if (c.connected && (best === null || id < best)) best = id;
    return best;
  }

  private players(): PlayerInfo[] {
    const host = this.hostId;
    return [...this.clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      color: PLAYER_COLORS[c.id] ?? PLAYER_COLORS[0],
      connected: c.connected,
      isHost: c.id === host,
    }));
  }

  /* ── Émission ─────────────────────────────────────────────────────── */

  private send(conn: Connection, msg: ServerMessage): void {
    conn.send(JSON.stringify(msg));
  }

  private broadcast(data: string | Uint8Array): void {
    for (const c of this.clients.values()) if (c.connected) c.send(data);
  }

  private broadcastMsg(msg: ServerMessage): void {
    this.broadcast(JSON.stringify(msg));
  }

  private broadcastPlayers(): void {
    this.broadcastMsg({ t: 'players', players: this.players() });
  }

  elapsedMs(): number {
    if (this.startedAt === null) return 0;
    return (this.stoppedAt ?? Date.now()) - this.startedAt;
  }

  /* ── Réception ────────────────────────────────────────────────────── */

  handle(conn: Connection, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    // Le serveur est exposé à Internet : `null`, un nombre ou un objet sans
    // `t` ne doivent pas faire tomber le processus sur `msg.t`.
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'join':
        conn.name = String(msg.name ?? '').slice(0, 24) || conn.name;
        this.send(conn, {
          t: 'welcome',
          selfId: conn.id,
          players: this.players(),
          phase: this.phase,
          config: this.config,
          elapsedMs: this.elapsedMs(),
        });
        if (this.phase !== 'lobby' && this.board) {
          conn.send(this.snapshot());
          // Sans ça, un joueur qui arrive ou se reconnecte après la défaite
          // n'a aucun moyen d'afficher les bombes : elles ne sont diffusées
          // qu'au moment du 'boom'.
          if (this.phase === 'dead') conn.send(encodeMines(this.board.n, this.board.mines));
        }
        this.broadcastPlayers();
        break;

      case 'config':
        if (conn.id !== this.hostId || this.phase !== 'lobby') return;
        this.config = sanitizeConfig(msg.config);
        this.broadcastMsg({ t: 'config', config: this.config });
        break;

      case 'start':
        if (conn.id !== this.hostId || this.phase !== 'lobby') return;
        this.newGame();
        this.broadcastMsg({ t: 'started' });
        break;

      case 'restart':
        if (conn.id !== this.hostId || this.phase === 'lobby') return;
        this.newGame();
        this.broadcastMsg({ t: 'reset', config: this.config });
        break;

      case 'lobby':
        if (conn.id !== this.hostId || this.phase === 'lobby') return;
        this.toLobby();
        break;

      case 'reveal':
        this.doReveal(conn, msg.i);
        break;

      case 'flag':
        this.doFlag(conn, msg.i);
        break;

      case 'cursor': {
        // La vue est rediffusée telle quelle à tous les joueurs : on la
        // reconstruit champ par champ plutôt que de relayer un objet arbitraire.
        const view = sanitizeRect(msg.view);
        if (!view) return;
        conn.cursor = { x: msg.x | 0, y: msg.y | 0 };
        conn.view = view;
        this.presenceDirty = true;
        break;
      }
    }
  }

  /* ── Partie ───────────────────────────────────────────────────────── */

  private newGame(): void {
    const { n, mineCount } = this.config;
    this.board = createBoard(n, mineCount);
    this.flagOwner = new Uint8Array(n * n);
    this.sortBuf = new Int32Array(n * n);
    this.seeded = false;
    this.startedAt = null;
    this.stoppedAt = null;
    this.remaining = this.board.mineCount;
    this.phase = 'playing';
    // Les joueurs déconnectés pendant la partie précédente sont oubliés ici.
    for (const [id, c] of [...this.clients]) if (!c.connected) this.clients.delete(id);
  }

  private startClock(): void {
    if (this.startedAt === null) this.startedAt = Date.now();
  }

  private doReveal(conn: Connection, i: number): void {
    const board = this.board;
    if (!board || this.phase !== 'playing') return;
    if (!Number.isInteger(i) || i < 0 || i >= board.n * board.n) return;
    // Même garde qu'en solo : une case déjà révélée ou drapeautée ne consomme
    // ni le chrono ni la garantie de premier clic sûr.
    if (board.state[i] !== COVERED) return;

    if (!this.seeded) {
      this.seeded = true;
      placeMines(board, i);
      computeAdjacency(board);
    }
    this.startClock();

    const outcome = reveal(board, i);
    if (outcome === 'noop') return;

    const opened = lastOpened();
    this.sortBuf.set(opened);
    const sorted = this.sortBuf.subarray(0, opened.length);
    sorted.sort();
    this.broadcast(encodeReveal(sorted, sorted.length, board.adj, board.mines, conn.id, board.revealedCount));

    if (outcome === 'boom') {
      revealAllMines(board);
      this.phase = 'dead';
      this.stoppedAt = Date.now();
      // Les mines ne quittent le serveur qu'ici, une fois la partie finie.
      this.broadcast(encodeMines(board.n, board.mines));
      this.broadcastMsg({ t: 'over', outcome: 'dead', by: conn.id, elapsedMs: this.elapsedMs() });
    } else if (outcome === 'win') {
      this.phase = 'won';
      this.stoppedAt = Date.now();
      this.broadcastMsg({ t: 'over', outcome: 'won', by: conn.id, elapsedMs: this.elapsedMs() });
    }
  }

  private doFlag(conn: Connection, i: number): void {
    const board = this.board;
    if (!board || this.phase !== 'playing') return;
    if (!Number.isInteger(i) || i < 0 || i >= board.n * board.n) return;

    this.startClock();
    const delta = toggleFlag(board, i);
    if (delta === 0) return;
    this.flagOwner[i] = delta === 1 ? conn.id : 0;
    this.remaining -= delta;
    this.broadcastMsg({
      t: 'flag',
      i,
      on: delta === 1,
      owner: this.flagOwner[i],
      remaining: this.remaining,
    });
  }

  private snapshot(): Uint8Array {
    const b = this.board!;
    return encodeSnapshot(b.n, b.state, b.adj, this.flagOwner, b.mines, b.revealedCount, REVEALED, FLAGGED);
  }

  /* ── Présence ─────────────────────────────────────────────────────── */

  private tickPresence(): void {
    const now = Date.now();
    if (!this.presenceDirty && now - this.lastPresence < HEARTBEAT_MS) return;
    this.presenceDirty = false;
    this.lastPresence = now;

    const peers: Peer[] = [];
    for (const c of this.clients.values()) {
      if (c.connected && c.cursor && c.view) {
        peers.push({ id: c.id, x: c.cursor.x, y: c.cursor.y, view: c.view });
      }
    }
    this.broadcastMsg({ t: 'presence', elapsedMs: this.elapsedMs(), peers });
  }
}

function finiteOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function sanitizeConfig(c: NetConfig | null | undefined): NetConfig {
  // `Math.max(5, NaN)` vaut NaN : sans le filtre `finiteOr`, une valeur non
  // numérique produirait un plateau incohérent diffusé à toute la salle.
  const n = Math.max(MIN_N, Math.min(MAX_N, Math.floor(finiteOr(c?.n, DEFAULT_NET_CONFIG.n))));
  const mineCount = Math.max(1, Math.min(n * n - 1, Math.floor(finiteOr(c?.mineCount, 1))));
  return { n, mineCount };
}

function sanitizeRect(r: Rect | null | undefined): Rect | null {
  if (typeof r !== 'object' || r === null) return null;
  const { x0, y0, x1, y1 } = r;
  for (const v of [x0, y0, x1, y1]) if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return { x0, y0, x1, y1 };
}
