import { forEachNeighbor, type Board } from '../game/board';
import type { GameView } from './gameView';

/*
 * Boule à facettes, façon bombe de couleur de Candy Crush : la boule apparaît
 * sur sa case en tournant et en grossissant, lance un trait blanc vers chaque
 * zone qu'elle ouvre, et chaque zone ne se dévoile qu'à l'arrivée de son
 * trait. Les traits s'effacent, puis la boule.
 *
 * Le moteur a déjà ouvert les zones : pendant l'animation, leurs cases sont
 * VOILÉES (dessinées couvertes) jusqu'à l'arrivée du trait. Tout est en
 * coordonnées carte : l'animation suit le pan et le zoom.
 */

/** Apparition de la boule, en ms. */
const GROW_MS = 450;
/** Départ du premier trait après l'apparition de la boule. */
const FIRST_BEAM_MS = 380;
/** Écart entre les départs de deux traits. */
const BEAM_STAGGER_MS = 160;
/** Trajet d'un trait jusqu'à sa zone. */
const BEAM_TRAVEL_MS = 320;
/** Le trait reste affiché après l'arrivée… */
const BEAM_HOLD_MS = 260;
/** …puis s'efface. */
const BEAM_FADE_MS = 260;
/** Disparition de la boule, une fois tous les traits effacés. */
const BALL_OUT_MS = 320;

export type DiscoBeam = {
  /** Case de départ de la zone. */
  x: number;
  y: number;
  /** Cases de la zone, voilées jusqu'à `arriveAt`. */
  cells: number[];
  departAt: number;
  arriveAt: number;
  arrived: boolean;
};

export type Disco = {
  /** Case de la boule. */
  x: number;
  y: number;
  /** Début de l'animation (dans le futur si la boule elle-même est dans une
   *  zone encore voilée d'une autre boule). */
  t0: number;
  beams: DiscoBeam[];
};

/* ── Voile ───────────────────────────────────────────────────────────── */

function veil(view: GameView, n: number, cells: number[]): void {
  if (!view.veil || view.veil.length !== n * n) {
    view.veil = new Uint8Array(n * n);
    view.veilCount = 0;
  }
  for (const c of cells) {
    if (view.veil[c]) continue;
    view.veil[c] = 1;
    view.veilCount++;
  }
}

function unveil(view: GameView, cells: number[]): void {
  const v = view.veil;
  if (!v) return;
  for (const c of cells) {
    if (!v[c]) continue;
    v[c] = 0;
    view.veilCount--;
  }
}

/** Voile en cours, ou null s'il n'y a rien de voilé : le rendu teste ça une
 *  fois par frame plutôt qu'une fois par case. */
export function activeVeil(view: GameView): Uint8Array | null {
  return view.veilCount > 0 ? view.veil : null;
}

/**
 * Cases d'une zone : celles que la cascade partie de `origin` a ouvertes, soit
 * un parcours à travers les cases vides (adj = 0), limité aux cases marquées
 * 1 dans `fresh` (ouvertes par l'action en cours). Sans cette limite, un
 * chiffre déjà visible au bord de la zone serait voilé et clignoterait.
 *
 * Les cases retenues passent à 2 dans `fresh` : deux zones ne se disputent
 * jamais la même case.
 */
export function zoneCells(board: Board, fresh: Uint8Array, origin: number): number[] {
  if (fresh[origin] !== 1) return [];
  const out = [origin];
  fresh[origin] = 2;
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (board.adj[c] !== 0) continue;
    forEachNeighbor(board.n, c, (j) => {
      if (fresh[j] === 1) {
        fresh[j] = 2;
        out.push(j);
      }
    });
  }
  return out;
}

/* ── Construction ────────────────────────────────────────────────────── */

export function startDisco(view: GameView, n: number, i: number, t0: number): Disco {
  const d: Disco = { x: i % n, y: (i / n) | 0, t0, beams: [] };
  view.discos.push(d);
  return d;
}

/** Ajoute un trait vers la zone partant de `origin`, et voile ses cases. */
export function addBeam(view: GameView, n: number, d: Disco, origin: number, cells: number[]): DiscoBeam {
  const departAt = d.t0 + FIRST_BEAM_MS + d.beams.length * BEAM_STAGGER_MS;
  const beam: DiscoBeam = {
    x: origin % n,
    y: (origin / n) | 0,
    cells,
    departAt,
    arriveAt: departAt + BEAM_TRAVEL_MS,
    arrived: false,
  };
  d.beams.push(beam);
  veil(view, n, cells);
  return beam;
}

/* ── Chronologie ─────────────────────────────────────────────────────── */

function endOf(d: Disco): number {
  const last = d.beams.length ? d.beams[d.beams.length - 1].arriveAt + BEAM_HOLD_MS + BEAM_FADE_MS : d.t0 + GROW_MS;
  return last + BALL_OUT_MS;
}

/**
 * Fait avancer les animations : lève le voile des zones dont le trait vient
 * d'arriver, et retire les boules terminées. À appeler AVANT de classer les
 * cases, pour qu'une zone dévoilée s'affiche dans la frame même.
 *
 * @returns true si le plateau visible a changé (minimap à reconstruire).
 */
export function advanceDiscos(view: GameView, now: number): boolean {
  const { discos } = view;
  if (discos.length === 0) return false;
  let changed = false;
  let kept = 0;
  for (const d of discos) {
    for (const b of d.beams) {
      if (b.arrived || now < b.arriveAt) continue;
      b.arrived = true;
      unveil(view, b.cells);
      // Petit éclat blanc à l'impact.
      view.flashes.push({ x: b.x, y: b.y, r: 1, diamond: false, t0: now, color: '#ffffff' });
      changed = true;
    }
    if (now < endOf(d)) discos[kept++] = d;
    else {
      // Filet de sécurité : rien ne doit rester voilé une fois l'animation finie.
      for (const b of d.beams) if (!b.arrived) unveil(view, b.cells);
    }
  }
  discos.length = kept;
  return changed;
}

/** Abandonne toutes les animations en levant leur voile. */
export function clearDiscos(view: GameView): void {
  for (const d of view.discos) for (const b of d.beams) if (!b.arrived) unveil(view, b.cells);
  view.discos.length = 0;
}

/* ── Dessin ──────────────────────────────────────────────────────────── */

const easeOutBack = (t: number) => {
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/** Trait électrique : une ligne brisée qui frémit d'une frame à l'autre. */
function strokeBeam(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  amp: number,
  seed: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const nx = -dy / len;
  const ny = dx / len;
  const segments = Math.max(2, Math.min(14, Math.round(len / 28)));
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let k = 1; k < segments; k++) {
    const t = k / segments;
    const off = Math.sin(k * 12.9898 + seed) * amp;
    ctx.lineTo(x0 + dx * t + nx * off, y0 + dy * t + ny * off);
  }
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/**
 * Dessine traits et boules par-dessus le plateau.
 * @returns true tant qu'une animation est en cours.
 */
export function drawDiscos(
  ctx: CanvasRenderingContext2D,
  view: GameView,
  originX: number,
  originY: number,
  cell: number,
  now: number,
): boolean {
  const { discos } = view;
  if (discos.length === 0) return false;
  const center = (x: number, y: number) => [originX + (x + 0.5) * cell, originY + (y + 0.5) * cell];
  const ballMax = Math.min(140, Math.max(44, cell * 2.6));
  const lw = Math.min(5, Math.max(2, cell * 0.12));
  const amp = Math.min(7, Math.max(2, cell * 0.25));
  // Le trait change de forme ~25 fois par seconde : assez pour crépiter, pas
  // assez pour scintiller.
  const seed = Math.floor(now / 40);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of discos) {
    if (now < d.t0) continue;
    const [bx, by] = center(d.x, d.y);

    // Traits d'abord, la boule passe par-dessus.
    for (const b of d.beams) {
      if (now < b.departAt) continue;
      const fadeStart = b.arriveAt + BEAM_HOLD_MS;
      const alpha = now < fadeStart ? 1 : Math.max(0, 1 - (now - fadeStart) / BEAM_FADE_MS);
      if (alpha <= 0) continue;
      const p = Math.min(1, (now - b.departAt) / BEAM_TRAVEL_MS);
      const [tx, ty] = center(b.x, b.y);
      const ex = bx + (tx - bx) * p;
      const ey = by + (ty - by) * p;
      ctx.globalAlpha = alpha;
      // Halo large et doux, puis cœur blanc net.
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 16;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = lw * 3;
      strokeBeam(ctx, bx, by, ex, ey, amp, seed + b.x);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw;
      strokeBeam(ctx, bx, by, ex, ey, amp, seed + b.x);
    }

    // Boule : grossit en tournant, puis rétrécit une fois les traits effacés.
    const age = now - d.t0;
    const end = endOf(d);
    let scale = age < GROW_MS ? easeOutBack(age / GROW_MS) : 1;
    if (now > end - BALL_OUT_MS) scale *= Math.max(0, (end - now) / BALL_OUT_MS);
    if (scale <= 0) continue;
    const size = ballMax * scale;
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(age * 0.006);
    ctx.shadowColor = '#fde68a';
    ctx.shadowBlur = 26;
    ctx.font = `${Math.round(size)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🪩', 0, size * 0.04);
    ctx.restore();
  }
  ctx.restore();
  return true;
}
