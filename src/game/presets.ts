export type Preset = {
  id: string;
  name: string;
  n: number;
  mineCount: number;
  note: string;
};

/**
 * Les configurations officielles du démineur sont rectangulaires ; comme les
 * cartes sont ici carrées, « Expert » est transposé en 22×22/99, dont la
 * densité (20,5 %) est celle du 30×16/99 d'origine à 0,1 point près.
 */
export const PRESETS: Preset[] = [
  { id: 'beginner',     name: 'Débutant',      n: 9,   mineCount: 10,   note: 'Le 9×9 classique' },
  { id: 'intermediate', name: 'Intermédiaire', n: 16,  mineCount: 40,   note: 'Le 16×16 classique' },
  { id: 'expert',       name: 'Expert',        n: 22,  mineCount: 99,   note: 'Densité du 30×16/99 officiel' },
  { id: 'chaos',        name: 'Chaos',         n: 10,  mineCount: 99,   note: 'Une seule case sûre' },
  { id: 'extreme',      name: 'Extrême',       n: 50,  mineCount: 500,  note: '2 500 cases' },
  { id: 'nightmare',    name: 'Cauchemar',     n: 100, mineCount: 2000, note: '10 000 cases' },
  { id: 'marathon',     name: 'Marathon',      n: 200, mineCount: 8000, note: '40 000 cases' },
];

export const MIN_N = 5;
export const MAX_N = 1000;

export function densityPercent(n: number, mineCount: number): number {
  return (mineCount / (n * n)) * 100;
}

/** @returns un message d'erreur, ou null si la configuration est jouable. */
export function validateConfig(n: number, mineCount: number): string | null {
  if (!Number.isInteger(n) || n < MIN_N || n > MAX_N) {
    return `La largeur doit être un entier entre ${MIN_N} et ${MAX_N}.`;
  }
  const total = n * n;
  if (!Number.isInteger(mineCount) || mineCount < 1) {
    return 'Il faut au moins 1 bombe.';
  }
  if (mineCount >= total) {
    return `Le nombre de bombes doit être strictement inférieur à ${total.toLocaleString('fr-FR')} cases.`;
  }
  return null;
}
