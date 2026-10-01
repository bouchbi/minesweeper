import { useState } from 'react';
import { densityPercent, MAX_N, PRESETS, validateConfig } from '../game/presets';
import type { NetworkSession } from '../net/NetworkSession';
import { PlayerList } from './PlayerList';

/**
 * Salle d'attente. L'hôte — le premier joueur connecté — choisit la carte et
 * lance ; les autres voient la configuration se mettre à jour en direct.
 */
type Props = { session: NetworkSession; code: string; onLeave: () => void };

export function LobbyScreen({ session, code, onLeave }: Props) {
  const isHost = session.canRestart;
  const [nText, setNText] = useState(String(session.config.n));
  const [minesText, setMinesText] = useState(String(session.config.mineCount));
  const [copied, setCopied] = useState(false);
  const inviteUrl = `${location.origin}/?room=${code}`;

  // Un invité suit la configuration de l'hôte ; l'hôte garde sa saisie.
  const n = isHost ? Number.parseInt(nText, 10) : session.config.n;
  const mineCount = isHost ? Number.parseInt(minesText, 10) : session.config.mineCount;
  const error = isHost ? validateConfig(n, mineCount) : null;

  // Le texte saisi est gardé tel quel (un champ vidé reste vide, et non
  // « NaN ») ; seule une configuration valide part au serveur.
  const push = (nextNText: string, nextMinesText: string) => {
    setNText(nextNText);
    setMinesText(nextMinesText);
    const nextN = Number.parseInt(nextNText, 10);
    const nextMines = Number.parseInt(nextMinesText, 10);
    if (!validateConfig(nextN, nextMines)) session.setConfig({ n: nextN, mineCount: nextMines });
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* presse-papiers refusé (http non local, permissions) : le lien reste sélectionnable */
    }
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

        <h2>
          Salle <span className="mono">{code}</span>
        </h2>
        <div className="invite">
          <input readOnly value={inviteUrl} onFocus={(e) => e.target.select()} aria-label="Lien d'invitation" />
          <button className="btn" type="button" onClick={copyInvite}>
            {copied ? 'Copié' : 'Copier le lien'}
          </button>
        </div>

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
                  onChange={(e) => push(e.target.value, minesText)}
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
                  onChange={(e) => push(nText, e.target.value)}
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
                  onClick={() => push(String(p.n), String(p.mineCount))}
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
