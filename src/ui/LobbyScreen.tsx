import { useState } from 'react';
import { densityPercent, MAX_N, PRESETS, validateConfig } from '../game/presets';
import type { NetworkSession } from '../net/NetworkSession';
import { PlayerList } from './PlayerList';

/**
 * Salle d'attente. L'hôte — le premier joueur connecté — choisit la carte et
 * lance ; les autres voient la configuration se mettre à jour en direct.
 */
export function LobbyScreen({ session, onLeave }: { session: NetworkSession; onLeave: () => void }) {
  const isHost = session.canRestart;
  const [nText, setNText] = useState(String(session.config.n));
  const [minesText, setMinesText] = useState(String(session.config.mineCount));

  // Un invité suit la configuration de l'hôte ; l'hôte garde sa saisie.
  const n = isHost ? Number.parseInt(nText, 10) : session.config.n;
  const mineCount = isHost ? Number.parseInt(minesText, 10) : session.config.mineCount;
  const error = isHost ? validateConfig(n, mineCount) : null;

  const push = (nextN: number, nextMines: number) => {
    setNText(String(nextN));
    setMinesText(String(nextMines));
    if (!validateConfig(nextN, nextMines)) session.setConfig({ n: nextN, mineCount: nextMines });
  };

  return (
    <div className="home">
      <div className="home-card">
        <h1>Partie en réseau</h1>
        <p className="subtitle">
          {session.connection === 'online'
            ? 'Connecté. Les autres joueurs peuvent rejoindre avec la même adresse.'
            : session.connection === 'lost'
              ? 'Connexion perdue — reconnexion en cours…'
              : 'Connexion au serveur…'}
        </p>

        <h2>Joueurs ({session.players.length})</h2>
        <PlayerList players={session.players} selfId={session.selfId} />

        <h2>Carte</h2>
        {isHost ? (
          <>
            <div className="fields">
              <label className="field">
                <span>Largeur de la carte</span>
                <input
                  type="number"
                  value={nText}
                  min={5}
                  max={MAX_N}
                  onChange={(e) => push(Number.parseInt(e.target.value, 10), mineCount)}
                />
                <small>
                  {Number.isFinite(n) && n > 0 ? `${n} × ${n} = ${(n * n).toLocaleString('fr-FR')} cases` : ' '}
                </small>
              </label>
              <label className="field">
                <span>Nombre de bombes</span>
                <input
                  type="number"
                  value={minesText}
                  min={1}
                  onChange={(e) => push(n, Number.parseInt(e.target.value, 10))}
                />
                <small>{!error ? `densité ${densityPercent(n, mineCount).toFixed(1)} %` : ' '}</small>
              </label>
            </div>
            {error && <p className="error">{error}</p>}
            <div className="presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset${p.n === n && p.mineCount === mineCount ? ' active' : ''}`}
                  onClick={() => push(p.n, p.mineCount)}
                >
                  <strong>{p.name}</strong>
                  <span className="mono">
                    {p.n}×{p.n} · {p.mineCount.toLocaleString('fr-FR')} bombes
                  </span>
                </button>
              ))}
            </div>
            <button
              className="btn btn-primary"
              disabled={!!error || session.connection !== 'online'}
              onClick={() => session.start()}
            >
              Lancer la partie
            </button>
          </>
        ) : (
          <p className="warn">
            {session.config.n}×{session.config.n} ·{' '}
            {session.config.mineCount.toLocaleString('fr-FR')} bombes — en attente de l'hôte.
          </p>
        )}

        <button className="btn lobby-leave" onClick={onLeave}>
          Quitter
        </button>
      </div>
    </div>
  );
}
