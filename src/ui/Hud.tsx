import { useEffect, useState } from 'react';
import { BONUS_DISCO, BONUS_HEART, BONUS_PROBE, BONUS_SHIELD } from '../game/board';
import { MAX_LIVES } from '../game/engine';
import type { Session } from '../game/session';
import type { GameView } from '../render/gameView';
import type { Inventory, Item } from '../../shared/protocol';

function pad2(v: number): string {
  return v < 10 ? `0${v}` : String(v);
}

/** mm:ss, sans borne haute sur les minutes (147:32 reste valide). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * Isolé dans son propre composant : son re-render 4×/s ne touche ni le canvas
 * ni le reste de l'arbre.
 *
 * En réseau la session recale l'écoulement sur le serveur ; le composant ne
 * fait qu'afficher ce qu'elle lui donne, sans jamais synchroniser d'horloge.
 */
export function Timer({ session }: { session: Session }) {
  const [, tick] = useState(0);
  const running = session.clockRunning;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((v) => v + 1), 250);
    return () => clearInterval(id);
  }, [running]);

  return <span className="hud-value mono">{formatDuration(session.elapsedMs())}</span>;
}

/**
 * Compteur de bombes restantes (mines totales - drapeaux posés).
 * `null` affiche `---` ; la valeur peut être négative si le joueur pose plus
 * de drapeaux qu'il n'y a de mines.
 */
export function BombCounter({ remaining }: { remaining: number | null }) {
  if (remaining === null) return <span className="hud-value mono muted">---</span>;
  const sign = remaining < 0 ? '-' : '';
  return (
    <span className="hud-value mono">
      {sign}
      {String(Math.abs(remaining)).padStart(3, '0')}
    </span>
  );
}

/** Position du curseur + zoom courant, rafraîchis au rythme du rAF. */
export function ViewReadout({ view }: { view: GameView }) {
  const [text, setText] = useState('');

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      setText(`${view.cursor.x},${view.cursor.y} · ${Math.round(view.vp.cell)} px/case`);
    };
    const onChange = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    const unsubscribe = view.subscribe(onChange);
    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [view]);

  return <span className="readout mono">{text}</span>;
}

/** Nom d'un bonus avec son article, pour les messages (« a trouvé une Sonde »). */
export const BONUS_LABEL: Record<number, string> = {
  [BONUS_PROBE]: 'une Sonde',
  [BONUS_SHIELD]: 'un Bouclier',
  [BONUS_HEART]: 'une Vie',
  [BONUS_DISCO]: 'une Boule à facettes',
};

export const ITEM_LABEL: Record<Item, string> = {
  probe: 'une Sonde',
  shield: 'un Bouclier',
};

/**
 * Vies et objets en réserve. Un objet se sélectionne ici ou au clavier
 * (1 / 2), puis se pose d'un clic sur le plateau.
 */
export function InventoryBar({
  inventory,
  armed,
  enabled,
  onArm,
}: {
  inventory: Inventory;
  armed: Item | null;
  enabled: boolean;
  onArm: (item: Item | null) => void;
}) {
  const { lives, probes, shields } = inventory;
  const items: [Item, string, number, string, string][] = [
    ['probe', '🔍', probes, '1', "Sonde : révèle les mines d'un carré 5×5"],
    ['shield', '🛡', shields, '2', 'Bouclier : découvre sans risque un carré 3×3'],
  ];
  return (
    <div className="inventory">
      <span
        className="lives"
        title={`Vies (${lives}/${MAX_LIVES}) : une mine touchée est désamorcée au lieu de faire perdre`}
      >
        {Array.from({ length: MAX_LIVES }, (_, k) => (
          <i key={k} className={k < lives ? 'on' : ''}>
            ♥
          </i>
        ))}
      </span>
      {items.map(([item, icon, count, key, help]) => (
        <button
          key={item}
          type="button"
          className={`item${armed === item ? ' armed' : ''}`}
          disabled={!enabled || count === 0}
          title={`${help} — touche ${key}`}
          onClick={() => onArm(armed === item ? null : item)}
        >
          <span aria-hidden>{icon}</span>
          <b className="mono">{count}</b>
          <kbd>{key}</kbd>
        </button>
      ))}
    </div>
  );
}

export type Toast = { id: number; text: string; tone: 'good' | 'bad' | 'info' };

/** Messages éphémères en haut du plateau. */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
