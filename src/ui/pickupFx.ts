import { BONUS_DISCO, BONUS_HEART, BONUS_SHIELD } from '../game/board';

/** Emoji de chaque bonus, partagé par l'animation et le journal. */
export const BONUS_EMOJI: Record<number, string> = {
  [BONUS_SHIELD]: '🛡️',
  [BONUS_HEART]: '❤️',
  [BONUS_DISCO]: '🪩',
};

/** Halo autour de l'emoji pendant l'animation. */
const GLOW: Record<number, string> = {
  [BONUS_SHIELD]: '#38bdf8',
  [BONUS_HEART]: '#f472b6',
};

/** Case du HUD où le bonus va se ranger (`data-slot`). La boule à facettes
 *  n'en a pas : elle a sa propre animation (render/discoFx.ts). */
const SLOT: Record<number, string> = {
  [BONUS_SHIELD]: 'shield',
  [BONUS_HEART]: 'lives',
};

const DURATION_MS = 1700;
/** Décalage entre deux animations : une cascade qui ramasse trois bonus les
 *  montre l'un après l'autre plutôt qu'empilés. */
const STAGGER_MS = 450;
/** Au-delà de ce nombre en attente, les suivants vont droit au HUD : pas de
 *  file de dix totems à regarder défiler. */
const MAX_QUEUED_BIG = 4;
const FAST_MS = 550;

type Point = { x: number; y: number };

export type PickupFx = {
  /**
   * @param from  centre de la case ramassée, en coordonnées écran
   * @param stage rectangle du plateau : l'emoji grossit en son centre
   */
  play(bonus: number, from: Point, stage: DOMRect): void;
  dispose(): void;
};

function slotElement(slot: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
}

/** Petit rebond de la case du HUD à l'arrivée du bonus. */
function bump(slot: string): void {
  slotElement(slot)?.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }],
    { duration: 320, easing: 'cubic-bezier(.3,1.6,.5,1)' },
  );
}

/** Une seule liste de transformations, dans le même ordre à chaque étape :
 *  c'est ce qui permet au navigateur d'interpoler proprement entre elles. */
function at(p: Point, scale: number, spin: number, tilt: number): string {
  return `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) perspective(500px) scale(${scale}) rotateY(${spin}deg) rotate(${tilt}deg)`;
}

/**
 * Animation de ramassage façon totem d'immortalité : l'emoji jaillit de la
 * case, grossit au centre du plateau en tournoyant, oscille un instant, puis
 * file se ranger dans sa case du HUD. Vies et boucliers seulement : la boule
 * à facettes a sa propre animation (render/discoFx.ts).
 *
 * Hors React, comme le reste du rendu : des éléments posés sur `body` et
 * animés par la Web Animations API, retirés dès la fin de l'animation.
 */
export function createPickupFx(): PickupFx {
  const running = new Set<Animation>();
  const nodes = new Set<HTMLElement>();
  let nextStart = 0;
  const reduced =
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  return {
    play(bonus, from, stage) {
      const slot = SLOT[bonus];
      const emoji = BONUS_EMOJI[bonus];
      if (!slot || !emoji) return;
      if (reduced) {
        bump(slot);
        return;
      }

      const now = performance.now();
      const delay = Math.max(0, nextStart - now);
      const big = delay / STAGGER_MS < MAX_QUEUED_BIG;
      nextStart = now + delay + (big ? STAGGER_MS : STAGGER_MS / 3);

      const center = { x: stage.left + stage.width / 2, y: stage.top + stage.height / 2 };
      const target = slotElement(slot)?.getBoundingClientRect();
      const end = target ? { x: target.left + target.width / 2, y: target.top + target.height / 2 } : center;
      // Case introuvable (HUD absent) : l'emoji s'efface au centre.
      const finalScale = target ? 0.6 : 2;

      const el = document.createElement('div');
      el.className = 'pickup-fx';
      el.textContent = emoji;
      el.style.setProperty('--glow', GLOW[bonus] ?? '#fbbf24');
      document.body.append(el);
      nodes.add(el);

      const keyframes: Keyframe[] = big
        ? [
            { offset: 0, transform: at(from, 0.4, 0, 0), opacity: 0 },
            { offset: 0.1, transform: at(from, 1.4, 0, 0), opacity: 1, easing: 'cubic-bezier(.2,.7,.3,1)' },
            { offset: 0.38, transform: at(center, 4.2, 720, -14), opacity: 1, easing: 'ease-in-out' },
            { offset: 0.46, transform: at(center, 3.8, 720, 10), easing: 'ease-in-out' },
            { offset: 0.54, transform: at(center, 4, 720, -6), easing: 'ease-in-out' },
            { offset: 0.64, transform: at(center, 3.9, 720, 0), opacity: 1, easing: 'cubic-bezier(.5,0,.8,.4)' },
            { offset: 1, transform: at(end, finalScale, 720, 0), opacity: target ? 0.9 : 0 },
          ]
        : [
            { offset: 0, transform: at(from, 1, 0, 0), opacity: 0 },
            { offset: 0.2, transform: at(from, 1.2, 0, 0), opacity: 1, easing: 'ease-in' },
            { offset: 1, transform: at(end, finalScale, 0, 0), opacity: target ? 0.9 : 0 },
          ];

      const anim = el.animate(keyframes, { duration: big ? DURATION_MS : FAST_MS, delay, fill: 'both' });
      running.add(anim);
      anim.finished
        .then(() => bump(slot))
        // Annulée par `dispose` : rien à faire de plus.
        .catch(() => {})
        .finally(() => {
          running.delete(anim);
          nodes.delete(el);
          el.remove();
        });
    },

    dispose() {
      for (const a of running) a.cancel();
      for (const el of nodes) el.remove();
      running.clear();
      nodes.clear();
    },
  };
}
