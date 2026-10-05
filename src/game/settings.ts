import { MAX_N, MIN_N } from './presets';

const KEY = 'minesweeper:last-config';

export type StoredConfig = { n: number; mineCount: number; bonus: boolean };

/**
 * Derniers paramètres joués, pour les represélectionner à l'accueil.
 *
 * localStorage jette dans plusieurs contextes réels (navigation privée sur
 * certains navigateurs, cookies tiers bloqués, quota plein) : toute la lecture
 * comme l'écriture est protégée, et l'absence de stockage se traduit
 * simplement par le retour aux valeurs par défaut.
 */
export function loadLastConfig(): StoredConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { n, mineCount, bonus } = parsed as Partial<StoredConfig>;
    // Revalidé à la lecture : le stockage peut avoir été écrit par une version
    // antérieure, ou édité à la main.
    if (!Number.isInteger(n) || !Number.isInteger(mineCount)) return null;
    if (n! < MIN_N || n! > MAX_N) return null;
    if (mineCount! < 1 || mineCount! >= n! * n!) return null;
    // Absent des configurations enregistrées avant l'arrivée des bonus.
    return { n: n!, mineCount: mineCount!, bonus: bonus === true };
  } catch {
    return null;
  }
}

export function saveLastConfig(config: StoredConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    /* stockage indisponible : on joue sans mémoire, c'est tout */
  }
}

/* ── Joueur ─────────────────────────────────────────────────────────── */

const PLAYER_KEY = 'minesweeper:player-key';
const NAME_KEY = 'minesweeper:name';
const SOLO_KEY = 'minesweeper:solo-room';

/** Clé de ce navigateur, envoyée au serveur pour retrouver sa place dans une
 *  salle (voir PLAYER_KEY_RE). Sans stockage, une clé neuve par chargement :
 *  on perd seulement la continuité. */
let sessionKey: string | null = null;
export function playerKey(): string {
  try {
    const stored = localStorage.getItem(PLAYER_KEY);
    if (stored && /^[a-z0-9]{16,64}$/.test(stored)) return stored;
  } catch {
    /* repli plus bas */
  }
  if (!sessionKey) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    sessionKey = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    localStorage.setItem(PLAYER_KEY, sessionKey);
  } catch {
    /* stockage indisponible */
  }
  return sessionKey;
}

export function loadName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) ?? '').slice(0, 24);
  } catch {
    return '';
  }
}

export function saveName(name: string): void {
  try {
    if (name.trim()) localStorage.setItem(NAME_KEY, name.trim().slice(0, 24));
  } catch {
    /* stockage indisponible */
  }
}

/** Dernière partie solo classée en cours, pour la reprendre depuis l'accueil. */
export type SoloRoom = { code: string; preset: string };

export function loadSoloRoom(): SoloRoom | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SOLO_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { code, preset } = parsed as Partial<SoloRoom>;
    return typeof code === 'string' && typeof preset === 'string' ? { code, preset } : null;
  } catch {
    return null;
  }
}

export function saveSoloRoom(room: SoloRoom | null): void {
  try {
    if (room) localStorage.setItem(SOLO_KEY, JSON.stringify(room));
    else localStorage.removeItem(SOLO_KEY);
  } catch {
    /* stockage indisponible */
  }
}
