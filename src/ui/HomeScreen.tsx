import { useMemo, useState } from 'react';
import { densityPercent, MAX_N, PRESETS, validateConfig } from '../game/presets';
import { loadLastConfig, saveLastConfig } from '../game/settings';
import { normalizeRoomCode, randomRoomCode } from '../../shared/protocol';
import type { GameConfig } from './GameScreen';

/** Au-delà, on prévient sans bloquer : ça reste jouable, juste très grand. */
const HUGE_CELLS = 100_000;

/** Utilisé quand rien n'a encore été joué sur cette machine. */
const DEFAULT_CONFIG: GameConfig = { n: 100, mineCount: 2000 };

const presetIdFor = (n: number, mineCount: number): string | null =>
  PRESETS.find((p) => p.n === n && p.mineCount === mineCount)?.id ?? null;

/** Serveur de jeu par défaut : celui qui sert la page (LAN ou VPS), sauf en
 *  développement où Vite occupe le 5173 et le serveur écoute sur 8080. */
function defaultServer(): string {
  if (typeof location === 'undefined') return 'localhost:8080';
  return location.port === '5173' ? `${location.hostname}:8080` : location.host;
}

/** Code reçu par un lien d'invitation (`/?room=abc123`). */
function invitedRoom(): string {
  if (typeof location === 'undefined') return '';
  return normalizeRoomCode(new URLSearchParams(location.search).get('room')) ?? '';
}

function wsUrl(server: string, code: string): string | null {
  const host = server.trim().replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host) return null;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${host}/ws?room=${encodeURIComponent(code)}`;
}

type HomeProps = {
  onStart: (config: GameConfig) => void;
  onJoinLan: (url: string, name: string, code: string) => void;
};

export function HomeScreen({ onStart, onJoinLan }: HomeProps) {
  // Lu une seule fois au montage : revenir à l'accueil ne doit pas écraser ce
  // que le joueur est en train de saisir.
  const [initial] = useState(() => loadLastConfig() ?? DEFAULT_CONFIG);
  const [nText, setNText] = useState(String(initial.n));
  const [minesText, setMinesText] = useState(String(initial.mineCount));
  const [activePreset, setActivePreset] = useState<string | null>(() =>
    presetIdFor(initial.n, initial.mineCount),
  );
  const [server, setServer] = useState(defaultServer);
  const [playerName, setPlayerName] = useState('');
  const [roomText, setRoomText] = useState(invitedRoom);
  const [roomError, setRoomError] = useState<string | null>(null);

  const joinRoom = (code: string | null) => {
    if (!code) {
      setRoomError('Le code de salle fait 4 à 12 lettres ou chiffres.');
      return;
    }
    const url = wsUrl(server, code);
    if (!url) {
      setRoomError('Adresse du serveur manquante.');
      return;
    }
    setRoomError(null);
    onJoinLan(url, playerName.trim() || 'Joueur', code);
  };

  const n = Number.parseInt(nText, 10);
  const mineCount = Number.parseInt(minesText, 10);
  const error = useMemo(() => validateConfig(n, mineCount), [n, mineCount]);

  const total = Number.isFinite(n) && n > 0 && n <= MAX_N ? n * n : null;
  const density =
    !error && total !== null ? densityPercent(n, mineCount) : null;

  const applyPreset = (id: string, pn: number, pm: number) => {
    setNText(String(pn));
    setMinesText(String(pm));
    setActivePreset(id);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (error) return;
    saveLastConfig({ n, mineCount });
    onStart({ n, mineCount });
  };

  return (
    <div className="home">
      <div className="home-card">
        <h1>Démineur</h1>
        <p className="subtitle">
          Cartes carrées, densité de bombes libre, zoom et navigation au clavier.
        </p>

        <form onSubmit={submit}>
          <div className="fields">
            <label className="field">
              <span>Largeur de la carte</span>
              <input
                type="number"
                inputMode="numeric"
                value={nText}
                min={5}
                max={MAX_N}
                onChange={(e) => {
                  setNText(e.target.value);
                  setActivePreset(null);
                }}
              />
              <small>
                {total === null
                  ? ' '
                  : `${n} × ${n} = ${total.toLocaleString('fr-FR')} cases`}
              </small>
            </label>

            <label className="field">
              <span>Nombre de bombes</span>
              <input
                type="number"
                inputMode="numeric"
                value={minesText}
                min={1}
                onChange={(e) => {
                  setMinesText(e.target.value);
                  setActivePreset(null);
                }}
              />
              <small>
                {density === null ? ' ' : `densité ${density.toFixed(1)} %`}
              </small>
            </label>
          </div>

          {error && <p className="error">{error}</p>}
          {!error && total !== null && total > HUGE_CELLS && (
            <p className="warn">
              {total.toLocaleString('fr-FR')} cases : la carte est énorme, pense à la
              touche <kbd>0</kbd> pour revenir à la vue globale.
            </p>
          )}

          <button className="btn btn-primary" type="submit" disabled={!!error}>
            Jouer
          </button>
        </form>

        <h2>Jouer à plusieurs</h2>
        <p className="lan-help">
          Tous les joueurs d'une salle creusent la même carte. Crée une salle et partage son
          code, ou saisis celui qu'on t'a donné.
        </p>
        <form
          className="lan-form"
          onSubmit={(e) => {
            e.preventDefault();
            joinRoom(normalizeRoomCode(roomText));
          }}
        >
          <label className="field">
            <span>Code de salle</span>
            <input
              value={roomText}
              onChange={(e) => setRoomText(e.target.value)}
              placeholder="abc123"
              maxLength={12}
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Ton pseudo</span>
            <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="Joueur" maxLength={24} />
          </label>
          <button className="btn" type="submit">Rejoindre</button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              const code = randomRoomCode();
              setRoomText(code);
              joinRoom(code);
            }}
          >
            Créer une salle
          </button>
        </form>
        {roomError && <p className="error">{roomError}</p>}
        <details className="lan-advanced">
          <summary>Avancé</summary>
          <label className="field">
            <span>Adresse du serveur</span>
            <input value={server} onChange={(e) => setServer(e.target.value)} placeholder="192.168.1.10:8080" />
          </label>
        </details>

        <h2>Dispositions</h2>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`preset${activePreset === p.id ? ' active' : ''}`}
              onClick={() => applyPreset(p.id, p.n, p.mineCount)}
            >
              <strong>{p.name}</strong>
              <span className="mono">
                {p.n}×{p.n} · {p.mineCount.toLocaleString('fr-FR')} bombes
              </span>
              <small>{p.note}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
