import { useState } from 'react';
import { PRESETS } from '../game/presets';
import { loadName, saveName } from '../game/settings';
import type { Session } from '../game/session';
import { formatDuration } from './Hud';

const ordinal = (rank: number) => (rank === 1 ? '1ʳᵉ' : `${rank}ᵉ`);

/**
 * Bilan affiché par-dessus le plateau à la fin d'une partie : temps, place au
 * classement, et compteurs de chaque joueur. Se ferme pour regarder la carte.
 */
export function EndPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const { over, record, endStats } = session;
  const presetName = record ? (PRESETS.find((p) => p.id === record.preset)?.name ?? record.preset) : null;
  const canName = record !== null && record.nameable !== null && record.nameable === session.selfId;
  const self = session.players.find((p) => p.id === session.selfId);
  const [name, setName] = useState(() => loadName() || self?.name || '');
  const [named, setNamed] = useState(false);

  if (!over) return null;
  const stats = endStats ?? [];
  const coop = stats.length > 1;

  return (
    <div className={`end-panel end-${over}`} role="dialog" aria-label="Bilan de la partie">
      <button className="end-close" type="button" onClick={onClose} aria-label="Fermer le bilan">
        ×
      </button>
      <h2>
        {over === 'won' ? 'Gagné' : 'Perdu'} <span className="mono">{formatDuration(session.elapsedMs())}</span>
      </h2>

      {record && (
        <p className="end-record">
          🏆 {ordinal(record.rank)} place · {presetName} {record.mode === 'solo' ? 'solo' : 'co-op'}
          {record.bonus ? ' avec bonus' : ''}
        </p>
      )}
      {canName &&
        (named ? (
          <p className="muted">Nom enregistré au classement.</p>
        ) : (
          <form
            className="end-name"
            onSubmit={(e) => {
              e.preventDefault();
              const clean = name.trim();
              if (!clean) return;
              session.nameRecord(clean);
              saveName(clean);
              setNamed(true);
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
              Inscrire
            </button>
          </form>
        ))}
      {over === 'won' && session.connection === 'local' && (
        <p className="muted end-note">Partie jouée hors ligne ou sur carte personnalisée : non classée.</p>
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
    </div>
  );
}
