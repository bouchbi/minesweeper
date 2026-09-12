import { useEffect, useState } from 'react';
import type { Session } from '../game/session';
import type { GameView } from '../render/gameView';

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
