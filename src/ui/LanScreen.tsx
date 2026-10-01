import { useEffect, useReducer, useState } from 'react';
import { DEFAULT_NET_CONFIG } from '../../shared/protocol';
import { NetworkSession } from '../net/NetworkSession';
import { GameScreen } from './GameScreen';
import { LobbyScreen } from './LobbyScreen';

/**
 * Conteneur d'une partie réseau : détient la session pour toute sa durée et
 * bascule entre le lobby et le plateau selon la phase annoncée par le serveur.
 */
type Props = { url: string; name: string; code: string; onLeave: () => void };

export function LanScreen({ url, name, code, onLeave }: Props) {
  const [session] = useState(() => new NetworkSession(url, name, DEFAULT_NET_CONFIG));
  const [, forceRender] = useReducer((v: number) => v + 1, 0);

  useEffect(() => {
    const stop = session.subscribeState(forceRender);
    return () => {
      stop();
      session.dispose();
    };
  }, [session]);

  if (session.lastError) {
    return (
      <div className="home">
        <div className="home-card">
          <h1>Connexion impossible</h1>
          <p className="error">{session.lastError}</p>
          <button className="btn" onClick={onLeave}>
            Retour
          </button>
        </div>
      </div>
    );
  }

  if (session.phase === 'lobby') {
    return <LobbyScreen session={session} code={code} onLeave={onLeave} />;
  }

  return (
    <GameScreen
      session={session}
      config={session.config}
      onExit={onLeave}
      onRestart={() => session.restart()}
      onChangeMap={session.canRestart ? () => session.backToLobby() : null}
    />
  );
}
