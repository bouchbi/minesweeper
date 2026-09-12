import type { PlayerId, PlayerInfo } from '../../shared/protocol';

/** Pastilles colorées dans le HUD. Rien n'est rendu en solo. */
export function PlayerList({ players, selfId }: { players: PlayerInfo[]; selfId: PlayerId }) {
  if (players.length === 0) return null;
  return (
    <div className="players">
      {players.map((p) => (
        <span
          key={p.id}
          className={`player${p.connected ? '' : ' offline'}${p.id === selfId ? ' self' : ''}`}
          title={p.connected ? undefined : 'déconnecté'}
        >
          <i className="dot" style={{ background: p.color }} />
          {p.name}
          {p.isHost && <b className="host" title="hôte">★</b>}
        </span>
      ))}
    </div>
  );
}
