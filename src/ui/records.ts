import { useEffect, useState } from 'react';
import type { RecordBoard, RecordEntry, RecordMode } from '../../shared/protocol';

/**
 * Classement des cartes prédéfinies (`GET /api/records`). Vide si l'adresse
 * est null ou si le serveur ne répond pas (hors ligne, serveur sans stockage).
 * Changer `refresh` relance la requête.
 */
export function useRecords(url: string | null, refresh = 0): RecordBoard[] {
  const [boards, setBoards] = useState<RecordBoard[]>([]);
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => setBoards(Array.isArray(data) ? (data as RecordBoard[]) : []))
      .catch(() => {
        /* hors ligne : pas de records à afficher */
      });
    return () => ctrl.abort();
  }, [url, refresh]);
  return boards;
}

export const recordsOf = (boards: RecordBoard[], preset: string, bonus: boolean, mode: RecordMode): RecordEntry[] =>
  boards.find((b) => b.preset === preset && b.bonus === bonus && b.mode === mode)?.entries ?? [];
