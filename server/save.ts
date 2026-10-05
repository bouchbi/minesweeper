import { gunzipSync, gzipSync } from 'node:zlib';
import type { EngineSave } from '../src/game/engine';
import { MAX_N, MIN_N } from '../src/game/presets';
import { MAX_PLAYERS, PLAYER_KEY_RE, type NetConfig, type PlayerId, type PlayerStats } from '../shared/protocol';

/** Joueur d'une partie mise de côté : sa clé lui rend sa place au retour. */
export type SavedPlayer = { id: PlayerId; key: string | null; name: string };

export type RoomSave = {
  config: NetConfig;
  elapsedMs: number;
  players: SavedPlayer[];
  engine: EngineSave;
};

/**
 * Format : « MSV1 », longueur de l'en-tête JSON (u32), en-tête, puis les
 * tableaux mines/state/bonus/flagOwner bout à bout (n² octets chacun), le
 * tout compressé. Un plateau en cours se compresse très bien : de longues
 * plages de cases ouvertes ou couvertes, des mines rares.
 */
const MAGIC = [0x4d, 0x53, 0x56, 0x31];
const ARRAYS = 4;
/** Borne la décompression : un fichier corrompu ne doit pas faire exploser
 *  la mémoire du serveur. */
const MAX_RAW = MAX_N * MAX_N * ARRAYS + 1024 * 1024;

export function encodeSave(save: RoomSave): Buffer {
  const { mines, state, bonus, flagOwner, ...engineMeta } = save.engine;
  const header = Buffer.from(
    JSON.stringify({ v: 1, config: save.config, elapsedMs: save.elapsedMs, players: save.players, engine: engineMeta }),
  );
  const total = save.config.n * save.config.n;
  const out = Buffer.alloc(8 + header.length + total * ARRAYS);
  out.set(MAGIC, 0);
  out.writeUInt32LE(header.length, 4);
  header.copy(out, 8);
  let at = 8 + header.length;
  for (const a of [mines, state, bonus, flagOwner]) {
    out.set(a, at);
    at += total;
  }
  return gzipSync(out);
}

/** @throws si le contenu est illisible ou incohérent. */
export function decodeSave(blob: Uint8Array): RoomSave {
  const raw = gunzipSync(blob, { maxOutputLength: MAX_RAW });
  if (raw.length < 8 || MAGIC.some((b, k) => raw[k] !== b)) throw new Error('format inconnu');
  const headerLen = raw.readUInt32LE(4);
  if (8 + headerLen > raw.length) throw new Error('en-tête tronqué');
  const h = JSON.parse(raw.subarray(8, 8 + headerLen).toString('utf8'));
  if (h?.v !== 1) throw new Error('version inconnue');

  const n = h.config?.n;
  const mineCount = h.config?.mineCount;
  if (!Number.isInteger(n) || n < MIN_N || n > MAX_N) throw new Error('largeur invalide');
  if (!Number.isInteger(mineCount) || mineCount < 1 || mineCount >= n * n) throw new Error('mines invalides');
  const config: NetConfig = { n, mineCount, bonus: h.config.bonus === true };

  const total = n * n;
  let at = 8 + headerLen;
  if (raw.length !== at + total * ARRAYS) throw new Error('plateau tronqué');
  // Copies : `raw` est un tampon unique qu'on ne veut pas garder en vie.
  const take = () => {
    const a = new Uint8Array(raw.subarray(at, at + total));
    at += total;
    return a;
  };
  const mines = take();
  const state = take();
  const bonus = take();
  const flagOwner = take();

  const players: SavedPlayer[] = [];
  for (const p of Array.isArray(h.players) ? h.players : []) {
    if (!Number.isInteger(p?.id) || p.id < 1 || p.id > MAX_PLAYERS) continue;
    const key = typeof p.key === 'string' && PLAYER_KEY_RE.test(p.key) ? p.key : null;
    players.push({ id: p.id, key, name: String(p.name ?? '').slice(0, 24) || `Joueur ${p.id}` });
  }

  const e = h.engine ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inv = e.inventory;
  const stats: [PlayerId, PlayerStats][] = [];
  for (const entry of Array.isArray(e.stats) ? e.stats : []) {
    const [id, st] = Array.isArray(entry) ? entry : [];
    if (!Number.isInteger(id) || typeof st !== 'object' || st === null) continue;
    stats.push([
      id,
      {
        revealed: num(st.revealed),
        minesFound: num(st.minesFound),
        wrongFlags: num(st.wrongFlags),
        livesLost: num(st.livesLost),
        bonuses: num(st.bonuses),
        shieldsUsed: num(st.shieldsUsed),
      },
    ]);
  }

  return {
    config,
    elapsedMs: Math.max(0, num(h.elapsedMs)),
    players,
    engine: {
      seeded: e.seeded === true,
      flags: num(e.flags),
      defusedCount: num(e.defusedCount),
      inventory: inv && typeof inv === 'object' ? { lives: num(inv.lives), shields: num(inv.shields) } : null,
      stats,
      mines,
      state,
      bonus,
      flagOwner,
    },
  };
}
