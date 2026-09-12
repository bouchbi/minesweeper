/** Taille de case (px CSS) à partir de laquelle on dessine chiffres et reliefs. */
export const LOD_TEXT = 14;
/** Taille de case à partir de laquelle on garde un interstice entre les cases. */
export const LOD_BORDER = 7;

export const C = {
  pageBg: '#0f1115',
  boardBg: '#15181e',
  covered: '#79838f',
  coveredLight: '#98a2ae',
  coveredDark: '#5b6572',
  revealed: '#232830',
  revealedEmpty: '#1c2029',
  flag: '#ef4444',
  flagPole: '#1f2937',
  /** Badge « tu avais bien repéré celle-ci », posé sur le fond rouge d'une mine. */
  flagOnMine: '#f3f4f6',
  mineBg: '#7f1d1d',
  mine: '#0b0d10',
  cursor: '#fbbf24',
  minimapFrame: '#fbbf24',
};

/** Couleurs des chiffres 1..8 (index 0 inutilisé). */
export const DIGIT_COLORS = [
  '',
  '#60a5fa',
  '#4ade80',
  '#f87171',
  '#c084fc',
  '#fb923c',
  '#22d3ee',
  '#e5e7eb',
  '#9ca3af',
];

/**
 * Buckets de rendu. L'ordre est celui utilisé par drawGrid :
 *   0 = couverte, 1 = drapeau, 2 = mine révélée, 3..11 = révélée avec adj 0..8,
 *   12 = drapeau posé sur une bombe (uniquement après une défaite).
 */
export const BUCKET_COVERED = 0;
export const BUCKET_FLAGGED = 1;
export const BUCKET_MINE = 2;
export const BUCKET_ADJ0 = 3;
export const BUCKET_FLAGGED_MINE = 12;
export const BUCKET_COUNT = 13;

/** Remplissage de fond à zoom élevé : les chiffres portent l'information. */
export const FILL_HI: string[] = [
  C.covered,
  C.covered,
  C.mineBg,
  C.revealedEmpty,
  C.revealed, C.revealed, C.revealed, C.revealed,
  C.revealed, C.revealed, C.revealed, C.revealed,
  C.mineBg,
];

/** Même palette que FILL_LO, en composantes RGB : utilisée par le rendu
 *  ImageData employé sous LOD_PIXEL (voir drawGrid). Dérivée automatiquement
 *  pour rester synchronisée avec FILL_LO. */
export function toRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Remplissage à zoom faible : plus de texte lisible, donc le nombre de bombes
 * adjacentes devient une teinte. La carte se lit alors comme une carte de chaleur.
 */
export const FILL_LO: string[] = [
  C.covered,
  C.flag,
  C.mineBg,
  '#1c2029',
  '#1e3a5f', '#1e4d33', '#5c2626', '#4a2a5e',
  '#5e3a1a', '#155e64', '#4b5563', '#6b7280',
  C.mineBg,
];

/** Sous cette taille de case, fillRect devient trop coûteux (une carte 1000×1000
 *  entièrement dézoomée = 1 M de rectangles par frame) : on écrit les pixels
 *  directement dans un ImageData qu'on agrandit ensuite. */
export const LOD_PIXEL = 3;

export const FILL_LO_RGB: [number, number, number][] = FILL_LO.map(toRgb);
