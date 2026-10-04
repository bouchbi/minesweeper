import { COVERED, DEFUSED, FLAGGED, type Board } from '../game/board';
import { PLAYER_COLORS, type Peer, type PlayerInfo } from '../../shared/protocol';
import { C } from './palette';
import type { Viewport } from './viewport';

export const MINIMAP_SIZE = 160;

/** Classes visuelles agrégées par bloc de cases. */
const K_COVERED = 0;
const K_REVEALED = 1;
const K_FLAG = 2;
const K_MINE = 3;

const RGB: [number, number, number][] = [
  [0x79, 0x83, 0x8f], // couverte
  [0x1c, 0x20, 0x29], // révélée
  [0xef, 0x44, 0x44], // drapeau
  [0x7f, 0x1d, 0x1d], // mine
];

export type MinimapCache = {
  res: number;
  canvas: HTMLCanvasElement;
  /** Réutilisé d'une reconstruction à l'autre : la boucle finale réécrit
   *  chaque pixel, donc rien ne subsiste de la passe précédente. Évite 100 Ko
   *  de déchets par reconstruction, soit ~500 Ko/s au rythme maximal. */
  image: ImageData;
};

/* Compteurs réutilisés entre les reconstructions. */
let counts: Uint16Array | null = null;

/**
 * Recalcule l'image de fond de la minimap.
 *
 * Une seule passe sur toutes les cases, en écrivant directement dans un
 * ImageData à la résolution min(n, 160) : pas de fillRect par case, donc ça
 * reste rapide même sur du 1000×1000.
 *
 * Quand plusieurs cases tombent dans le même pixel, on prend la classe
 * MAJORITAIRE parmi les cases non couvertes (une mine l'emporte toujours :
 * c'est rare et c'est l'information la plus importante). Un simple « rang le
 * plus élevé gagne » donnerait une minimap saturée de rouge dès qu'un seul
 * drapeau traîne dans le bloc.
 */
export function buildMinimap(board: Board, prev: MinimapCache | null): MinimapCache {
  const { n, state, mines, minesExposed } = board;
  const res = Math.min(n, MINIMAP_SIZE);
  const cells = res * res;

  const reusable = prev && prev.res === res;
  const canvas = reusable ? prev.canvas : document.createElement('canvas');
  if (!reusable) {
    canvas.width = res;
    canvas.height = res;
  }
  const ctx = canvas.getContext('2d')!;
  const img = reusable ? prev.image : ctx.createImageData(res, res);
  const data = img.data;

  // 3 compteurs par pixel : révélées, drapeaux, mines.
  if (!counts || counts.length < cells * 3) counts = new Uint16Array(cells * 3);
  else counts.fill(0, 0, cells * 3);

  const scale = res / n;
  for (let y = 0; y < n; y++) {
    const rowIn = y * n;
    const rowOut = ((y * scale) | 0) * res;
    for (let x = 0; x < n; x++) {
      const i = rowIn + x;
      const s = state[i];
      if (s === COVERED) continue;
      const p = (rowOut + ((x * scale) | 0)) * 3;
      // Après une défaite, un drapeau juste compte comme une mine : la minimap
      // reste cohérente avec ce que le plateau affiche.
      if (s === FLAGGED) counts[minesExposed && mines[i] ? p + 2 : p + 1]++;
      // Mine désamorcée = mine connue, comme un drapeau. Testé avant `mines` :
      // en co-op le client n'a pas ce tableau, et la minimap doit être la même
      // qu'en solo.
      else if (s === DEFUSED) counts[p + 1]++;
      else if (mines[i]) counts[p + 2]++;
      else counts[p]++;
    }
  }

  for (let p = 0; p < cells; p++) {
    const revealed = counts[p * 3];
    const flags = counts[p * 3 + 1];
    const bombs = counts[p * 3 + 2];
    let k: number;
    if (bombs > 0) k = K_MINE;
    else if (revealed === 0 && flags === 0) k = K_COVERED;
    else k = flags > revealed ? K_FLAG : K_REVEALED;

    const c = RGB[k];
    const o = p * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = 255;
  }

  ctx.putImageData(img, 0, 0);
  return { res, canvas, image: img };
}

/** Blitte le cache puis trace le rectangle de viewport par-dessus. */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  cache: MinimapCache,
  n: number,
  vp: Viewport,
  viewW: number,
  viewH: number,
  size: number,
  peers: Peer[] = [],
  players: PlayerInfo[] = [],
): void {
  ctx.fillStyle = C.pageBg;
  ctx.fillRect(0, 0, size, size);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cache.canvas, 0, 0, cache.res, cache.res, 0, 0, size, size);

  if (vp.cell <= 0) return;
  const k = size / n;

  // Vues des autres joueurs d'abord, la sienne par-dessus : sur une grande
  // carte c'est ce qui montre d'un coup d'œil qui explore quoi.
  ctx.lineWidth = 1;
  for (const p of peers) {
    ctx.strokeStyle = players.find((q) => q.id === p.id)?.color ?? PLAYER_COLORS[p.id] ?? PLAYER_COLORS[0];
    const px = p.view.x0 * k;
    const py = p.view.y0 * k;
    ctx.strokeRect(
      Math.max(0.5, px),
      Math.max(0.5, py),
      Math.max(3, Math.min(size, (p.view.x1 - p.view.x0) * k)),
      Math.max(3, Math.min(size, (p.view.y1 - p.view.y0) * k)),
    );
  }

  const halfW = viewW / 2 / vp.cell;
  const halfH = viewH / 2 / vp.cell;

  const x = (vp.cx - halfW) * k;
  const y = (vp.cy - halfH) * k;
  const w = Math.min(size, halfW * 2 * k);
  const h = Math.min(size, halfH * 2 * k);

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = C.minimapFrame;
  ctx.strokeRect(
    Math.max(0.75, Math.min(size - w - 0.75, x)),
    Math.max(0.75, Math.min(size - h - 0.75, y)),
    Math.max(3, w),
    Math.max(3, h),
  );
}
