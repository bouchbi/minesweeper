import { COVERED, FLAGGED, type Board } from '../game/board';
import { PLAYER_COLORS } from '../../shared/protocol';
import type { GameView } from './gameView';
import {
  BUCKET_ADJ0,
  BUCKET_COUNT,
  BUCKET_COVERED,
  BUCKET_FLAGGED,
  BUCKET_FLAGGED_MINE,
  BUCKET_MINE,
  C,
  DIGIT_COLORS,
  FILL_HI,
  FILL_LO,
  FILL_LO_RGB,
  LOD_BORDER,
  LOD_PIXEL,
  LOD_TEXT,
} from './palette';
import { visibleRange, type Range } from './viewport';

/**
 * Buckets réutilisés d'une frame à l'autre (on remet juste `length = 0`) :
 * zéro allocation par frame, donc zéro pic de GC pendant un pan.
 * Chaque bucket stocke des paires (x, y) en pixels écran.
 */
const buckets: number[][] = Array.from({ length: BUCKET_COUNT }, () => []);
/* Poseur de chaque drapeau, dans le même ordre que les buckets FLAGGED et
   FLAGGED_MINE. Séparé pour que la passe de remplissage générique continue de
   travailler sur de simples paires (x, y). */
const flagOwners: number[] = [];
const flagMineOwners: number[] = [];
/* Regroupement par joueur au moment de dessiner : au plus 9 entrées. */
const byOwner: number[][] = Array.from({ length: PLAYER_COLORS.length }, () => []);

/**
 * Dessine la portion visible de la grille.
 *
 * Le coût ne dépend que de la taille du canvas et du zoom, jamais de `n` :
 * seules les cases comprises dans `visibleRange` sont parcourues.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  board: Board,
  view: GameView,
  w: number,
  h: number,
): void {
  const { vp, cursor } = view;
  const { n, state, adj, mines, minesExposed, flagOwner } = board;
  const cell = vp.cell;

  ctx.fillStyle = C.pageBg;
  ctx.fillRect(0, 0, w, h);
  if (cell <= 0) return;

  const r = visibleRange(vp, n, w, h);
  const originX = w / 2 - vp.cx * cell;
  const originY = h / 2 - vp.cy * cell;

  // Fond du plateau (utile quand la carte est plus petite que le canvas).
  ctx.fillStyle = C.boardBg;
  ctx.fillRect(originX, originY, n * cell, n * cell);

  // En dézoom extrême toutes les cases sont visibles : le culling ne peut plus
  // rien, et un fillRect par case coûte trop cher. On passe alors par un
  // ImageData d'un pixel par case, agrandi d'un coup.
  if (cell < LOD_PIXEL) {
    drawPixels(ctx, board, r, originX, originY, cell);
    drawCursor(ctx, cursor, originX, originY, cell, n);
    return;
  }

  const showText = cell >= LOD_TEXT;
  const gap = cell >= LOD_BORDER ? Math.max(1, Math.round(cell / 14)) : 0;
  const size = gap > 0 ? cell - gap : Math.ceil(cell);

  for (let b = 0; b < BUCKET_COUNT; b++) buckets[b].length = 0;
  flagOwners.length = 0;
  flagMineOwners.length = 0;

  // ── Passe 1 : classement des cases visibles en buckets ────────────────
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * n;
    const sy = originY + y * cell;
    for (let x = r.x0; x < r.x1; x++) {
      const i = row + x;
      const s = state[i];
      let b: number;
      if (s === COVERED) b = BUCKET_COVERED;
      else if (s === FLAGGED) {
        b = minesExposed && mines[i] ? BUCKET_FLAGGED_MINE : BUCKET_FLAGGED;
        (b === BUCKET_FLAGGED ? flagOwners : flagMineOwners).push(flagOwner[i]);
      } else if (mines[i]) b = BUCKET_MINE;
      else b = BUCKET_ADJ0 + adj[i];
      const arr = buckets[b];
      arr.push(originX + x * cell, sy);
    }
  }

  // ── Passe 2 : un seul changement de fillStyle par bucket ──────────────
  const fills = showText ? FILL_HI : FILL_LO;
  for (let b = 0; b < BUCKET_COUNT; b++) {
    const arr = buckets[b];
    if (arr.length === 0) continue;
    ctx.fillStyle = fills[b];
    for (let k = 0; k < arr.length; k += 2) {
      ctx.fillRect(arr[k], arr[k + 1], size, size);
    }
  }

  if (showText) {
    drawBevels(ctx, size);
    drawDigits(ctx, cell, size);
    // Les mines d'abord : sur une case drapeautée à la défaite, le fanion doit
    // se dessiner PAR-DESSUS la bombe.
    drawMines(ctx, size);
    drawFlags(ctx, size);
  }

  drawPeerCursors(ctx, view, originX, originY, cell, n);
  drawCursor(ctx, cursor, originX, originY, cell, n);
}

/**
 * Curseurs des autres joueurs, dans leur couleur. Trait plus fin que le
 * curseur local, et nom affiché seulement quand la case est assez grande pour
 * que ce soit lisible.
 */
function drawPeerCursors(
  ctx: CanvasRenderingContext2D,
  view: GameView,
  originX: number,
  originY: number,
  cell: number,
  n: number,
): void {
  const { peers, players } = view;
  if (peers.length === 0) return;
  const lw = Math.max(1.5, Math.round(cell * 0.07));
  const showNames = cell >= 20;
  if (showNames) {
    ctx.font = `600 ${Math.max(10, Math.round(cell * 0.32))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
  }

  for (const p of peers) {
    if (p.x < 0 || p.y < 0 || p.x >= n || p.y >= n) continue;
    const color = players.find((q) => q.id === p.id)?.color ?? PLAYER_COLORS[p.id] ?? PLAYER_COLORS[0];
    const x = originX + p.x * cell;
    const y = originY + p.y * cell;
    ctx.lineWidth = lw;
    ctx.strokeStyle = color;
    ctx.strokeRect(x + lw / 2, y + lw / 2, Math.max(cell - lw, lw), Math.max(cell - lw, lw));
    if (showNames) {
      const name = players.find((q) => q.id === p.id)?.name;
      if (name) {
        ctx.fillStyle = color;
        ctx.fillText(name, x + cell / 2, y - lw);
      }
    }
  }
}

/* Buffer réutilisé entre les frames : redimensionné seulement si la plage
   visible change de taille. */
let pxCanvas: HTMLCanvasElement | null = null;
let pxCtx: CanvasRenderingContext2D | null = null;
let pxImage: ImageData | null = null;

/** Un pixel par case, écrit directement dans un ImageData puis agrandi.
 *  ~20× plus rapide qu'un fillRect par case sur une carte 1000×1000. */
function drawPixels(
  ctx: CanvasRenderingContext2D,
  board: Board,
  r: Range,
  originX: number,
  originY: number,
  cell: number,
): void {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  if (w <= 0 || h <= 0) return;

  if (!pxCanvas) {
    pxCanvas = document.createElement('canvas');
    pxCtx = pxCanvas.getContext('2d', { willReadFrequently: false })!;
  }
  // `!pxImage` est indispensable : un canvas neuf mesure 300×150, donc une
  // plage visible de exactement 300×150 sauterait l'allocation.
  if (!pxImage || pxCanvas.width !== w || pxCanvas.height !== h) {
    pxCanvas.width = w;
    pxCanvas.height = h;
    pxImage = pxCtx!.createImageData(w, h);
  }

  const { n, state, adj, mines, minesExposed } = board;
  const data = pxImage!.data;
  let o = 0;
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * n;
    for (let x = r.x0; x < r.x1; x++) {
      const i = row + x;
      const s = state[i];
      let b: number;
      if (s === COVERED) b = BUCKET_COVERED;
      else if (s === FLAGGED) b = minesExposed && mines[i] ? BUCKET_FLAGGED_MINE : BUCKET_FLAGGED;
      else if (mines[i]) b = BUCKET_MINE;
      else b = BUCKET_ADJ0 + adj[i];
      const c = FILL_LO_RGB[b];
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
      o += 4;
    }
  }
  pxCtx!.putImageData(pxImage!, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pxCanvas, originX + r.x0 * cell, originY + r.y0 * cell, w * cell, h * cell);
}

/** Relief des cases couvertes : clair en haut/gauche, sombre en bas/droite. */
function drawBevels(ctx: CanvasRenderingContext2D, size: number): void {
  const t = Math.max(1, Math.round(size / 10));
  for (const b of [BUCKET_COVERED, BUCKET_FLAGGED]) {
    const arr = buckets[b];
    if (arr.length === 0) continue;
    ctx.fillStyle = C.coveredLight;
    for (let k = 0; k < arr.length; k += 2) {
      ctx.fillRect(arr[k], arr[k + 1], size, t);
      ctx.fillRect(arr[k], arr[k + 1], t, size);
    }
    ctx.fillStyle = C.coveredDark;
    for (let k = 0; k < arr.length; k += 2) {
      ctx.fillRect(arr[k], arr[k + 1] + size - t, size, t);
      ctx.fillRect(arr[k] + size - t, arr[k + 1], t, size);
    }
  }
}

/** Chiffres 1..8, groupés par couleur pour éviter 8 changements d'état par case. */
function drawDigits(ctx: CanvasRenderingContext2D, cell: number, size: number): void {
  ctx.font = `700 ${Math.round(cell * 0.6)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const half = size / 2;
  for (let d = 1; d <= 8; d++) {
    const arr = buckets[BUCKET_ADJ0 + d];
    if (arr.length === 0) continue;
    ctx.fillStyle = DIGIT_COLORS[d];
    const label = String(d);
    for (let k = 0; k < arr.length; k += 2) {
      ctx.fillText(label, arr[k] + half, arr[k + 1] + half + size * 0.04);
    }
  }
}

/** Fanion rouge à droite d'une hampe sombre : sans quoi une hampe claire et
 *  fine se lit comme un chiffre « 1 » sur la case couverte. */
function drawFlags(ctx: CanvasRenderingContext2D, size: number): void {
  const plain = buckets[BUCKET_FLAGGED];
  const overMine = buckets[BUCKET_FLAGGED_MINE];
  if (plain.length === 0 && overMine.length === 0) return;

  /**
   * [cases, poseurs, couleur de hampe, couleur par défaut, échelle, dx, dy]
   *
   * Sur une bombe dévoilée le fanion devient un petit badge dans le coin
   * supérieur droit. Deux raisons : à taille pleine il masquait justement la
   * bombe qu'il est censé laisser voir, et un fanion rouge sur le fond rouge
   * sombre d'une mine est illisible.
   */
  const variants: [number[], number[], string, string, number, number, number][] = [
    [plain, flagOwners, C.flagPole, C.flag, 1, 0, 0],
    [overMine, flagMineOwners, C.flagOnMine, C.flagOnMine, 0.55, size * 0.44, size * 0.03],
  ];

  for (const [arr, owners, poleColor, defaultColor, scale, dx, dy] of variants) {
    if (arr.length === 0) continue;
    const s = size * scale;
    const pole = Math.max(1, Math.round(s / 11));

    ctx.fillStyle = poleColor;
    for (let k = 0; k < arr.length; k += 2) {
      const x = arr[k] + dx;
      const y = arr[k + 1] + dy;
      ctx.fillRect(x + s * 0.3, y + s * 0.15, pole, s * 0.64);
      ctx.fillRect(x + s * 0.16, y + s * 0.75, s * 0.5, pole * 1.3);
    }

    // Le fanion prend la couleur de son poseur. En solo tous les poseurs
    // valent 0, donc un seul groupe et un rendu identique à avant.
    for (const g of byOwner) g.length = 0;
    for (let k = 0, o = 0; k < arr.length; k += 2, o++) {
      const owner = owners[o] ?? 0;
      byOwner[owner < byOwner.length ? owner : 0].push(k);
    }

    for (let owner = 0; owner < byOwner.length; owner++) {
      const group = byOwner[owner];
      if (group.length === 0) continue;
      ctx.fillStyle = owner === 0 ? defaultColor : PLAYER_COLORS[owner];
      ctx.beginPath();
      for (const k of group) {
        const x = arr[k] + dx + s * 0.3 + pole;
        const y = arr[k + 1] + dy;
        ctx.moveTo(x, y + s * 0.16);
        ctx.lineTo(x + s * 0.42, y + s * 0.33);
        ctx.lineTo(x, y + s * 0.5);
      }
      ctx.fill();
    }
  }
}

function drawMines(ctx: CanvasRenderingContext2D, size: number): void {
  const bare = buckets[BUCKET_MINE];
  const flagged = buckets[BUCKET_FLAGGED_MINE];
  if (bare.length === 0 && flagged.length === 0) return;
  const rad = size * 0.26;
  const half = size / 2;
  ctx.fillStyle = C.mine;
  ctx.beginPath();
  for (const arr of [bare, flagged]) {
    for (let k = 0; k < arr.length; k += 2) {
      const cx = arr[k] + half;
      const cy = arr[k + 1] + half;
      ctx.moveTo(cx + rad, cy);
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    }
  }
  ctx.fill();

  const spike = Math.max(1, Math.round(size / 12));
  for (const arr of [bare, flagged]) {
    for (let k = 0; k < arr.length; k += 2) {
      const cx = arr[k] + half;
      const cy = arr[k + 1] + half;
      ctx.fillRect(cx - size * 0.38, cy - spike / 2, size * 0.76, spike);
      ctx.fillRect(cx - spike / 2, cy - size * 0.38, spike, size * 0.76);
    }
  }
}

/** Toujours visible, même quand une case fait 2 px : épaisseur plancher de 2 px. */
function drawCursor(
  ctx: CanvasRenderingContext2D,
  cursor: { x: number; y: number },
  originX: number,
  originY: number,
  cell: number,
  n: number,
): void {
  if (cursor.x < 0 || cursor.y < 0 || cursor.x >= n || cursor.y >= n) return;
  const lw = Math.max(2, Math.round(cell * 0.1));
  ctx.lineWidth = lw;
  ctx.strokeStyle = C.cursor;
  const x = originX + cursor.x * cell;
  const y = originY + cursor.y * cell;
  const s = Math.max(cell, lw * 3);
  ctx.strokeRect(
    x - (s - cell) / 2 + lw / 2,
    y - (s - cell) / 2 + lw / 2,
    s - lw,
    s - lw,
  );
}
