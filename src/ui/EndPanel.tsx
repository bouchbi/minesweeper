import { useEffect, useState } from 'react';
import { PRESETS } from '../game/presets';
import { loadName, saveName } from '../game/settings';
import type { GameConfig, Session } from '../game/session';
import type { RecordEntry } from '../../shared/protocol';
import { launchConfetti } from './confetti';
import { formatDuration } from './Hud';
import { recordsOf, useRecords } from './records';

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

type Props = {
  session: Session;
  config: GameConfig;
  onClose: () => void;
  onRestart: () => void;
  onMenu: () => void;
};

/**
 * Bilan de fin de partie, centré sur fond assombri : résultat, classement de
 * la carte, inscription de son nom, compteurs de chaque joueur. Se ferme
 * (croix, Échap) pour regarder la carte.
 */
export function EndPanel({ session, config, onClose, onRestart, onMenu }: Props) {
  const { over, record, endStats } = session;
  const stats = endStats ?? [];
  const coop = stats.length > 1;
  const won = over === 'won';

  const preset = PRESETS.find((p) => p.n === config.n && p.mineCount === config.mineCount) ?? null;
  const mode = record?.mode ?? (coop ? 'coop' : 'solo');
  const canName = record !== null && record.nameable !== null && record.nameable === session.selfId;
  const self = session.players.find((p) => p.id === session.selfId);
  const [name, setName] = useState(() => loadName() || self?.name || '');
  const [named, setNamed] = useState<string | null>(null);

  const boards = useRecords(preset ? session.recordsUrl : null);
  const entries = preset ? recordsOf(boards, preset.id, config.bonus, mode) : [];

  useEffect(() => {
    if (!won || reducedMotion()) return;
    return launchConfetti();
  }, [won]);

  // Échap ferme le bilan au lieu de quitter la partie (raccourci du plateau,
  // écouté plus tard sur window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!over) return null;

  return (
    <div className="end-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`end-panel end-${over}`} role="dialog" aria-modal="true" aria-labelledby="end-title">
        <button className="end-close" type="button" onClick={onClose} aria-label="Fermer le bilan">
          ×
        </button>

        <h2 id="end-title" className="end-title">
          {won ? 'Gagné' : 'Perdu'}
        </h2>
        <p className="end-time mono">{formatDuration(session.elapsedMs())}</p>

        {record && (
          <p className="end-record">
            🏆 {ordinal(record.rank)} place au classement
          </p>
        )}

        {canName &&
          (named ? (
            <p className="end-note">Nom inscrit au classement.</p>
          ) : (
            <form
              className="end-name"
              onSubmit={(e) => {
                e.preventDefault();
                const clean = name.trim();
                if (!clean) return;
                session.nameRecord(clean);
                saveName(clean);
                setNamed(clean);
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ton pseudo"
                maxLength={24}
                autoFocus
                aria-label="Nom pour le classement"
              />
              <button className="btn btn-accent" type="submit" disabled={!name.trim()}>
                Inscrire mon nom
              </button>
            </form>
          ))}

        {preset && session.connection !== 'local' && (
          <Leaderboard
            title={`${preset.name} · ${mode === 'solo' ? 'solo' : 'co-op'}${config.bonus ? ' · bonus' : ''}`}
            entries={entries}
            mine={record ? { rank: record.rank, elapsedMs: session.elapsedMs(), rename: named } : null}
          />
        )}
        {session.connection === 'local' && (
          <p className="end-note">Partie hors ligne ou carte personnalisée : non classée.</p>
        )}

        {stats.length > 0 && (
          <table className="end-stats">
            <thead>
              <tr>
                {coop && <th>Joueur</th>}
                <th title="Cases ouvertes, hors cascade du premier clic">Cases</th>
                <th title="Drapeaux justes encore en place et mines désamorcées au bouclier">Bombes</th>
                <th title="Mines touchées et drapeaux posés sur une case sûre">Erreurs</th>
                <th title="Bonus ramassés">Bonus</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.id}>
                  {coop && (
                    <td>
                      <b style={{ color: s.color }}>{s.name}</b>
                    </td>
                  )}
                  <td className="mono">{s.revealed.toLocaleString('fr-FR')}</td>
                  <td className="mono">{s.minesFound.toLocaleString('fr-FR')}</td>
                  <td className="mono" title={`${s.livesLost} mine(s) touchée(s), ${s.wrongFlags} mauvais drapeau(x)`}>
                    {s.livesLost + s.wrongFlags}
                  </td>
                  <td className="mono">{s.bonuses}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="end-actions">
          {session.canRestart ? (
            <button className="btn btn-primary" type="button" onClick={onRestart}>
              Rejouer
            </button>
          ) : (
            <button className="btn" type="button" disabled title="Seul l'hôte peut relancer la partie">
              En attente de l'hôte
            </button>
          )}
          <button className="btn" type="button" onClick={onMenu}>
            Menu principal
          </button>
        </div>
      </div>
    </div>
  );
}

const ordinal = (rank: number) => (rank === 1 ? '1ʳᵉ' : `${rank}ᵉ`);

/**
 * Meilleurs temps de la carte. La partie qui vient d'être classée est mise en
 * avant ; au-delà des lignes renvoyées par le serveur, elle est ajoutée en bas.
 */
function Leaderboard({
  title,
  entries,
  mine,
}: {
  title: string;
  entries: RecordEntry[];
  mine: { rank: number; elapsedMs: number; rename: string | null } | null;
}) {
  const rows = entries.map((e, k) => ({ rank: k + 1, names: e.names, elapsedMs: e.elapsedMs }));
  if (mine && mine.rank > rows.length) {
    rows.push({ rank: mine.rank, names: [mine.rename ?? 'Toi'], elapsedMs: mine.elapsedMs });
  }
  return (
    <div className="end-board">
      <h3>Classement · {title}</h3>
      {rows.length === 0 ? (
        <p className="end-note">Aucun temps enregistré pour l'instant.</p>
      ) : (
        <ol>
          {rows.map((r) => {
            const isMine = mine?.rank === r.rank;
            // Le serveur a déjà le nouveau nom, mais la liste a été chargée
            // avant : on l'affiche sans recharger.
            const names = isMine && mine.rename ? [mine.rename] : r.names;
            return (
              <li key={r.rank} className={isMine ? 'mine' : ''}>
                <span className="end-rank">{r.rank}</span>
                <span className="end-names">{names.join(', ')}</span>
                <span className="mono">{formatDuration(r.elapsedMs)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
