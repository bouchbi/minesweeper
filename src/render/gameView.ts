import type { Peer, PlayerInfo } from '../../shared/protocol';
import { createViewport, type Viewport } from './viewport';

/**
 * État « vivant » de la partie, partagé entre le canvas de jeu, la minimap et
 * le HUD. Délibérément hors de React : il change à 60 fps pendant un pan et
 * n'a aucune raison de déclencher un rendu de l'arbre.
 *
 * Les consommateurs s'abonnent via `subscribe` et redessinent eux-mêmes.
 */
export type GameView = {
  vp: Viewport;
  cursor: { x: number; y: number };
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
  listeners: Set<() => void>;
  notify(): void;
  subscribe(fn: () => void): () => void;
};

export function createGameView(n: number): GameView {
  const view: GameView = {
    vp: createViewport(n),
    cursor: { x: (n / 2) | 0, y: (n / 2) | 0 },
    canvas: { w: 0, h: 0 },
    boardVersion: 0,
    pointer: null,
    peers: [],
    players: [],
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
