import { useEffect, useRef } from 'react';
import { idx, type Board } from '../game/board';
import { drawGrid } from '../render/drawGrid';
import type { GameView } from '../render/gameView';
import {
  clampViewport,
  fitToView,
  screenToWorldX,
  screenToWorldY,
  scrollIntoView,
  zoomAt,
} from '../render/viewport';

type Props = {
  board: Board;
  view: GameView;
  /** false quand la partie est terminée : le pan/zoom reste actif, pas les actions. */
  enabled: boolean;
  onReveal: (i: number) => void;
  onFlag: (i: number) => void;
  onExit: () => void;
  /** La souris a survolé une nouvelle case : diffuser la présence. */
  onPointerMove?: () => void;
};

/** Seuil (px) au-delà duquel un appui devient un pan plutôt qu'un clic. */
const DRAG_THRESHOLD = 4;
/** Distance parcourue par une flèche avec Shift. */
const FAST_STEP = 10;

export function GameCanvas({ board, view, enabled, onReveal, onFlag, onExit, onPointerMove }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Les handlers changent à chaque render ; les listeners, eux, sont posés une
  // seule fois et lisent toujours la dernière version via cette ref.
  const api = useRef({ board, enabled, onReveal, onFlag, onExit, onPointerMove });
  api.current = { board, enabled, onReveal, onFlag, onExit, onPointerMove };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext('2d', { alpha: false })!;

    let raf = 0;

    const draw = () => {
      raf = 0;
      const { w, h } = view.canvas;
      if (w > 0 && h > 0) drawGrid(ctx, api.current.board, view, w, h);
    };
    /** Redessine au prochain rAF, et une seule fois même si appelé 20×. */
    const requestDraw = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    // ── Dimensionnement (avec devicePixelRatio, sinon tout est flou) ──────
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      view.canvas.w = w;
      view.canvas.h = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const n = api.current.board.n;
      if (view.vp.cell <= 0) fitToView(view.vp, n, w, h);
      else clampViewport(view.vp, n, w, h);
      view.notify();
      requestDraw();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const unsubscribe = view.subscribe(requestDraw);

    // ── Molette : zoom centré sur le pointeur ────────────────────────────
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      // deltaMode 1 = lignes, 2 = pages : on ramène tout en « pixels ».
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-e.deltaY * unit * 0.0018);
      const { w, h } = view.canvas;
      zoomAt(view.vp, e.clientX - rect.left, e.clientY - rect.top, factor, api.current.board.n, w, h);
      view.notify();
    };

    // ── Pointeur : clic (reveal/flag) ou drag (pan) ──────────────────────
    let pointerId: number | null = null;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;

    /** Index de la case sous le pointeur, ou null hors plateau. Sans effet de
     *  bord : le curseur ne bouge que quand on agit réellement. */
    const cellAt = (clientX: number, clientY: number): number | null => {
      const rect = canvas.getBoundingClientRect();
      const { w, h } = view.canvas;
      const x = Math.floor(screenToWorldX(view.vp, clientX - rect.left, w));
      const y = Math.floor(screenToWorldY(view.vp, clientY - rect.top, h));
      const n = api.current.board.n;
      if (x < 0 || y < 0 || x >= n || y >= n) return null;
      return idx(n, x, y);
    };

    /** Amène le curseur clavier là où la souris vient d'agir, pour que les
     *  flèches et r/f reprennent au bon endroit. */
    const moveCursorTo = (i: number) => {
      const n = api.current.board.n;
      view.cursor.x = i % n;
      view.cursor.y = (i / n) | 0;
    };

    /** Case survolée, en coordonnées carte, ou null hors plateau. */
    const hoverCell = (clientX: number, clientY: number): { x: number; y: number } | null => {
      const rect = canvas.getBoundingClientRect();
      const { w, h } = view.canvas;
      const x = Math.floor(screenToWorldX(view.vp, clientX - rect.left, w));
      const y = Math.floor(screenToWorldY(view.vp, clientY - rect.top, h));
      const n = api.current.board.n;
      if (x < 0 || y < 0 || x >= n || y >= n) return null;
      return { x, y };
    };

    /**
     * Clôt le geste en cours. L'état local est remis à zéro AVANT la libération
     * de la capture : `releasePointerCapture` lève NotFoundError quand le
     * pointeur n'est plus actif (cas courant sur pointercancel tactile), et un
     * jet à cet endroit laisserait `pointerId` non nul — onPointerDown se
     * bloquerait alors définitivement sur son garde, tuant clic et pan.
     */
    const endGesture = (e: PointerEvent) => {
      pointerId = null;
      dragging = false;
      canvas.classList.remove('dragging');
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* pointeur déjà libéré par le navigateur */
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      canvas.focus();
      if (e.button === 2) {
        // Pas de drapeau au milieu d'un déplacement de vue en cours.
        if (pointerId !== null || !api.current.enabled) return;
        const i = cellAt(e.clientX, e.clientY);
        if (i === null) return;
        moveCursorTo(i);
        api.current.onFlag(i);
        view.notify();
        return;
      }
      if (e.button !== 0 || pointerId !== null) return;
      // L'état du geste est complet AVANT la capture : setPointerCapture peut
      // lever NotFoundError, et un jet à mi-chemin laisserait `pointerId` posé
      // sans point de départ — le garde ci-dessus bloquerait alors tous les
      // gestes suivants.
      pointerId = e.pointerId;
      dragging = false;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* sans capture le geste fonctionne, il ne suit juste plus hors canvas */
      }
    };

    const onHover = (e: PointerEvent) => {
      // Suit la souris même sans bouton enfoncé : sans ça, la position
      // diffusée aux autres joueurs resterait figée sur le dernier clic.
      const cell = hoverCell(e.clientX, e.clientY);
      const prev = view.pointer;
      if (cell === null) {
        if (prev === null) return;
        view.pointer = null;
      } else if (prev && prev.x === cell.x && prev.y === cell.y) {
        return;
      } else {
        view.pointer = cell;
      }
      api.current.onPointerMove?.();
    };

    const onDragMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_THRESHOLD) {
        dragging = true;
        canvas.classList.add('dragging');
      }
      if (!dragging) return;
      const { w, h } = view.canvas;
      view.vp.cx -= (e.clientX - lastX) / view.vp.cell;
      view.vp.cy -= (e.clientY - lastY) / view.vp.cell;
      lastX = e.clientX;
      lastY = e.clientY;
      clampViewport(view.vp, api.current.board.n, w, h);
      view.notify();
    };

    const onPointerLeave = () => {
      if (view.pointer === null) return;
      view.pointer = null;
      api.current.onPointerMove?.();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const wasDragging = dragging;
      endGesture(e);
      if (wasDragging || !api.current.enabled) return;
      const i = cellAt(e.clientX, e.clientY);
      if (i === null) return;
      moveCursorTo(i);
      api.current.onReveal(i);
      view.notify();
    };

    /**
     * Geste interrompu : le navigateur ou l'OS a repris la main (défilement
     * détourné, appel entrant, palm rejection...). C'est une annulation, pas un
     * clic — surtout ne rien révéler, ce serait faire sauter une mine sur une
     * action que le joueur n'a jamais terminée.
     */
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      endGesture(e);
    };

    const onContextMenu = (e: Event) => e.preventDefault();

    // ── Clavier ──────────────────────────────────────────────────────────
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      const n = api.current.board.n;
      const { w, h } = view.canvas;
      const step = e.shiftKey ? FAST_STEP : 1;
      let dx = 0;
      let dy = 0;

      switch (e.key) {
        case 'ArrowUp': dy = -step; break;
        case 'ArrowDown': dy = step; break;
        case 'ArrowLeft': dx = -step; break;
        case 'ArrowRight': dx = step; break;
        case 'r': case 'R':
          e.preventDefault();
          if (api.current.enabled) api.current.onReveal(idx(n, view.cursor.x, view.cursor.y));
          view.notify();
          return;
        case 'f': case 'F':
          e.preventDefault();
          if (api.current.enabled) api.current.onFlag(idx(n, view.cursor.x, view.cursor.y));
          view.notify();
          return;
        case '+': case '=':
          e.preventDefault();
          zoomAt(view.vp, w / 2, h / 2, 1.25, n, w, h);
          view.notify();
          return;
        case '-': case '_':
          e.preventDefault();
          zoomAt(view.vp, w / 2, h / 2, 1 / 1.25, n, w, h);
          view.notify();
          return;
        case '0':
          e.preventDefault();
          fitToView(view.vp, n, w, h);
          view.notify();
          return;
        case 'Escape':
          e.preventDefault();
          api.current.onExit();
          return;
        default:
          return;
      }

      e.preventDefault(); // sinon les flèches scrollent la page
      // Le clavier reprend la main : c'est le curseur clavier qu'on diffuse.
      view.pointer = null;
      view.cursor.x = Math.min(n - 1, Math.max(0, view.cursor.x + dx));
      view.cursor.y = Math.min(n - 1, Math.max(0, view.cursor.y + dy));
      // la vue suit le curseur, avec 2 cases de marge par rapport au bord
      scrollIntoView(view.vp, view.cursor.x, view.cursor.y, n, w, h);
      view.notify();
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onDragMove);
    canvas.addEventListener('pointermove', onHover);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      ro.disconnect();
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onDragMove);
      canvas.removeEventListener('pointermove', onHover);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [view]);

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} tabIndex={0} />
    </div>
  );
}
