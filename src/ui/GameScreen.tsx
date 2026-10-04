import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BONUS_DISCO, BONUS_HEART, BONUS_SHIELD } from '../game/board';
import { SHIELD_RADIUS } from '../game/rules';
import type { GameConfig, Session } from '../game/session';
import { createGameView, type GameView } from '../render/gameView';
import type { GameEvent, Item } from '../../shared/protocol';
import { GameCanvas } from './GameCanvas';
import {
  BombCounter,
  BONUS_LABEL,
  InventoryBar,
  ITEM_LABEL,
  Timer,
  type Toast,
  Toasts,
  ViewReadout,
} from './Hud';
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

/** Couleur du flash selon ce qui s'est passé. */
const FLASH_COLOR: Record<number, string> = {
  [BONUS_SHIELD]: '#38bdf8',
  [BONUS_HEART]: '#f472b6',
  [BONUS_DISCO]: '#fbbf24',
};
const TOAST_MS = 3200;
const MAX_TOASTS = 4;

/** Ajoute à la vue le flash correspondant à un événement. */
function flashFor(view: GameView, n: number, e: GameEvent, now: number): void {
  const x = e.i % n;
  const y = (e.i / n) | 0;
  let r = 0;
  let diamond = false;
  let color = '#fbbf24';
  if (e.kind === 'pickup') color = FLASH_COLOR[e.bonus] ?? color;
  else if (e.kind === 'zone') r = 1;
  else if (e.kind === 'life') color = '#ef4444';
  else if (e.kind === 'use') {
    r = SHIELD_RADIUS;
    diamond = true;
    color = FLASH_COLOR[BONUS_SHIELD];
  }
  view.flashes.push({ x, y, r, diamond, t0: now, color });
}

/** Message du HUD pour un événement, ou null s'il n'en mérite pas. */
function toastFor(session: Session, e: GameEvent): Omit<Toast, 'id'> | null {
  const self = e.by === session.selfId;
  const name = session.players.find((p) => p.id === e.by)?.name ?? 'Quelqu’un';
  const who = self ? 'Tu as' : `${name} a`;
  switch (e.kind) {
    case 'pickup': {
      const label = BONUS_LABEL[e.bonus];
      if (!label) return null;
      const extra = e.bonus === BONUS_DISCO ? ' : des zones s’ouvrent !' : '';
      return { text: `${who} trouvé ${label}${extra}`, tone: 'good' };
    }
    case 'life':
      return { text: `${who} touché une mine — une vie perdue`, tone: 'bad' };
    case 'use':
      // Son propre geste se voit déjà sur le plateau.
      return self ? null : { text: `${name} a utilisé ${ITEM_LABEL[e.item]}`, tone: 'info' };
    case 'zone':
      return null;
  }
}

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

  // ── Objets : sélection puis pose ─────────────────────────────────────
  const [armed, setArmed] = useState<Item | null>(null);
  const isOver = session.over !== null;
  const inventory = session.inventory;
  const stock = (item: Item) => (inventory && item === 'shield' ? inventory.shields : 0);

  const arm = useCallback(
    (item: Item | null) => {
      const inv = session.inventory;
      const has = inv && item === 'shield' && inv.shields > 0;
      setArmed(item && has && session.over === null ? item : null);
    },
    [session],
  );
  const handleUse = useCallback(
    (item: Item, i: number) => {
      session.use(item, i);
      setArmed(null);
    },
    [session],
  );

  // Désarmer quand l'objet n'est plus disponible : partie finie, ou dernier
  // exemplaire posé par un coéquipier (la réserve est commune).
  const armedStock = armed ? stock(armed) : 0;
  useEffect(() => {
    if (armed && (isOver || armedStock === 0)) setArmed(null);
  }, [armed, armedStock, isOver]);

  // La vue lit l'objet armé pour dessiner la zone visée et router les clics.
  useEffect(() => {
    view.armed = armed;
    view.notify();
  }, [armed, view]);

  // ── Événements : flashs sur le plateau, messages dans le HUD ─────────
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stop = session.subscribeEvents((events) => {
      const now = performance.now();
      const n = session.board.n;
      const fresh: Toast[] = [];
      for (const e of events) {
        flashFor(view, n, e, now);
        const t = toastFor(session, e);
        if (t) fresh.push({ ...t, id: ++toastSeq.current });
      }
      view.notify();
      if (fresh.length === 0) return;
      setToasts((prev) => [...prev, ...fresh].slice(-MAX_TOASTS));
      const ids = new Set(fresh.map((t) => t.id));
      const timer = setTimeout(() => {
        timers.delete(timer);
        setToasts((prev) => prev.filter((t) => !ids.has(t.id)));
      }, TOAST_MS);
      timers.add(timer);
    });
    return () => {
      stop();
      for (const t of timers) clearTimeout(t);
    };
  }, [session, view]);

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
        {inventory && <InventoryBar inventory={inventory} armed={armed} enabled={!isOver} onArm={arm} />}
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
          onUse={handleUse}
          onArm={arm}
          onExit={handleExit}
          onPointerMove={reportPresence}
        />
        <Minimap board={session.board} view={view} />
        <Toasts toasts={toasts} />
      </div>

      <footer className="help mono">
        flèches déplacer · maj+flèches ×10 · r révéler · f drapeau
        {inventory ? ' · 1 bouclier' : ''} · molette zoom · glisser déplacer · +/− zoom · 0
        vue globale · échap {armed ? 'annuler' : 'quitter'}
      </footer>
    </div>
  );
}
