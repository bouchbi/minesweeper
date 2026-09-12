import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { GameConfig, Session } from '../game/session';
import { createGameView } from '../render/gameView';
import { GameCanvas } from './GameCanvas';
import { BombCounter, Timer, ViewReadout } from './Hud';
import { Minimap } from './Minimap';
import { PlayerList } from './PlayerList';

export type { GameConfig };

type Props = {
  session: Session;
  config: GameConfig;
  /** Quitte la partie : accueil en solo, sortie de la session en réseau. */
  onExit: () => void;
  /** Relance une partie avec la même configuration. */
  onRestart: () => void;
  /** Change de carte sans quitter la session. `null` quand ce n'est pas
   *  possible : en solo (quitter suffit) ou pour un invité en réseau. */
  onChangeMap?: (() => void) | null;
};

const CONNECTION_LABEL: Record<string, string> = {
  connecting: 'Connexion…',
  lost: 'Connexion perdue — reconnexion en cours…',
};

export function GameScreen({ session, config, onExit, onRestart, onChangeMap }: Props) {
  const [view] = useState(() => createGameView(config.n));
  const [, forceRender] = useReducer((v: number) => v + 1, 0);

  // La session pilote deux flux distincts : le plateau (canvas, hors React) et
  // l'état affiché par le HUD (React). Les mélanger ferait re-render l'arbre à
  // chaque case révélée.
  useEffect(() => {
    const stopBoard = session.subscribeBoard(() => {
      view.boardVersion++;
      view.notify();
    });
    const stopState = session.subscribeState(forceRender);
    return () => {
      stopBoard();
      stopState();
    };
  }, [session, view]);

  // Position diffusée aux autres : la souris si le joueur l'utilise, sinon son
  // curseur clavier. En solo `moveCursor` ne fait rien.
  const reportPresence = useCallback(() => {
    const { vp, cursor, pointer, canvas } = view;
    if (vp.cell <= 0) return;
    const halfW = canvas.w / 2 / vp.cell;
    const halfH = canvas.h / 2 / vp.cell;
    const at = pointer ?? cursor;
    session.moveCursor(at.x, at.y, {
      x0: vp.cx - halfW,
      y0: vp.cy - halfH,
      x1: vp.cx + halfW,
      y1: vp.cy + halfH,
    });
  }, [session, view]);

  // Déplacement de vue (pan, zoom, flèches) : le rectangle change aussi.
  useEffect(() => view.subscribe(reportPresence), [view, reportPresence]);

  // Présence reçue : recopier les pairs DANS la vue puis redessiner.
  //
  // La recopie doit se faire ici et pas pendant le rendu : `NetworkSession`
  // remplace `peers` par un nouveau tableau à chaque message, et un message de
  // présence ne déclenche aucun rendu React — la vue resterait donc accrochée
  // à l'ancien tableau et les curseurs distants ne bougeraient jamais.
  //
  // On ne touche pas à `boardVersion` : le plateau n'a pas changé, l'incrémenter
  // reconstruirait la minimap en O(n²) dix fois par seconde.
  useEffect(() => {
    const sync = () => {
      view.peers = session.peers;
      view.players = session.players;
    };
    sync();
    const stopPresence = session.subscribePresence(() => {
      sync();
      view.notify();
    });
    const stopState = session.subscribeState(sync);
    return () => {
      stopPresence();
      stopState();
    };
  }, [session, view]);

  const handleReveal = useCallback((i: number) => session.reveal(i), [session]);
  const handleFlag = useCallback((i: number) => session.flag(i), [session]);

  const isOver = session.over !== null;
  const handleExit = useCallback(() => {
    if (!isOver && session.connection === 'local' && !confirm('Quitter la partie en cours ?')) return;
    onExit();
  }, [isOver, session, onExit]);

  const total = useMemo(() => config.n * config.n, [config.n]);
  const banner = CONNECTION_LABEL[session.connection];
  const isNet = session.connection !== 'local';

  return (
    <div className="game">
      <header className="hud">
        <div className="hud-group">
          <span className="hud-label">Temps</span>
          <Timer session={session} />
        </div>
        <div className="hud-group">
          <span className="hud-label">Bombes</span>
          <BombCounter remaining={session.remaining} />
        </div>
        <div className="hud-group grow">
          <span className="hud-label">
            {config.n}×{config.n} · {total.toLocaleString('fr-FR')} cases ·{' '}
            {config.mineCount.toLocaleString('fr-FR')} bombes
          </span>
        </div>
        <PlayerList players={session.players} selfId={session.selfId} />
        {session.over === 'dead' && <span className="badge badge-dead">Perdu</span>}
        {session.over === 'won' && <span className="badge badge-won">Gagné</span>}
        <ViewReadout view={view} />
        {isOver && session.canRestart && (
          <button className="btn btn-accent" onClick={onRestart}>
            Rejouer
          </button>
        )}
        {onChangeMap && (
          <button className="btn" onClick={onChangeMap}>
            Changer de carte
          </button>
        )}
        <button className="btn" onClick={handleExit}>
          {isNet ? 'Quitter' : isOver ? 'Changer de carte' : 'Nouvelle partie'}
        </button>
      </header>

      {banner && <div className="net-banner">{banner}</div>}

      <div className="board-area">
        <GameCanvas
          board={session.board}
          view={view}
          enabled={!isOver}
          onReveal={handleReveal}
          onFlag={handleFlag}
          onExit={handleExit}
          onPointerMove={reportPresence}
        />
        <Minimap board={session.board} view={view} />
      </div>

      <footer className="help mono">
        flèches déplacer · maj+flèches ×10 · r révéler · f drapeau · molette zoom · glisser
        déplacer · +/− zoom · 0 vue globale · échap quitter
      </footer>
    </div>
  );
}
