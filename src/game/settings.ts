import { MAX_N, MIN_N } from './presets';

const KEY = 'minesweeper:last-config';

export type StoredConfig = { n: number; mineCount: number };

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
    const { n, mineCount } = parsed as Partial<StoredConfig>;
    // Revalidé à la lecture : le stockage peut avoir été écrit par une version
    // antérieure, ou édité à la main.
    if (!Number.isInteger(n) || !Number.isInteger(mineCount)) return null;
    if (n! < MIN_N || n! > MAX_N) return null;
    if (mineCount! < 1 || mineCount! >= n! * n!) return null;
    return { n: n!, mineCount: mineCount! };
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
