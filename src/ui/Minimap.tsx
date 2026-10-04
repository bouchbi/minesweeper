import { useEffect, useRef } from 'react';
import type { Board } from '../game/board';
import { buildMinimap, drawMinimap, MINIMAP_SIZE, type MinimapCache } from '../render/drawMinimap';
import type { GameView } from '../render/gameView';
import { activeVeil } from '../render/discoFx';
import { clampViewport } from '../render/viewport';

type Props = { board: Board; view: GameView };

/** Reconstruction du fond au plus 5×/s : sur une grande carte c'est une passe
 *  sur n*n cases, inutile de la refaire à chaque frame de pan. */
const REBUILD_INTERVAL_MS = 200;

export function Minimap({ board, view }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(MINIMAP_SIZE * dpr);
    canvas.height = Math.round(MINIMAP_SIZE * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let cache: MinimapCache | null = null;
    let cachedVersion = -1;
    let lastBuild = 0;
    let raf = 0;
    // ReturnType : number dans le navigateur, Timeout sous les types Node
    // (présents depuis l'ajout du serveur). Les deux passent par clearTimeout.
    let retry: ReturnType<typeof setTimeout> | 0 = 0;

    const draw = () => {
      raf = 0;
      const now = performance.now();
      const stale = cachedVersion !== view.boardVersion;
      if (!cache || (stale && now - lastBuild >= REBUILD_INTERVAL_MS)) {
        cache = buildMinimap(board, cache, activeVeil(view));
        cachedVersion = view.boardVersion;
        lastBuild = now;
        if (retry) {
          clearTimeout(retry);
          retry = 0;
        }
      } else if (stale && !retry) {
        // Trop tôt pour reconstruire : on repasse plus tard. Le handle est
        // conservé pour être annulé au démontage — sinon le timer survit à la
        // partie et relance une passe sur n² cases pour un canvas détaché.
        retry = setTimeout(() => {
          retry = 0;
          request();
        }, REBUILD_INTERVAL_MS);
      }
      const { w, h } = view.canvas;
      drawMinimap(ctx, cache, board.n, view.vp, w, h, MINIMAP_SIZE, view.peers, view.players);
    };

    const request = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const unsubscribe = view.subscribe(request);
    request();

    // ── Clic / drag sur la minimap : téléportation du viewport ───────────
    let pointerId: number | null = null;
    const jumpTo = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const k = board.n / MINIMAP_SIZE;
      view.vp.cx = (clientX - rect.left) * k;
      view.vp.cy = (clientY - rect.top) * k;
      const { w, h } = view.canvas;
      clampViewport(view.vp, board.n, w, h);
      view.notify();
    };
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      jumpTo(e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      jumpTo(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* pointeur déjà libéré */
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    return () => {
      unsubscribe();
      if (raf) cancelAnimationFrame(raf);
      if (retry) clearTimeout(retry);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [board, view]);

  return (
    <div className="minimap">
      <canvas
        ref={canvasRef}
        style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
        aria-label="Vue d'ensemble de la carte"
      />
    </div>
  );
}
