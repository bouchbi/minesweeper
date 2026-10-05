import { useEffect, useState } from 'react';
import { BONUS_DISCO, BONUS_HEART, BONUS_SHIELD } from '../game/board';
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

/** Nom d'un bonus avec son article, pour les messages (« a trouvé un Bouclier »). */
export const BONUS_LABEL: Record<number, string> = {
  [BONUS_SHIELD]: 'un Bouclier',
  [BONUS_HEART]: 'une Vie',
  [BONUS_DISCO]: 'une Boule à facettes',
};

export const ITEM_LABEL: Record<Item, string> = {
  shield: 'un Bouclier',
};

/**
 * Vies et objets en réserve. Un objet se sélectionne ici ou au clavier
 * (touche 1), puis se pose d'un clic sur le plateau.
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
  const { lives, shields } = inventory;
  const items: [Item, string, number, string, string][] = [
    ['shield', '🛡️', shields, '1', 'Bouclier : découvre sans risque un losange de 4 cases de diagonale'],
  ];
  return (
    <div className="inventory">
      <span
        className="lives"
        data-slot="lives"
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
          data-slot={item}
          disabled={!enabled || count === 0}
          title={`${help} — touche ${key}`}
          onClick={() => onArm(armed === item ? null : item)}
        >
          <span className="item-icon" aria-hidden>
            {icon}
          </span>
          <b className="mono">{count}</b>
          <kbd>{key}</kbd>
        </button>
      ))}
    </div>
  );
}

/** Une ligne du journal. `who` est null en solo : pas de nom à afficher. */
export type ChatLine = {
  id: number;
  icon: string;
  who: { name: string; color: string } | null;
  text: string;
  tone: 'good' | 'bad' | 'info';
};

/** Durée de vie d'une ligne ; elle s'efface pendant la dernière seconde
 *  (animation CSS calée sur la même durée). */
export const CHAT_LINE_MS = 8000;

/**
 * Journal façon chat, en bas à gauche du plateau : les lignes s'empilent, la
 * plus récente en bas, et s'effacent d'elles-mêmes. En co-op chaque ligne
 * commence par le nom du joueur, dans sa couleur.
 */
export function ChatLog({ lines }: { lines: ChatLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="chat" aria-live="polite">
      {lines.map((l) => (
        <div
          key={l.id}
          className={`chat-line chat-${l.tone}`}
          style={{ animationDuration: `${CHAT_LINE_MS}ms` }}
        >
          <span className="chat-icon" aria-hidden>
            {l.icon}
          </span>
          {l.who && (
            <b className="chat-name" style={{ color: l.who.color }}>
              {l.who.name}
            </b>
          )}
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}
