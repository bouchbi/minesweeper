import { useEffect, useReducer, useState } from 'react';
import { DEFAULT_NET_CONFIG } from '../../shared/protocol';
import { playerKey, saveSoloRoom } from '../game/settings';
import { NetworkSession } from '../net/NetworkSession';
import { GameScreen } from './GameScreen';
import { LobbyScreen } from './LobbyScreen';

/**
 * Conteneur d'une partie réseau : détient la session pour toute sa durée et
 * bascule entre le lobby et le plateau selon la phase annoncée par le serveur.
 *
 * `solo` : partie classée sur une carte prédéfinie. Le serveur la lance sans
 * lobby ; elle est gardée en mémoire pour être reprise depuis l'accueil.
 */
type Props = {
  url: string;
  name: string;
  solo: { preset: string } | null;
  onLeave: () => void;
  /** Rejouer la même carte dans le navigateur si le serveur est injoignable. */
  onOffline: (() => void) | null;
};

export function LanScreen({ url, name, solo, onLeave, onOffline }: Props) {
  const [session] = useState(() => new NetworkSession(url, name, playerKey(), DEFAULT_NET_CONFIG));
  const [, forceRender] = useReducer((v: number) => v + 1, 0);
  const { code, phase, lastError } = session;

  useEffect(() => {
    const stop = session.subscribeState(forceRender);
    return () => {
      stop();
      session.dispose();
    };
  }, [session]);

  // Code dans l'URL : la barre d'adresse sert de lien d'invitation, même en
  // pleine partie. replaceState pour ne pas créer d'entrée d'historique.
  useEffect(() => {
    if (!code) return;
    const setRoom = (value: string | null) => {
      const u = new URL(location.href);
      if (value) u.searchParams.set('room', value);
      else u.searchParams.delete('room');
      history.replaceState(history.state, '', u);
    };
    setRoom(code);
    return () => setRoom(null);
  }, [code]);

  // Partie solo à reprendre depuis l'accueil : oubliée dès qu'elle est finie,
  // ou si le serveur ne la connaît plus.
  useEffect(() => {
    if (!solo) return;
    if (lastError || phase === 'won' || phase === 'dead') saveSoloRoom(null);
    else if (code && phase === 'playing') saveSoloRoom({ code, preset: solo.preset });
  }, [solo, code, phase, lastError]);

  if (lastError) {
    return (
      <div className="home">
        <div className="home-card">
          <h1>Connexion impossible</h1>
          <p className="error">{lastError}</p>
          <button className="btn" onClick={onLeave}>
            Retour
          </button>
        </div>
      </div>
    );
  }

  if (!code) {
    const unreachable = !session.everConnected && session.connection === 'lost';
    return (
      <div className="home">
        <div className="home-card">
          <h1>{unreachable ? 'Serveur injoignable' : 'Connexion…'}</h1>
          <p className="subtitle">
            {unreachable ? 'Nouvelle tentative en cours.' : 'Connexion au serveur de jeu.'}
          </p>
          <div className="actions">
            {unreachable && onOffline && (
              <button className="btn btn-primary" onClick={onOffline}>
                Jouer hors ligne (non classé)
              </button>
            )}
            <button className="btn" onClick={onLeave}>
              Retour
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === 'lobby') {
    return <LobbyScreen session={session} code={code} onLeave={onLeave} />;
  }

  return (
    <GameScreen
      session={session}
      config={session.config}
      onExit={onLeave}
      onRestart={() => session.restart()}
      onChangeMap={session.canRestart && !solo ? () => session.backToLobby() : null}
      roomCode={code}
    />
  );
}
