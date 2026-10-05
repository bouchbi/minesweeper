import { useMemo, useState } from 'react';
import { densityPercent, MAX_N, PRESETS, validateConfig } from '../game/presets';
import { loadLastConfig, loadName, loadSoloRoom, saveLastConfig, saveName } from '../game/settings';
import { normalizeRoomCode, type RecordBoard } from '../../shared/protocol';
import type { GameConfig } from './GameScreen';
import { formatDuration } from './Hud';
import { recordsOf, useRecords } from './records';

/** Au-delà, on prévient sans bloquer : ça reste jouable, juste très grand. */
const HUGE_CELLS = 100_000;

/** Utilisé quand rien n'a encore été joué sur cette machine. */
const DEFAULT_CONFIG: GameConfig = { n: 100, mineCount: 2000, bonus: false };

const presetIdFor = (n: number, mineCount: number): string | null =>
  PRESETS.find((p) => p.n === n && p.mineCount === mineCount)?.id ?? null;

/** Serveur de jeu par défaut : celui qui sert la page (LAN ou VPS), sauf en
 *  développement où Vite occupe le 5173 et le serveur écoute sur 8080. */
function defaultServer(): string {
  if (typeof location === 'undefined') return 'localhost:8080';
  return location.port === '5173' ? `${location.hostname}:8080` : location.host;
}

/** Carte de test des bonus : visible en développement (Vite sur le 5173,
 *  comme pour `defaultServer`), ou partout avec `?test` dans l'URL. */
const SHOW_TEST =
  typeof location !== 'undefined' &&
  (location.port === '5173' || new URLSearchParams(location.search).has('test'));
const TEST_CONFIG: GameConfig = { n: 20, mineCount: 50, bonus: true, testBonuses: true };

/** Code reçu par un lien d'invitation (`/?room=abc123`). */
function invitedRoom(): string {
  if (typeof location === 'undefined') return '';
  return normalizeRoomCode(new URLSearchParams(location.search).get('room')) ?? '';
}

function serverHost(server: string): string | null {
  return server.trim().replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
}

/** @param query `room=<code>` pour rejoindre, `create=1…` pour créer. */
function wsUrl(server: string, query: string): string | null {
  const host = serverHost(server);
  if (!host) return null;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${host}/ws?${query}`;
}

/** Partie en réseau à ouvrir. `solo` : partie classée d'un seul joueur sur
 *  une carte prédéfinie, lancée sans lobby. */
export type LanTarget = {
  url: string;
  name: string;
  /** `config` permet de rejouer hors ligne si le serveur ne répond pas ;
   *  null pour la reprise d'une partie, qui n'existe que sur le serveur. */
  solo: { preset: string; config: GameConfig | null } | null;
};

type HomeProps = {
  onStart: (config: GameConfig) => void;
  onJoinLan: (target: LanTarget) => void;
};

export function HomeScreen({ onStart, onJoinLan }: HomeProps) {
  // Lu une seule fois au montage : revenir à l'accueil ne doit pas écraser ce
  // que le joueur est en train de saisir.
  const [initial] = useState(() => loadLastConfig() ?? DEFAULT_CONFIG);
  const [nText, setNText] = useState(String(initial.n));
  const [minesText, setMinesText] = useState(String(initial.mineCount));
  const [bonus, setBonus] = useState(initial.bonus);
  const [activePreset, setActivePreset] = useState<string | null>(() =>
    presetIdFor(initial.n, initial.mineCount),
  );
  const [server, setServer] = useState(defaultServer);
  const [playerName, setPlayerName] = useState(loadName);
  const [roomText, setRoomText] = useState(invitedRoom);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [soloRoom] = useState(loadSoloRoom);
  const host = serverHost(server);
  const records = useRecords(host ? `${location.protocol}//${host}/api/records` : null);

  const connect = (query: string, solo: LanTarget['solo'] = null) => {
    const url = wsUrl(server, query);
    if (!url) {
      setRoomError('Adresse du serveur manquante.');
      return;
    }
    setRoomError(null);
    saveName(playerName);
    onJoinLan({ url, name: playerName.trim() || 'Joueur', solo });
  };

  const joinRoom = (code: string | null) => {
    if (!code) {
      setRoomError('Le code de salle fait 4 à 12 lettres ou chiffres.');
      return;
    }
    connect(`room=${encodeURIComponent(code)}`);
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

  const preset = PRESETS.find((p) => p.n === n && p.mineCount === mineCount) ?? null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (error) return;
    const config = { n, mineCount, bonus };
    saveLastConfig(config);
    // Carte prédéfinie : la partie se joue sur le serveur, seul juge du temps,
    // pour pouvoir être classée (et reprise plus tard). Les autres restent
    // dans le navigateur.
    if (preset) connect(`create=1&preset=${preset.id}&bonus=${bonus ? 1 : 0}`, { preset: preset.id, config });
    else onStart(config);
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

          <BonusToggle checked={bonus} onChange={setBonus} />

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
          {!error && (
            <small className="ranked-hint">
              {preset
                ? `Partie classée « ${preset.name} »${bonus ? ' avec bonus' : ''}, sauvegardée si tu la quittes.`
                : 'Carte personnalisée : partie non classée.'}
            </small>
          )}
        </form>

        {soloRoom && (
          <button
            type="button"
            className="btn resume"
            onClick={() => connect(`room=${encodeURIComponent(soloRoom.code)}`, { preset: soloRoom.preset, config: null })}
          >
            Reprendre ta partie {PRESETS.find((p) => p.id === soloRoom.preset)?.name ?? ''}{' '}
            <span className="mono muted">{soloRoom.code}</span>
          </button>
        )}

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
          <button className="btn" type="button" onClick={() => connect('create=1')}>
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

        {SHOW_TEST && (
          <>
            <h2>Test</h2>
            <div className="presets">
              <button type="button" className="preset" onClick={() => onStart(TEST_CONFIG)}>
                <strong>Test des bonus</strong>
                <span className="mono">20×20 · 50 bombes</span>
                <small>2 bonus de chaque type, en bordure de la première zone ouverte</small>
              </button>
            </div>
          </>
        )}

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
              <BestTime entry={recordsOf(records, p.id, bonus, 'solo')[0]} />
            </button>
          ))}
        </div>

        {records.length > 0 && <RecordsTable boards={records} />}
      </div>
    </div>
  );
}

/** Case à cocher « Bonus », partagée par l'accueil et le lobby. */
export function BonusToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>Bonus</strong>
        <small>
          Boucliers, vies et boules à facettes cachés sous des cases sûres. Conseillé sur les
          grandes cartes.
        </small>
      </span>
    </label>
  );
}

/** Meilleur temps solo d'une carte, sous son bouton. */
function BestTime({ entry }: { entry: RecordBoard['entries'][number] | undefined }) {
  if (!entry) return null;
  return (
    <small className="best-time">
      🏆 <span className="mono">{formatDuration(entry.elapsedMs)}</span> · {entry.names.join(', ')}
    </small>
  );
}

/** Classement complet des cartes prédéfinies, replié par défaut. */
function RecordsTable({ boards }: { boards: RecordBoard[] }) {
  const sections = PRESETS.flatMap((p) =>
    boards
      .filter((b) => b.preset === p.id && b.entries.length > 0)
      .sort((a, b) => Number(a.bonus) - Number(b.bonus) || a.mode.localeCompare(b.mode))
      .map((b) => ({ ...b, name: p.name })),
  );
  return (
    <details className="records">
      <summary>Records</summary>
      {sections.map((b) => (
        <div key={`${b.preset}|${b.bonus}|${b.mode}`} className="records-board">
          <h3>
            {b.name} · {b.mode === 'solo' ? 'solo' : 'co-op'}
            {b.bonus ? ' · bonus' : ''}
          </h3>
          <ol>
            {b.entries.map((e, k) => (
              <li key={k}>
                <span className="mono">{formatDuration(e.elapsedMs)}</span>
                <span>{e.names.join(', ')}</span>
                <small className="muted">{new Date(e.finishedAt).toLocaleDateString('fr-FR')}</small>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </details>
  );
}
