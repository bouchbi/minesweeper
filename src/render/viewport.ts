/**
 * Caméra sur la carte.
 *  - `cx`/`cy` : position (en coordonnées carte, fractionnaires) du centre de l'écran
 *  - `cell`    : taille d'une case en pixels CSS
 *
 * Vit hors de React (dans un objet mutable) : le pan/zoom se produit à 60 fps
 * et ne doit déclencher aucun re-render.
 */
export type Viewport = { cx: number; cy: number; cell: number };

export const CELL_MAX = 64;

export type Range = { x0: number; y0: number; x1: number; y1: number };

/** Taille de case pour laquelle la carte entière tient dans le canvas. */
export function fitCell(n: number, w: number, h: number): number {
  return Math.min(w / n, h / n);
}

/** Borne inférieure du zoom : on ne dézoome jamais au-delà du « tout à l'écran ». */
export function minCell(n: number, w: number, h: number): number {
  return Math.min(fitCell(n, w, h), CELL_MAX);
}

export function createViewport(n: number): Viewport {
  return { cx: n / 2, cy: n / 2, cell: 0 };
}

/**
 * Recadre le viewport : zoom borné, et pan borné aux limites de la carte.
 * Si la carte est plus petite que le canvas sur un axe, elle est centrée.
 * Mute `vp` en place.
 */
export function clampViewport(vp: Viewport, n: number, w: number, h: number): void {
  const lo = minCell(n, w, h);
  vp.cell = Math.min(CELL_MAX, Math.max(lo, vp.cell));

  const halfW = w / 2 / vp.cell;
  const halfH = h / 2 / vp.cell;

  if (n <= halfW * 2) vp.cx = n / 2;
  else vp.cx = Math.min(n - halfW, Math.max(halfW, vp.cx));

  if (n <= halfH * 2) vp.cy = n / 2;
  else vp.cy = Math.min(n - halfH, Math.max(halfH, vp.cy));
}

/** Plage de cases réellement visibles — c'est tout le secret de la perf. */
export function visibleRange(vp: Viewport, n: number, w: number, h: number): Range {
  const halfW = w / 2 / vp.cell;
  const halfH = h / 2 / vp.cell;
  return {
    x0: Math.max(0, Math.floor(vp.cx - halfW)),
    y0: Math.max(0, Math.floor(vp.cy - halfH)),
    x1: Math.min(n, Math.ceil(vp.cx + halfW) + 1),
    y1: Math.min(n, Math.ceil(vp.cy + halfH) + 1),
  };
}

export function worldToScreenX(vp: Viewport, wx: number, w: number): number {
  return (wx - vp.cx) * vp.cell + w / 2;
}
export function worldToScreenY(vp: Viewport, wy: number, h: number): number {
  return (wy - vp.cy) * vp.cell + h / 2;
}
export function screenToWorldX(vp: Viewport, sx: number, w: number): number {
  return (sx - w / 2) / vp.cell + vp.cx;
}
export function screenToWorldY(vp: Viewport, sy: number, h: number): number {
  return (sy - h / 2) / vp.cell + vp.cy;
}

/**
 * Zoom d'un facteur `factor` en gardant fixe le point écran (sx, sy) :
 * la case sous le curseur reste sous le curseur.
 */
export function zoomAt(
  vp: Viewport,
  sx: number,
  sy: number,
  factor: number,
  n: number,
  w: number,
  h: number,
): void {
  const wx = screenToWorldX(vp, sx, w);
  const wy = screenToWorldY(vp, sy, h);

  const lo = minCell(n, w, h);
  const next = Math.min(CELL_MAX, Math.max(lo, vp.cell * factor));
  if (next === vp.cell) return;
  vp.cell = next;

  // On replace le centre pour que (wx, wy) retombe sur (sx, sy).
  vp.cx = wx - (sx - w / 2) / vp.cell;
  vp.cy = wy - (sy - h / 2) / vp.cell;
  clampViewport(vp, n, w, h);
}

/**
 * Fait suivre la vue au curseur clavier : ne bouge que si la case sort de la
 * zone confortable (marge de `margin` cases par rapport au bord).
 * @returns true si le viewport a bougé.
 */
export function scrollIntoView(
  vp: Viewport,
  x: number,
  y: number,
  n: number,
  w: number,
  h: number,
  margin = 2,
): boolean {
  const before = { cx: vp.cx, cy: vp.cy };
  const halfW = w / 2 / vp.cell;
  const halfH = h / 2 / vp.cell;
  const m = Math.min(margin, Math.max(0, halfW - 1));
  const mv = Math.min(margin, Math.max(0, halfH - 1));

  const cxCell = x + 0.5;
  const cyCell = y + 0.5;

  if (cxCell < vp.cx - halfW + m) vp.cx = cxCell + halfW - m;
  else if (cxCell > vp.cx + halfW - m) vp.cx = cxCell - halfW + m;

  if (cyCell < vp.cy - halfH + mv) vp.cy = cyCell + halfH - mv;
  else if (cyCell > vp.cy + halfH - mv) vp.cy = cyCell - halfH + mv;

  clampViewport(vp, n, w, h);
  return vp.cx !== before.cx || vp.cy !== before.cy;
}

/** Recadre toute la carte à l'écran. */
export function fitToView(vp: Viewport, n: number, w: number, h: number): void {
  vp.cell = minCell(n, w, h);
  vp.cx = n / 2;
  vp.cy = n / 2;
  clampViewport(vp, n, w, h);
}
