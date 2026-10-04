import type { Item, Peer, PlayerInfo } from '../../shared/protocol';
import type { Disco } from './discoFx';
import { createViewport, type Viewport } from './viewport';

/**
 * État « vivant » de la partie, partagé entre le canvas de jeu, la minimap et
 * le HUD. Délibérément hors de React : il change à 60 fps pendant un pan et
 * n'a aucune raison de déclencher un rendu de l'arbre.
 *
 * Les consommateurs s'abonnent via `subscribe` et redessinent eux-mêmes.
 */
/** Surbrillance éphémère autour de la case (x, y) : carré ou losange de rayon
 *  `r` (0 = la case seule). */
export type Flash = { x: number; y: number; r: number; diamond: boolean; t0: number; color: string };

/** Durée d'un flash, en ms. */
export const FLASH_MS = 900;

export type GameView = {
  vp: Viewport;
  cursor: { x: number; y: number };
  /** Le joueur pilote au clavier : le curseur clavier n'est dessiné que dans
   *  ce cas. À la souris il suivrait chaque clic et resterait affiché sur la
   *  dernière case touchée, sans rien signifier. */
  keyboard: boolean;
  /** Taille du canvas de jeu en px CSS. Tenue à jour par GameCanvas, lue par
   *  la minimap pour tracer le rectangle de viewport. */
  canvas: { w: number; h: number };
  /** Incrémenté à chaque mutation du plateau : invalide le cache de la minimap. */
  boardVersion: number;
  /** Case survolée par la souris, ou null si le joueur pilote au clavier.
   *  C'est elle qu'on diffuse en priorité : le curseur clavier ne bouge qu'aux
   *  flèches et aux clics, il ne dit donc pas où le joueur regarde. */
  pointer: { x: number; y: number } | null;
  /** Curseurs et vues des autres joueurs. Vide en solo. Rafraîchi à 10 Hz,
   *  donc délibérément hors de React comme le reste de GameView. */
  peers: Peer[];
  /** Sert à retrouver la couleur et le nom d'un joueur par son identifiant. */
  players: PlayerInfo[];
  /** Objet en attente de pose : le prochain clic (ou `r`) le pose au lieu de
   *  révéler, et le rendu montre la zone qu'il couvrira. */
  armed: Item | null;
  /** Flashs en cours. Le rendu les fait s'estomper puis les retire. Un flash
   *  dont `t0` est dans le futur attend son heure. */
  flashes: Flash[];
  /** Animations de boule à facettes en cours (voir discoFx.ts). */
  discos: Disco[];
  /** Cases déjà ouvertes mais dessinées couvertes, le temps que le trait de
   *  leur boule à facettes arrive. n*n, alloué au premier besoin. */
  veil: Uint8Array | null;
  /** Nombre de cases voilées : à 0, le rendu ne consulte pas `veil`. */
  veilCount: number;
  listeners: Set<() => void>;
  notify(): void;
  subscribe(fn: () => void): () => void;
};

export function createGameView(n: number): GameView {
  const view: GameView = {
    vp: createViewport(n),
    cursor: { x: (n / 2) | 0, y: (n / 2) | 0 },
    keyboard: true,
    canvas: { w: 0, h: 0 },
    boardVersion: 0,
    pointer: null,
    peers: [],
    players: [],
    armed: null,
    flashes: [],
    discos: [],
    veil: null,
    veilCount: 0,
    listeners: new Set(),
    notify() {
      for (const fn of view.listeners) fn();
    },
    subscribe(fn) {
      view.listeners.add(fn);
      return () => view.listeners.delete(fn);
    },
  };
  return view;
}
