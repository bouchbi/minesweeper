import { DEFUSED, FLAGGED, REVEALED } from '../src/game/board';
import { GameEngine, type ActionResult } from '../src/game/engine';
import { MAX_N, MIN_N, PRESETS } from '../src/game/presets';
import {
  DEFAULT_NET_CONFIG,
  encodeMines,
  encodeReveal,
  encodeSnapshot,
  ITEMS,
  MAX_PLAYERS,
  PLAYER_COLORS,
  PLAYER_KEY_RE,
  RECORD_TOP,
  type ClientMessage,
  type EndStat,
  type NetConfig,
  type Peer,
  type Phase,
  type PlayerId,
  type PlayerInfo,
  type Rect,
  type RecordInfo,
  type ServerMessage,
} from '../shared/protocol';
import { decodeSave, encodeSave, type RoomSave } from './save';
import type { Store } from './store';

/** Cadence maximale de diffusion de la présence. */
const PRESENCE_MS = 100;
/** Battement minimal même quand personne ne bouge, pour recaler le chrono. */
const HEARTBEAT_MS = 1000;
/** Délai avant d'abandonner une partie que plus personne ne suit. Assez long
 *  pour qu'un simple rechargement de page ne fasse pas perdre la partie.
 *  Surchargeable par ABANDON_MS, ce qui permet de le tester sans attendre. */
const ABANDON_MS = Number(process.env.ABANDON_MS ?? 60_000);
/** Sauvegarde de sécurité d'une partie en cours, si quelque chose a bougé :
 *  borne ce qu'un plantage (SIGKILL, panne) peut faire perdre. */
const SAVE_MS = 120_000;

/** Ce que le serveur prête à une salle. */
export type RoomHooks = {
  /** Plus personne depuis ABANDON_MS : le serveur peut libérer la salle. Une
   *  partie en cours a été mise de côté juste avant. */
  onEmpty(): void;
  /** null si le serveur tourne sans stockage (dossier non accessible) : les
   *  parties ne survivent alors pas à la salle, et rien n'est classé. */
  store: Store | null;
  maxSaves: number;
  /** Un record a été inscrit ou renommé. */
  onRecord(): void;
};

export type Connection = {
  /** 0 tant que le joueur n'a pas envoyé `join` : sa place dépend de sa clé. */
  id: PlayerId;
  key: string | null;
  joined: boolean;
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
  /** Connexions ouvertes qui n'ont pas encore envoyé `join`. */
  private pending = new Set<Connection>();
  private config: NetConfig = DEFAULT_NET_CONFIG;
  private phase: Phase = 'lobby';
  /** Règles, plateau et réserve commune de la salle. null au lobby. */
  private engine: GameEngine | null = null;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  /** Chrono en pause : salle vide en cours de partie. Le temps retenu (et
   *  classé) est le temps de jeu, pas le temps écoulé entre deux sessions. */
  private pausedAt: number | null = null;

  /** Une action a eu lieu depuis la dernière sauvegarde. */
  private dirty = false;
  /** Une sauvegarde de cette salle existe peut-être sur disque. */
  private saved = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  /** Record solo qui attend le nom de son auteur (une seule fois). */
  private pendingRecord: { id: number; by: PlayerId } | null = null;

  /** Tampon de tri réutilisé : les cases ouvertes sortent en ordre BFS,
   *  l'encodage RLE a besoin d'index croissants. */
  private sortBuf = new Int32Array(0);

  private presenceDirty = false;
  private lastPresence = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private abandonTimer: ReturnType<typeof setTimeout> | null = null;

  /** @param start configuration d'une partie lancée d'emblée, sans lobby
   *  (solo sur une carte prédéfinie). */
  constructor(
    readonly code: string,
    private readonly hooks: RoomHooks,
    start?: NetConfig,
  ) {
    this.timer = setInterval(() => this.tickPresence(), PRESENCE_MS);
    this.saveTimer = setInterval(() => {
      if (this.dirty) this.persist();
    }, SAVE_MS);
    if (start) {
      this.config = sanitizeConfig(start);
      this.newGame();
    }
  }

  /** Reprend une partie mise de côté. @throws si la sauvegarde est illisible. */
  static restore(code: string, hooks: RoomHooks, blob: Uint8Array): Room {
    const save = decodeSave(blob);
    const room = new Room(code, hooks);
    room.config = save.config;
    room.engine = GameEngine.restore(save.config, save.engine);
    room.sortBuf = new Int32Array(save.config.n * save.config.n);
    room.phase = 'playing';
    room.saved = true;
    const now = Date.now();
    // En pause jusqu'à l'arrivée du premier joueur (voir `join`).
    room.startedAt = now - save.elapsedMs;
    room.pausedAt = now;
    // Les joueurs de la session précédente, déconnectés : leur clé leur rend
    // leur place, donc leur couleur, leurs drapeaux et leurs statistiques.
    for (const p of save.players) {
      room.clients.set(p.id, {
        id: p.id,
        key: p.key,
        joined: true,
        name: p.name,
        connected: false,
        cursor: null,
        view: null,
        send: () => {},
        close: () => {},
      });
    }
    return room;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
    if (this.abandonTimer) clearTimeout(this.abandonTimer);
    this.abandonTimer = null;
  }

  /* ── Persistance ──────────────────────────────────────────────────── */

  /** Met la partie en cours de côté. Sans effet hors partie, ou avant le
   *  premier geste (rien à perdre). Appelé aussi à l'arrêt du serveur. */
  persist(): void {
    const { store } = this.hooks;
    const engine = this.playing();
    if (!store || !engine || this.startedAt === null) return;
    try {
      const save: RoomSave = {
        config: this.config,
        elapsedMs: this.elapsedMs(),
        players: [...this.clients.values()].map((c) => ({ id: c.id, key: c.key, name: c.name })),
        engine: engine.serialize(),
      };
      store.writeSave(this.code, encodeSave(save), this.hooks.maxSaves);
      this.saved = true;
      this.dirty = false;
    } catch (err) {
      console.error(`[${this.code}] sauvegarde impossible :`, err);
    }
  }

  /** La partie est finie ou abandonnée : sa sauvegarde n'a plus d'objet. */
  private dropSave(): void {
    if (!this.saved || !this.hooks.store) return;
    this.saved = false;
    try {
      this.hooks.store.deleteSave(this.code);
    } catch (err) {
      console.error(`[${this.code}] suppression de la sauvegarde impossible :`, err);
    }
  }

  /* ── Connexions ───────────────────────────────────────────────────── */

  private freeId(): PlayerId | null {
    for (let id = 1; id <= MAX_PLAYERS; id++) if (!this.clients.has(id)) return id;
    // Plus d'identifiant libre : on récupère celui d'un joueur déconnecté.
    for (const [id, c] of this.clients) if (!c.connected) return id;
    return null;
  }

  /** Nouvelle connexion. Sa place (id, couleur) n'est attribuée qu'à la
   *  réception de `join`, qui porte la clé du joueur.
   *  @returns null si la salle est complète. */
  join(send: (d: string | Uint8Array) => void, close: () => void): Connection | null {
    let connected = this.pending.size;
    for (const c of this.clients.values()) if (c.connected) connected++;
    if (connected >= MAX_PLAYERS) return null;
    const conn: Connection = {
      id: 0,
      key: null,
      joined: false,
      name: '',
      connected: true,
      cursor: null,
      view: null,
      send,
      close,
    };
    this.pending.add(conn);
    if (this.abandonTimer) {
      clearTimeout(this.abandonTimer);
      this.abandonTimer = null;
    }
    if (this.pausedAt !== null) {
      if (this.startedAt !== null) this.startedAt += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
    return conn;
  }

  /** `join` reçu : place du joueur, reprise de la sienne s'il revient. */
  private admit(conn: Connection, name: unknown, rawKey: unknown): boolean {
    const key = typeof rawKey === 'string' && PLAYER_KEY_RE.test(rawKey) ? rawKey : null;
    let id: PlayerId | null = null;
    let previous: Connection | undefined;
    if (key) {
      for (const c of this.clients.values()) {
        if (!c.connected && c.key === key) {
          id = c.id;
          previous = c;
          break;
        }
      }
    }
    id ??= this.freeId();
    if (id === null) return false;
    this.pending.delete(conn);
    conn.id = id;
    conn.key = key;
    conn.joined = true;
    conn.name = String(name ?? '').slice(0, 24) || previous?.name || `Joueur ${id}`;
    this.clients.set(id, conn);
    return true;
  }

  leave(conn: Connection): void {
    conn.connected = false;
    conn.cursor = null;
    conn.view = null;
    if (!conn.joined) {
      this.pending.delete(conn);
    } else if (this.clients.get(conn.id) === conn) {
      // En lobby on oublie le joueur ; en partie on le garde pour conserver la
      // couleur de ses drapeaux et lui permettre de revenir.
      if (this.phase === 'lobby') this.clients.delete(conn.id);
      this.broadcastPlayers();
    }

    // Plus personne : le chrono s'arrête, et la salle est libérée après un
    // délai assez long pour qu'un rechargement de page ne la fasse pas perdre.
    // Une partie en cours est alors mise de côté, et reprendra au retour d'un
    // joueur avec le même code.
    if (this.isEmpty() && !this.abandonTimer) {
      if (this.phase === 'playing' && this.pausedAt === null) this.pausedAt = Date.now();
      this.abandonTimer = setTimeout(() => {
        this.abandonTimer = null;
        if (!this.isEmpty()) return;
        this.persist();
        this.hooks.onEmpty();
      }, ABANDON_MS);
    }
  }

  private isEmpty(): boolean {
    if (this.pending.size > 0) return false;
    for (const c of this.clients.values()) if (c.connected) return false;
    return true;
  }

  /** Ramène la salle au lobby : la configuration reste, le plateau disparaît. */
  private toLobby(): void {
    this.dropSave();
    this.pendingRecord = null;
    this.phase = 'lobby';
    this.engine = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.pausedAt = null;
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
    // Les connexions en attente de `join` ne reçoivent rien : leur `welcome`
    // contiendra l'état complet.
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
    return (this.stoppedAt ?? this.pausedAt ?? Date.now()) - this.startedAt;
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
    // Rien d'autre n'est accepté avant `join` : le joueur n'a pas encore de place.
    if (!conn.joined && msg.t !== 'join') return;
    switch (msg.t) {
      case 'join':
        if (conn.joined) return;
        if (!this.admit(conn, msg.name, msg.key)) {
          this.send(conn, { t: 'error', message: 'Salle complète (8 joueurs maximum).' });
          conn.close();
          return;
        }
        this.send(conn, {
          t: 'welcome',
          code: this.code,
          selfId: conn.id,
          players: this.players(),
          phase: this.phase,
          config: this.config,
          elapsedMs: this.elapsedMs(),
        });
        if (this.phase !== 'lobby' && this.engine) {
          const { board } = this.engine;
          conn.send(this.snapshot());
          // Sans ça, un joueur qui arrive ou se reconnecte après la défaite
          // n'a aucun moyen d'afficher les bombes : elles ne sont diffusées
          // qu'au moment du 'boom'.
          if (this.phase === 'dead') conn.send(encodeMines(board.n, board.mines));
          // Réserve et compteur : sans ça, un joueur arrivé en cours de
          // partie afficherait le nombre total de mines jusqu'au prochain
          // drapeau.
          this.send(conn, this.inventoryMsg());
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

      case 'use':
        if (!ITEMS.includes(msg.item)) return;
        this.doUse(conn, msg.item, msg.i);
        break;

      case 'recordName': {
        const rec = this.pendingRecord;
        const name = String(msg.name ?? '').trim().slice(0, 24);
        if (!rec || rec.by !== conn.id || !name || !this.hooks.store) return;
        this.pendingRecord = null;
        conn.name = name;
        try {
          this.hooks.store.renameRecord(rec.id, [name]);
          this.hooks.onRecord();
        } catch (err) {
          console.error(`[${this.code}] record non renommé :`, err);
        }
        this.broadcastPlayers();
        break;
      }

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
    const { n } = this.config;
    this.dropSave();
    this.pendingRecord = null;
    this.engine = new GameEngine(this.config);
    this.sortBuf = new Int32Array(n * n);
    this.startedAt = null;
    this.stoppedAt = null;
    this.pausedAt = null;
    this.phase = 'playing';
    // Les joueurs déconnectés pendant la partie précédente sont oubliés ici.
    for (const [id, c] of [...this.clients]) if (!c.connected) this.clients.delete(id);
  }

  private startClock(): void {
    if (this.startedAt === null) this.startedAt = Date.now();
  }

  /** Moteur de la partie en cours, ou null hors phase de jeu. */
  private playing(): GameEngine | null {
    return this.phase === 'playing' ? this.engine : null;
  }

  private doReveal(conn: Connection, i: number): void {
    const engine = this.playing();
    if (!engine) return;
    // Index invalide, case déjà ouverte ou drapeautée : null, et comme en solo
    // ni le chrono ni le premier clic sûr ne sont consommés.
    const result = engine.reveal(i, conn.id);
    if (!result) return;
    this.startClock();
    this.dirty = true;
    this.publish(engine, result, conn.id);
  }

  private doUse(conn: Connection, item: (typeof ITEMS)[number], i: number): void {
    const engine = this.playing();
    if (!engine) return;
    // La réserve est commune : si deux joueurs posent le dernier objet en même
    // temps, le second message trouve la réserve vide et ne fait rien.
    const result = engine.use(item, i, conn.id);
    if (!result) return;
    this.dirty = true;
    this.publish(engine, result, conn.id);
  }

  /** Diffuse le résultat d'une action à toute la salle. */
  private publish(engine: GameEngine, result: ActionResult, by: PlayerId): void {
    const { board } = engine;
    const { opened, defused } = result;
    // Événements d'abord, cases ensuite : le client garde les zones de boule à
    // facettes en attente et les voile au moment même où leurs cases arrivent
    // (voir NetworkSession). Dans l'autre ordre, une image pourrait montrer les
    // zones ouvertes avant que l'animation ne les cache.
    if (result.events.length > 0) this.broadcastMsg({ t: 'events', events: result.events });
    if (opened.length > 0 || defused.length > 0) {
      const sorted = this.sortBuf.subarray(0, opened.length);
      sorted.set(opened);
      sorted.sort();
      const sortedDefused = defused.slice().sort((a, b) => a - b);
      this.broadcast(
        encodeReveal(sorted, sorted.length, board.adj, board.mines, by, board.revealedCount, sortedDefused),
      );
    }
    if (result.inventoryChanged) this.broadcastMsg(this.inventoryMsg());

    if (result.outcome === 'dead') {
      this.phase = 'dead';
      this.stoppedAt = Date.now();
      this.dropSave();
      // Les mines ne quittent le serveur qu'ici, une fois la partie finie
      // (en dehors de celles désamorcées, publiques par définition).
      this.broadcast(encodeMines(board.n, board.mines));
      this.broadcastMsg({ t: 'over', outcome: 'dead', by, elapsedMs: this.elapsedMs(), stats: this.endStats(engine), record: null });
    } else if (result.outcome === 'won') {
      this.phase = 'won';
      this.stoppedAt = Date.now();
      this.dropSave();
      const elapsedMs = this.elapsedMs();
      this.broadcastMsg({
        t: 'over',
        outcome: 'won',
        by,
        elapsedMs,
        stats: this.endStats(engine),
        record: this.recordWin(engine, elapsedMs),
      });
    }
  }

  private endStats(engine: GameEngine): EndStat[] {
    const out: EndStat[] = [];
    for (const [id, st] of engine.stats()) {
      if (id === 0) continue; // drapeaux sans auteur : impossible en réseau
      out.push({
        ...st,
        id,
        name: this.clients.get(id)?.name ?? `Joueur ${id}`,
        color: PLAYER_COLORS[id] ?? PLAYER_COLORS[0],
      });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** Inscrit la victoire au classement de sa carte s'il s'agit d'une carte
   *  prédéfinie et que le temps entre dans les RECORD_TOP meilleurs. */
  private recordWin(engine: GameEngine, elapsedMs: number): RecordInfo | null {
    const { store } = this.hooks;
    const { n, mineCount, bonus } = this.config;
    const preset = PRESETS.find((p) => p.n === n && p.mineCount === mineCount);
    const ids = engine.participants.filter((id) => id > 0).sort((a, b) => a - b);
    if (!store || !preset || ids.length === 0) return null;
    const mode = ids.length === 1 ? 'solo' : 'coop';
    try {
      const rank = store.rankFor(preset.id, bonus, mode, elapsedMs);
      if (rank > RECORD_TOP) return null;
      const names = ids.map((id) => this.clients.get(id)?.name ?? `Joueur ${id}`);
      const id = store.addRecord(preset.id, bonus, mode, elapsedMs, names);
      this.hooks.onRecord();
      const nameable = mode === 'solo' ? ids[0] : null;
      if (nameable !== null) this.pendingRecord = { id, by: nameable };
      return { preset: preset.id, bonus, mode, rank, nameable };
    } catch (err) {
      console.error(`[${this.code}] record non inscrit :`, err);
      return null;
    }
  }

  private doFlag(conn: Connection, i: number): void {
    const engine = this.playing();
    if (!engine) return;
    if (!Number.isInteger(i) || i < 0 || i >= engine.board.state.length) return;

    this.startClock();
    const delta = engine.flag(i, conn.id);
    if (delta === 0) return;
    this.dirty = true;
    this.broadcastMsg({
      t: 'flag',
      i,
      on: delta === 1,
      owner: engine.board.flagOwner[i],
      remaining: engine.remaining,
    });
  }

  private inventoryMsg(): ServerMessage {
    const engine = this.engine!;
    return { t: 'inventory', inventory: engine.inventory, remaining: engine.remaining };
  }

  private snapshot(): Uint8Array {
    const b = this.engine!.board;
    return encodeSnapshot(b.n, b.state, b.adj, b.flagOwner, b.mines, b.revealedCount, REVEALED, FLAGGED, DEFUSED);
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
  return { n, mineCount, bonus: c?.bonus === true };
}

function sanitizeRect(r: Rect | null | undefined): Rect | null {
  if (typeof r !== 'object' || r === null) return null;
  const { x0, y0, x1, y1 } = r;
  for (const v of [x0, y0, x1, y1]) if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return { x0, y0, x1, y1 };
}
