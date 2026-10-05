import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RECORD_TOP, type RecordBoard, type RecordEntry, type RecordMode } from '../shared/protocol';

/**
 * Stockage durable du serveur : parties mises de côté et records.
 *
 * SQLite (intégré à Node 22) plutôt que des fichiers : une écriture est
 * atomique — un conteneur tué en pleine sauvegarde ne laisse pas de fichier à
 * moitié écrit — et le classement est une simple requête. Tout tient dans
 * `${DATA_DIR}/minesweeper.db`, à placer sur un volume persistant.
 *
 * Toutes les méthodes sont synchrones : les écritures se font aussi depuis le
 * gestionnaire de SIGTERM, où l'on ne peut plus rien attendre.
 */
export class Store {
  private db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'minesweeper.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS saves (
        code TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL,
        data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        preset TEXT NOT NULL,
        bonus INTEGER NOT NULL,
        mode TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL,
        names TEXT NOT NULL,
        finished_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_by_board ON records (preset, bonus, mode, elapsed_ms);
    `);
  }

  close(): void {
    this.db.close();
  }

  /* ── Parties mises de côté ────────────────────────────────────────── */

  hasSave(code: string): boolean {
    return this.db.prepare('SELECT 1 FROM saves WHERE code = ?').get(code) !== undefined;
  }

  loadSave(code: string): Uint8Array | null {
    const row = this.db.prepare('SELECT data FROM saves WHERE code = ?').get(code) as { data: Uint8Array } | undefined;
    return row?.data ?? null;
  }

  /** Écrit (ou remplace) une sauvegarde. Au-delà de `maxSaves`, les plus
   *  anciennes sont supprimées : le disque reste borné même si quelqu'un
   *  ouvre des parties en rafale. */
  writeSave(code: string, data: Uint8Array, maxSaves: number): void {
    this.db
      .prepare('INSERT INTO saves (code, updated_at, data) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data')
      .run(code, Date.now(), data);
    this.db
      .prepare('DELETE FROM saves WHERE code NOT IN (SELECT code FROM saves ORDER BY updated_at DESC LIMIT ?)')
      .run(maxSaves);
  }

  deleteSave(code: string): void {
    this.db.prepare('DELETE FROM saves WHERE code = ?').run(code);
  }

  /** @returns le nombre de sauvegardes supprimées. */
  purgeSaves(olderThan: number): number {
    return Number(this.db.prepare('DELETE FROM saves WHERE updated_at < ?').run(olderThan).changes);
  }

  /* ── Records ──────────────────────────────────────────────────────── */

  /** Place qu'obtiendrait ce temps (1 = meilleur). À temps égal, le plus
   *  ancien garde l'avantage. */
  rankFor(preset: string, bonus: boolean, mode: RecordMode, elapsedMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM records WHERE preset = ? AND bonus = ? AND mode = ? AND elapsed_ms <= ?')
      .get(preset, bonus ? 1 : 0, mode, elapsedMs) as { c: number };
    return Number(row.c) + 1;
  }

  /** Inscrit un record et ne garde que les RECORD_TOP meilleurs de sa
   *  catégorie. @returns son identifiant. */
  addRecord(preset: string, bonus: boolean, mode: RecordMode, elapsedMs: number, names: string[]): number {
    const b = bonus ? 1 : 0;
    const id = Number(
      this.db
        .prepare('INSERT INTO records (preset, bonus, mode, elapsed_ms, names, finished_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(preset, b, mode, Math.round(elapsedMs), JSON.stringify(names), Date.now()).lastInsertRowid,
    );
    this.db
      .prepare(
        `DELETE FROM records WHERE preset = ? AND bonus = ? AND mode = ? AND id NOT IN (
           SELECT id FROM records WHERE preset = ? AND bonus = ? AND mode = ? ORDER BY elapsed_ms, id LIMIT ?)`,
      )
      .run(preset, b, mode, preset, b, mode, RECORD_TOP);
    return id;
  }

  renameRecord(id: number, names: string[]): void {
    this.db.prepare('UPDATE records SET names = ? WHERE id = ?').run(JSON.stringify(names), id);
  }

  /** Tous les records avec leur identifiant, pour la modération. */
  listRecords(): { id: number; preset: string; bonus: boolean; mode: RecordMode; elapsedMs: number; names: string[] }[] {
    const rows = this.db
      .prepare('SELECT id, preset, bonus, mode, elapsed_ms, names FROM records ORDER BY preset, bonus, mode, elapsed_ms, id')
      .all() as { id: number; preset: string; bonus: number; mode: RecordMode; elapsed_ms: number; names: string }[];
    return rows.map((r) => ({
      id: r.id,
      preset: r.preset,
      bonus: r.bonus === 1,
      mode: r.mode,
      elapsedMs: r.elapsed_ms,
      names: parseNames(r.names),
    }));
  }

  deleteRecord(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM records WHERE id = ?').run(id).changes) > 0;
  }

  /** Les `limit` meilleurs temps de chaque catégorie. */
  allRecords(limit: number): RecordBoard[] {
    const rows = this.db
      .prepare('SELECT preset, bonus, mode, elapsed_ms, names, finished_at FROM records ORDER BY preset, bonus, mode, elapsed_ms, id')
      .all() as { preset: string; bonus: number; mode: RecordMode; elapsed_ms: number; names: string; finished_at: number }[];
    const boards = new Map<string, RecordBoard>();
    for (const r of rows) {
      const k = `${r.preset}|${r.bonus}|${r.mode}`;
      let board = boards.get(k);
      if (!board) boards.set(k, (board = { preset: r.preset, bonus: r.bonus === 1, mode: r.mode, entries: [] }));
      if (board.entries.length >= limit) continue;
      const entry: RecordEntry = { names: parseNames(r.names), elapsedMs: r.elapsed_ms, finishedAt: r.finished_at };
      board.entries.push(entry);
    }
    return [...boards.values()];
  }
}

function parseNames(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
