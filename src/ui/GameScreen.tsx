import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { BONUS_DISCO, BONUS_HEART, BONUS_SHIELD } from '../game/board';
import { SHIELD_RADIUS } from '../game/rules';
import type { GameConfig, Session } from '../game/session';
import { addBeam, clearDiscos, startDisco, zoneCells, type Disco, type DiscoBeam } from '../render/discoFx';
import { createGameView, type GameView } from '../render/gameView';
import { worldToScreenX, worldToScreenY } from '../render/viewport';
import type { GameEvent, Item } from '../../shared/protocol';
import { GameCanvas } from './GameCanvas';
import {
  BombCounter,
  BONUS_LABEL,
  CHAT_LINE_MS,
  ChatLog,
  type ChatLine,
  InventoryBar,
  ITEM_LABEL,
  Timer,
  ViewReadout,
} from './Hud';
import { BONUS_EMOJI, createPickupFx } from './pickupFx';
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
/** Lignes affichées au plus dans le journal. */
const MAX_CHAT_LINES = 6;

/** Ajoute à la vue le flash correspondant à un événement, à l'instant `t0`
 *  (dans le futur pour une case encore voilée). Les zones de boule à facettes
 *  ont leur propre éclat, à l'arrivée du trait (voir discoFx). */
function flashFor(view: GameView, n: number, e: GameEvent, t0: number): void {
  if (e.kind === 'zone') return;
  const x = e.i % n;
  const y = (e.i / n) | 0;
  let r = 0;
  let diamond = false;
  let color = '#fbbf24';
  if (e.kind === 'pickup') color = FLASH_COLOR[e.bonus] ?? color;
  else if (e.kind === 'life') color = '#ef4444';
  else if (e.kind === 'use') {
    r = SHIELD_RADIUS;
    diamond = true;
    color = FLASH_COLOR[BONUS_SHIELD];
  }
  view.flashes.push({ x, y, r, diamond, t0, color });
}

const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Ligne de journal pour un événement, ou null s'il n'en mérite pas.
 * En solo la phrase est à la deuxième personne (« Tu as trouvé… ») ; en co-op
 * elle commence par le nom du joueur, affiché à part dans sa couleur.
 */
function chatFor(session: Session, e: GameEvent): Omit<ChatLine, 'id'> | null {
  const coop = session.connection !== 'local';
  const player = session.players.find((p) => p.id === e.by);
  const who = coop ? { name: player?.name ?? 'Quelqu’un', color: player?.color ?? 'inherit' } : null;
  switch (e.kind) {
    case 'pickup': {
      const label = BONUS_LABEL[e.bonus];
      if (!label) return null;
      const extra = e.bonus === BONUS_DISCO ? ' : des zones s’ouvrent !' : '';
      return { icon: BONUS_EMOJI[e.bonus], who, text: `${coop ? 'a' : 'Tu as'} trouvé ${label}${extra}`, tone: 'good' };
    }
    case 'life':
      return {
        icon: '💥',
        who,
        text: coop ? 'a touché une mine : une vie perdue' : 'Mine touchée : une vie perdue',
        tone: 'bad',
      };
    case 'use':
      // En solo, son propre geste se voit déjà sur le plateau.
      return coop ? { icon: '🛡️', who, text: `a utilisé ${ITEM_LABEL[e.item]}`, tone: 'info' } : null;
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

  // ── Événements : flash sur la case, animation de ramassage, journal ─
  const boardRef = useRef<HTMLDivElement>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const chatSeq = useRef(0);
  useEffect(() => {
    const fx = createPickupFx();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, fn: () => void) => {
      if (ms <= 0) return fn();
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    /** Marquage des cases ouvertes par l'action en cours (voir zoneCells),
     *  réutilisé d'un lot d'événements à l'autre. */
    let fresh: Uint8Array | null = null;

    const playPickup = (bonus: number, i: number) => {
      const stage = boardRef.current?.getBoundingClientRect();
      if (!stage) return;
      // Départ au centre de la case, ramené dans le plateau si elle est hors
      // champ (zone de boule à facettes, coéquipier à l'autre bout).
      const n = session.board.n;
      const { vp, canvas } = view;
      const m = 24;
      const x = stage.left + worldToScreenX(vp, (i % n) + 0.5, canvas.w);
      const y = stage.top + worldToScreenY(vp, ((i / n) | 0) + 0.5, canvas.h);
      fx.play(
        bonus,
        { x: Math.min(stage.right - m, Math.max(stage.left + m, x)), y: Math.min(stage.bottom - m, Math.max(stage.top + m, y)) },
        stage,
      );
    };

    const stop = session.subscribeEvents((events) => {
      const now = performance.now();
      const board = session.board;
      const n = board.n;
      const animate = !reducedMotion();

      // Cases ouvertes par cette action : les zones des boules à facettes se
      // reconstruisent à partir d'elles.
      const opened = session.lastOpened;
      const hasZones = animate && events.some((e) => e.kind === 'zone');
      if (hasZones) {
        if (!fresh || fresh.length !== n * n) fresh = new Uint8Array(n * n);
        for (let k = 0; k < opened.length; k++) fresh[opened[k]] = 1;
      }
      const discos = new Map<number, Disco>();
      const beams: DiscoBeam[] = [];
      /** Instant où la case `i` sera visible : à l'arrivée du trait de sa zone
       *  si elle en fait partie, tout de suite sinon. */
      const visibleAt = (i: number) => beams.find((b) => b.cells.includes(i))?.arriveAt ?? now;

      const lines: ChatLine[] = [];
      for (const e of events) {
        const at = e.kind === 'pickup' ? visibleAt(e.i) : now;
        if (e.kind === 'zone') {
          if (hasZones && fresh) {
            const d = discos.get(e.from) ?? startDisco(view, n, e.from, now);
            discos.set(e.from, d);
            beams.push(addBeam(view, n, d, e.i, zoneCells(board, fresh, e.i)));
          }
        } else {
          flashFor(view, n, e, at);
        }
        if (e.kind === 'pickup') {
          // La boule à facettes a sa propre animation ; elle démarre quand sa
          // case apparaît (elle peut se trouver dans la zone d'une autre).
          if (e.bonus === BONUS_DISCO) {
            if (animate) discos.set(e.i, startDisco(view, n, e.i, at));
          } else {
            later(at - now, () => playPickup(e.bonus, e.i));
          }
        }
        const line = chatFor(session, e);
        if (line) lines.push({ ...line, id: ++chatSeq.current });
      }
      if (hasZones && fresh) for (let k = 0; k < opened.length; k++) fresh[opened[k]] = 0;

      view.notify();
      if (lines.length === 0) return;
      setChat((prev) => [...prev, ...lines].slice(-MAX_CHAT_LINES));
      const ids = new Set(lines.map((l) => l.id));
      later(CHAT_LINE_MS, () => setChat((prev) => prev.filter((l) => !ids.has(l.id))));
    });
    return () => {
      stop();
      fx.dispose();
      clearDiscos(view);
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

      <div className="board-area" ref={boardRef}>
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
        <ChatLog lines={chat} />
      </div>

      <footer className="help mono">
        flèches déplacer · maj+flèches ×10 · r révéler · f drapeau
        {inventory ? ' · 1 bouclier' : ''} · molette zoom · glisser déplacer · +/− zoom · 0
        vue globale · échap {armed ? 'annuler' : 'quitter'}
      </footer>
    </div>
  );
}
