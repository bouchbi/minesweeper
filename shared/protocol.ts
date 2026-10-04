/**
 * Protocole du mode co-op LAN, partagé mot pour mot par le client et le
 * serveur — il n'existe qu'un seul encodeur et un seul décodeur.
 *
 * Le contrôle et la présence passent en JSON (petits messages, peu fréquents).
 * Les mutations de plateau passent en binaire : une cascade peut ouvrir un
 * million de cases, et envoyer un million d'index est hors de question.
 */

export const MAX_PLAYERS = 8;

/** 1..MAX_PLAYERS. 0 signifie « personne » (case sans drapeau). */
export type PlayerId = number;

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export type PlayerInfo = {
  id: PlayerId;
  name: string;
  color: string;
  connected: boolean;
  isHost: boolean;
};

export type Phase = 'lobby' | 'playing' | 'dead' | 'won';

export type NetConfig = { n: number; mineCount: number; bonus: boolean };

/** Carte proposée à l'ouverture d'une salle, tant que l'hôte n'a rien choisi. */
export const DEFAULT_NET_CONFIG: NetConfig = { n: 30, mineCount: 150, bonus: false };

/* ── Bonus ──────────────────────────────────────────────────────────── */

/** Objets qu'on garde en réserve et qu'on pose sur la case de son choix. */
export type Item = 'probe' | 'shield';
export const ITEMS: readonly Item[] = ['probe', 'shield'];

/** Réserve de la partie. En co-op elle est commune à toute la salle. */
export type Inventory = { lives: number; probes: number; shields: number };

/**
 * Ce qui vient de se passer, pour le HUD (messages) et le plateau (flash).
 * `by` est le joueur à l'origine de l'action, 0 en solo.
 */
export type GameEvent =
  /** Bonus ramassé en découvrant la case `i` (valeur BONUS_* de board.ts). */
  | { kind: 'pickup'; bonus: number; i: number; by: PlayerId }
  /** Zone vide ouverte par une boule à facettes, à partir de la case `i`. */
  | { kind: 'zone'; i: number; by: PlayerId }
  /** Mine `i` touchée, rattrapée par une vie. */
  | { kind: 'life'; i: number; by: PlayerId }
  /** Objet posé sur la case `i`. */
  | { kind: 'use'; item: Item; i: number; by: PlayerId };

/**
 * Code de salle : plusieurs groupes partagent le même serveur, chacun dans sa
 * salle. Le code sert aussi de clé d'accès, d'où une longueur minimale.
 */
export const ROOM_CODE_RE = /^[a-z0-9]{4,12}$/;

/** @returns le code en minuscules, ou null s'il n'est pas valide. */
export function normalizeRoomCode(raw: string | null | undefined): string | null {
  const code = String(raw ?? '').trim().toLowerCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

/** Sans 0/o, 1/l/i : le code se dicte et se recopie sans ambiguïté. */
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomRoomCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return out;
}

export type Peer = { id: PlayerId; x: number; y: number; view: Rect };

export type ClientMessage =
  | { t: 'join'; name: string }
  | { t: 'config'; config: NetConfig }
  | { t: 'start' }
  | { t: 'reveal'; i: number }
  | { t: 'flag'; i: number }
  | { t: 'cursor'; x: number; y: number; view: Rect }
  | { t: 'use'; item: Item; i: number }
  | { t: 'restart' }
  /** L'hôte ramène tout le monde au lobby pour choisir une autre carte. */
  | { t: 'lobby' };

export type ServerMessage =
  | { t: 'welcome'; selfId: PlayerId; players: PlayerInfo[]; phase: Phase; config: NetConfig; elapsedMs: number }
  /** Réserve et compteur de bombes, envoyés à chaque changement et à l'arrivée
   *  d'un joueur en cours de partie. `inventory` est null sans bonus. */
  | { t: 'inventory'; inventory: Inventory | null; remaining: number }
  | { t: 'events'; events: GameEvent[] }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'config'; config: NetConfig }
  | { t: 'started' }
  | { t: 'flag'; i: number; on: boolean; owner: PlayerId; remaining: number }
  | { t: 'presence'; elapsedMs: number; peers: Peer[] }
  | { t: 'over'; outcome: 'dead' | 'won'; by: PlayerId; elapsedMs: number }
  | { t: 'reset'; config: NetConfig }
  | { t: 'lobby'; config: NetConfig }
  | { t: 'error'; message: string };

/* ═══════════════════════════════════════════════════════════════════════
   Trames binaires
   ═══════════════════════════════════════════════════════════════════════ */

export const FRAME_REVEAL = 1;
export const FRAME_SNAPSHOT = 2;
export const FRAME_MINES = 3;

/* ── Tampons ────────────────────────────────────────────────────────── */

export class ByteWriter {
  private buf = new Uint8Array(4096);
  private len = 0;

  private grow(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.grow(1);
    this.buf[this.len++] = v;
  }

  /** LEB128 non signé. Un index de case (< 2^20) tient sur 3 octets. */
  varint(v: number): void {
    this.grow(5);
    let x = v >>> 0;
    do {
      let b = x & 0x7f;
      x >>>= 7;
      if (x !== 0) b |= 0x80;
      this.buf[this.len++] = b;
    } while (x !== 0);
  }

  bytes(a: Uint8Array): void {
    this.grow(a.length);
    this.buf.set(a, this.len);
    this.len += a.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}

  u8(): number {
    return this.data[this.pos++];
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.data[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }

  bytes(n: number): Uint8Array {
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  get done(): boolean {
    return this.pos >= this.data.length;
  }
}

/* ── Séquences de cases révélées ─────────────────────────────────────── */

/**
 * Écrit une liste d'index TRIÉS sous forme de séquences contiguës.
 *
 * C'est ce qui rend le co-op viable sur de grandes cartes : l'intérieur d'une
 * cascade est entièrement en `adj = 0` et donc contigu ligne par ligne, ce qui
 * donne environ une séquence par ligne. Une cascade de 250 000 cases réparties
 * sur 500 lignes tient en ~500 séquences, soit quelques kilo-octets.
 */
function writeRuns(w: ByteWriter, sorted: Int32Array, count: number): void {
  // Première passe : compter les séquences, pour écrire le nombre en tête.
  let runs = 0;
  for (let k = 0; k < count; k++) {
    if (k === 0 || sorted[k] !== sorted[k - 1] + 1) runs++;
  }
  w.varint(runs);

  let prevEnd = 0; // index juste après la séquence précédente
  let k = 0;
  while (k < count) {
    const start = sorted[k];
    let end = k;
    while (end + 1 < count && sorted[end + 1] === sorted[end] + 1) end++;
    const length = end - k + 1;
    w.varint(start - prevEnd); // écart, toujours >= 0 puisque trié
    w.varint(length);
    prevEnd = start + length;
    k = end + 1;
  }
}

function readRuns(r: ByteReader, onCell: (i: number) => void): number {
  const runs = r.varint();
  let prevEnd = 0;
  let total = 0;
  for (let k = 0; k < runs; k++) {
    const start = prevEnd + r.varint();
    const length = r.varint();
    for (let j = 0; j < length; j++) onCell(start + j);
    prevEnd = start + length;
    total += length;
  }
  return total;
}

/**
 * Chiffres 1..8 : seule la bordure d'une cascade en porte, d'où la parcimonie.
 *
 * Les cases MINÉES sont systématiquement exclues. Une mine n'affiche jamais de
 * chiffre, donc l'information est inutile — et surtout, l'envoyer ferait
 * diverger `adj` selon le chemin par lequel un client a appris l'état (deltas
 * ou snapshot), ce qui rendrait deux plateaux pourtant identiques à l'écran
 * impossibles à comparer.
 */
function writeDigits(
  w: ByteWriter,
  sorted: Int32Array,
  count: number,
  adj: Uint8Array,
  mines: Uint8Array,
): void {
  let digits = 0;
  for (let k = 0; k < count; k++) if (adj[sorted[k]] !== 0 && !mines[sorted[k]]) digits++;
  w.varint(digits);
  let prev = 0;
  for (let k = 0; k < count; k++) {
    const i = sorted[k];
    if (adj[i] === 0 || mines[i]) continue;
    w.varint(i - prev);
    w.u8(adj[i]);
    prev = i;
  }
}

function readDigits(r: ByteReader, adj: Uint8Array): void {
  const digits = r.varint();
  let prev = 0;
  for (let k = 0; k < digits; k++) {
    const i = prev + r.varint();
    adj[i] = r.u8();
    prev = i;
  }
}

/* ── Mines désamorcées ───────────────────────────────────────────────── */

/**
 * Liste d'index triés, en écarts varint. Une mine désamorcée est publique par
 * définition : c'est la seule façon dont une position de mine quitte le
 * serveur avant la fin de partie.
 */
function writeIndexList(w: ByteWriter, sorted: ArrayLike<number>): void {
  w.varint(sorted.length);
  let prev = 0;
  for (let k = 0; k < sorted.length; k++) {
    w.varint(sorted[k] - prev);
    prev = sorted[k];
  }
}

function readIndexList(r: ByteReader, onIndex: (i: number) => void): void {
  const count = r.varint();
  let prev = 0;
  for (let k = 0; k < count; k++) {
    const i = prev + r.varint();
    onIndex(i);
    prev = i;
  }
}

/* ── REVEAL ──────────────────────────────────────────────────────────── */

/**
 * @param sorted  index ouverts, TRIÉS par ordre croissant
 * @param count   nombre d'entrées utiles dans `sorted`
 * @param adj     tableau d'adjacence du serveur (source des chiffres)
 * @param defused mines passées à DEFUSED par cette action, TRIÉES
 */
export function encodeReveal(
  sorted: Int32Array,
  count: number,
  adj: Uint8Array,
  mines: Uint8Array,
  by: PlayerId,
  revealedCount: number,
  defused: ArrayLike<number> = [],
): Uint8Array {
  const w = new ByteWriter();
  w.u8(FRAME_REVEAL);
  w.u8(by);
  w.varint(revealedCount);
  writeRuns(w, sorted, count);
  writeDigits(w, sorted, count, adj, mines);
  // Après les séquences : une mine tout juste révélée par un 'boom' rattrapé
  // par une vie y figure comme REVEALED, et doit finir DEFUSED.
  writeIndexList(w, defused);
  return w.finish();
}

export type RevealDelta = { by: PlayerId; revealedCount: number; opened: number };

/** Applique la trame directement dans les tableaux du plateau client. */
export function applyReveal(
  data: Uint8Array,
  state: Uint8Array,
  adj: Uint8Array,
  REVEALED: number,
  DEFUSED: number,
): RevealDelta {
  const r = new ByteReader(data);
  r.u8(); // FRAME_REVEAL
  const by = r.u8();
  const revealedCount = r.varint();
  const opened = readRuns(r, (i) => {
    state[i] = REVEALED;
  });
  readDigits(r, adj);
  readIndexList(r, (i) => {
    state[i] = DEFUSED;
  });
  return { by, revealedCount, opened };
}

/* ── SNAPSHOT ────────────────────────────────────────────────────────── */

/**
 * @param mines  nécessaire uniquement pour EXCLURE les cases minées des
 *   chiffres. Après une défaite, les mines sont révélées : un client arrivé par
 *   deltas n'a jamais reçu leur `adj` (une mine n'affiche pas de chiffre),
 *   alors qu'un client arrivé par snapshot le recevrait. Les deux plateaux
 *   divergeraient sans conséquence visible, mais la comparaison d'état
 *   deviendrait impossible — et un état qui diverge silencieusement finit
 *   toujours par se voir ailleurs. Rien n'est divulgué : ces cases ne sont
 *   ignorées qu'une fois la partie perdue, où les mines sont déjà publiques.
 */
export function encodeSnapshot(
  n: number,
  state: Uint8Array,
  adj: Uint8Array,
  flagOwner: Uint8Array,
  mines: Uint8Array,
  revealedCount: number,
  REVEALED: number,
  FLAGGED: number,
  DEFUSED: number,
): Uint8Array {
  const total = n * n;
  const revealed: number[] = [];
  const flags: number[] = [];
  const defused: number[] = [];
  for (let i = 0; i < total; i++) {
    if (state[i] === REVEALED) { if (!mines[i]) revealed.push(i); }
    else if (state[i] === FLAGGED) flags.push(i);
    else if (state[i] === DEFUSED) defused.push(i);
  }
  // Les cases minées révélées (après défaite) sont transmises comme état, mais
  // sans chiffre : le client les recevra via la trame MINES.
  const shown: number[] = [];
  for (let i = 0; i < total; i++) if (state[i] === REVEALED) shown.push(i);
  const sortedShown = Int32Array.from(shown);
  const sorted = Int32Array.from(revealed);

  const w = new ByteWriter();
  w.u8(FRAME_SNAPSHOT);
  w.varint(n);
  w.varint(revealedCount);
  writeRuns(w, sortedShown, sortedShown.length);
  writeDigits(w, sorted, sorted.length, adj, mines);
  w.varint(flags.length);
  let prev = 0;
  for (const i of flags) {
    w.varint(i - prev);
    w.u8(flagOwner[i]);
    prev = i;
  }
  writeIndexList(w, defused);
  return w.finish();
}

export function applySnapshot(
  data: Uint8Array,
  state: Uint8Array,
  adj: Uint8Array,
  flagOwner: Uint8Array,
  REVEALED: number,
  FLAGGED: number,
  DEFUSED: number,
): { n: number; revealedCount: number } {
  const r = new ByteReader(data);
  r.u8();
  const n = r.varint();
  const revealedCount = r.varint();
  state.fill(0);
  adj.fill(0);
  flagOwner.fill(0);
  readRuns(r, (i) => {
    state[i] = REVEALED;
  });
  readDigits(r, adj);
  const flags = r.varint();
  let prev = 0;
  for (let k = 0; k < flags; k++) {
    const i = prev + r.varint();
    state[i] = FLAGGED;
    flagOwner[i] = r.u8();
    prev = i;
  }
  readIndexList(r, (i) => {
    state[i] = DEFUSED;
  });
  return { n, revealedCount };
}

/* ── MINES (fin de partie uniquement) ────────────────────────────────── */

const MINES_BITSET = 0;
const MINES_GAPS = 1;

/**
 * Deux encodages, on garde le plus court :
 *  - bitset : n²/8 octets, indépendant du nombre de mines (125 Ko sur 1 M)
 *  - écarts varint : imbattable quand les mines sont rares (2 000 mines ≈ 6 Ko)
 */
export function encodeMines(n: number, mines: Uint8Array): Uint8Array {
  const total = n * n;
  let count = 0;
  for (let i = 0; i < total; i++) if (mines[i]) count++;

  const gaps = new ByteWriter();
  gaps.u8(FRAME_MINES);
  gaps.u8(MINES_GAPS);
  gaps.varint(n);
  gaps.varint(count);
  let prev = 0;
  for (let i = 0; i < total; i++) {
    if (!mines[i]) continue;
    gaps.varint(i - prev);
    prev = i;
  }
  const gapsOut = gaps.finish();

  const bytes = (total + 7) >> 3;
  if (gapsOut.length <= bytes + 8) return gapsOut;

  const bits = new Uint8Array(bytes);
  for (let i = 0; i < total; i++) if (mines[i]) bits[i >> 3] |= 1 << (i & 7);
  const w = new ByteWriter();
  w.u8(FRAME_MINES);
  w.u8(MINES_BITSET);
  w.varint(n);
  w.bytes(bits);
  return w.finish();
}

export function applyMines(data: Uint8Array, mines: Uint8Array): number {
  const r = new ByteReader(data);
  r.u8();
  const mode = r.u8();
  const n = r.varint();
  const total = n * n;
  mines.fill(0);
  if (mode === MINES_GAPS) {
    const count = r.varint();
    let prev = 0;
    for (let k = 0; k < count; k++) {
      const i = prev + r.varint();
      mines[i] = 1;
      prev = i;
    }
    return count;
  }
  const bits = r.bytes((total + 7) >> 3);
  let count = 0;
  for (let i = 0; i < total; i++) {
    if ((bits[i >> 3] >> (i & 7)) & 1) {
      mines[i] = 1;
      count++;
    }
  }
  return count;
}

/** Couleurs de joueur, indexées par PlayerId (l'entrée 0 n'est pas utilisée). */
export const PLAYER_COLORS = [
  '#ef4444', // 0 — jamais attribué, sert de repli
  '#60a5fa',
  '#4ade80',
  '#fbbf24',
  '#f472b6',
  '#22d3ee',
  '#c084fc',
  '#fb923c',
  '#a3e635',
];
