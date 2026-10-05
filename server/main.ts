import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { PRESETS } from '../src/game/presets';
import { normalizeRoomCode, randomRoomCode, type NetConfig, type RecordBoard } from '../shared/protocol';
import { Room, type RoomHooks } from './room';
import { Store } from './store';

const PORT = Number(process.env.PORT ?? 8080);
/** 0.0.0.0 par défaut : indispensable dans un conteneur Docker. */
const HOST = process.env.HOST ?? '0.0.0.0';
/** Borne la mémoire : une salle en 1000×1000 pèse ~9 Mo. */
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 50);
/** Les clients n'envoient que de petits JSON ; `ws` accepte 100 Mio par défaut. */
const MAX_PAYLOAD = 16 * 1024;
/** Une connexion qui ne répond pas à un ping dans l'intervalle est coupée. */
const PING_MS = 30_000;
/** Parties mises de côté : plafond (les plus anciennes partent d'abord) et
 *  durée de conservation sans que personne n'y revienne. */
const MAX_SAVES = Number(process.env.MAX_SAVES ?? 500);
const SAVE_TTL_DAYS = Number(process.env.SAVE_TTL_DAYS ?? 30);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Meilleurs temps renvoyés par catégorie à l'accueil. */
const RECORDS_SHOWN = 5;

// Un chemin relatif est résolu depuis la racine du projet (le bundle vit dans
// dist-server/), pas depuis le cwd : le serveur se lance de n'importe où.
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(PROJECT_DIR, process.argv[2] ?? 'dist');
const DATA_DIR = resolve(PROJECT_DIR, process.env.DATA_DIR ?? 'data');

/** Sans stockage (dossier en lecture seule, disque plein) le jeu tourne
 *  quand même : seules la reprise des parties et les records manquent. */
let store: Store | null = null;
try {
  store = new Store(DATA_DIR);
} catch (err) {
  console.error(`  Stockage indisponible (${DATA_DIR}) : parties non sauvegardées, records désactivés.`, err);
}

function purgeSaves(): void {
  try {
    const n = store?.purgeSaves(Date.now() - SAVE_TTL_DAYS * DAY_MS) ?? 0;
    if (n > 0) console.log(`  ${n} sauvegarde(s) expirée(s) supprimée(s)`);
  } catch (err) {
    console.error('Purge des sauvegardes impossible :', err);
  }
}
purgeSaves();
const purger = setInterval(purgeSaves, DAY_MS);

/** Classement servi à l'accueil, gardé tant qu'aucun record ne change — et
 *  au plus une minute, pour suivre les suppressions faites avec admin.mjs. */
let recordsCache: string | null = null;
let recordsCachedAt = 0;
const RECORDS_CACHE_MS = 60_000;

function serveRecords(res: ServerResponse): void {
  if (recordsCache === null || Date.now() - recordsCachedAt > RECORDS_CACHE_MS) {
    recordsCachedAt = Date.now();
    let boards: RecordBoard[] = [];
    try {
      boards = store?.allRecords(RECORDS_SHOWN) ?? [];
    } catch (err) {
      console.error('Lecture des records impossible :', err);
    }
    recordsCache = JSON.stringify(boards);
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    // En développement la page vient de Vite (port 5173) : lecture seule et
    // publique, rien à protéger.
    'access-control-allow-origin': '*',
  });
  res.end(recordsCache);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Sert le client compilé. Toute route inconnue retombe sur index.html : le
 * client n'a pas de routeur, mais un rechargement sur une URL quelconque doit
 * quand même ouvrir le jeu.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/records') {
    serveRecords(res);
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // `GET /%` : URIError, qui ferait tomber tout le processus.
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Requête invalide');
    return;
  }
  // normalize + préfixe vérifié : empêche un ../../ de sortir de ROOT.
  let path = join(ROOT, normalize(pathname));
  if (!path.startsWith(ROOT)) path = join(ROOT, 'index.html');
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(ROOT, 'index.html');

  if (!existsSync(path)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end("Client non compilé. Lance d'abord : npm run build");
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
}

/**
 * Salles ouvertes, par code. Une salle naît d'une demande de création (le
 * serveur tire alors le code) ou de la reprise d'une partie mise de côté ;
 * elle est libérée quand elle reste vide.
 */
const rooms = new Map<string, Room>();

function hooksFor(code: string, getRoom: () => Room): RoomHooks {
  return {
    store,
    maxSaves: MAX_SAVES,
    onRecord: () => {
      recordsCache = null;
    },
    onEmpty: () => {
      const room = getRoom();
      // Garde-fou : on ne libère que si c'est encore bien cette salle-là qui
      // occupe le code.
      if (rooms.get(code) !== room) return;
      room.dispose();
      rooms.delete(code);
      console.log(`[${code}] salle libérée (${rooms.size} ouverte(s))`);
    },
  };
}

/** Code inutilisé, ni par une salle ouverte ni par une partie sauvegardée :
 *  une nouvelle salle ne peut pas retomber sur une ancienne partie. */
function freeCode(): string | null {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = randomRoomCode();
    if (rooms.has(code)) continue;
    try {
      if (store?.hasSave(code)) continue;
    } catch {
      return null;
    }
    return code;
  }
  return null;
}

function createRoom(start?: NetConfig): Room | null {
  const code = freeCode();
  if (!code) return null;
  let room: Room | null = null;
  room = new Room(code, hooksFor(code, () => room!), start);
  rooms.set(code, room);
  console.log(`[${code}] salle ouverte (${rooms.size} ouverte(s))`);
  return room;
}

/** Rouvre une partie mise de côté, ou null s'il n'y en a pas. */
function restoreRoom(code: string): Room | null {
  let blob: Uint8Array | null = null;
  try {
    blob = store?.loadSave(code) ?? null;
  } catch (err) {
    console.error(`[${code}] lecture de la sauvegarde impossible :`, err);
  }
  if (!blob) return null;
  let room: Room | null = null;
  try {
    room = Room.restore(code, hooksFor(code, () => room!), blob);
  } catch (err) {
    console.error(`[${code}] sauvegarde illisible, supprimée :`, err);
    try {
      store?.deleteSave(code);
    } catch {
      /* rien de plus à faire */
    }
    return null;
  }
  rooms.set(code, room);
  console.log(`[${code}] partie reprise (${rooms.size} salle(s) ouverte(s))`);
  return room;
}

/** Partie lancée d'emblée à la création (solo sur une carte prédéfinie). */
function startConfig(params: URLSearchParams): NetConfig | undefined {
  const preset = PRESETS.find((p) => p.id === params.get('preset'));
  if (!preset) return undefined;
  return { n: preset.n, mineCount: preset.mineCount, bonus: params.get('bonus') === '1' };
}

function reject(socket: WebSocket, message: string): void {
  socket.send(JSON.stringify({ t: 'error', message }));
  socket.close();
}

const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_PAYLOAD });

const alive = new WeakSet<WebSocket>();
const pinger = setInterval(() => {
  for (const socket of wss.clients) {
    // Pas de pong depuis le dernier ping : connexion morte (mobile en veille,
    // coupure réseau). Sans ça elle resterait « connectée » et occuperait une
    // place, ou empêcherait l'abandon de la partie.
    if (!alive.has(socket)) {
      socket.terminate();
      continue;
    }
    alive.delete(socket);
    socket.ping();
  }
}, PING_MS);

wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
  alive.add(socket);
  socket.on('pong', () => alive.add(socket));

  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  let room: Room | null;
  if (params.has('create')) {
    if (rooms.size >= MAX_ROOMS) {
      reject(socket, 'Serveur plein : trop de salles ouvertes, réessaie plus tard.');
      return;
    }
    room = createRoom(startConfig(params));
    if (!room) {
      reject(socket, 'Impossible de créer une salle, réessaie.');
      return;
    }
  } else {
    const code = normalizeRoomCode(params.get('room'));
    if (!code) {
      reject(socket, 'Code de salle invalide (4 à 12 lettres ou chiffres).');
      return;
    }
    room = rooms.get(code) ?? null;
    if (!room) {
      if (rooms.size >= MAX_ROOMS) {
        reject(socket, 'Serveur plein : trop de salles ouvertes, réessaie plus tard.');
        return;
      }
      room = restoreRoom(code);
    }
    if (!room) {
      reject(socket, 'Salle introuvable : vérifie le code, ou crée une nouvelle salle.');
      return;
    }
  }
  const { code } = room;

  const conn = room.join(
    (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    () => socket.close(),
  );

  if (!conn) {
    reject(socket, 'Salle complète (8 joueurs maximum).');
    return;
  }

  socket.on('message', (data, isBinary) => {
    if (isBinary) return; // le client n'envoie que du JSON
    try {
      room.handle(conn, data.toString());
    } catch (err) {
      // Filet de sécurité : un message inattendu ne doit jamais faire tomber
      // les parties de toutes les autres salles.
      console.error(`[${code}] message ignoré :`, err);
    }
  });
  socket.on('close', () => room.leave(conn));
  socket.on('error', () => room.leave(conn));
});

function lanUrls(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
    }
  }
  return out;
}

http.listen(PORT, HOST, () => {
  const urls = lanUrls();
  console.log(`\n  Démineur co-op — serveur démarré (salles max : ${MAX_ROOMS})\n`);
  console.log(`  Sur cette machine : http://localhost:${PORT}`);
  if (urls.length) {
    console.log(`  Depuis le réseau  : ${urls.join('\n                      ')}`);
  } else {
    console.log(`  (aucune interface réseau détectée : jeu en local uniquement)`);
  }
  console.log(`\n  Ctrl+C pour arrêter.\n`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(pinger);
    clearInterval(purger);
    // Un redéploiement envoie SIGTERM : les parties en cours sont mises de
    // côté et reprendront quand les joueurs reviendront.
    for (const room of rooms.values()) {
      room.persist();
      room.dispose();
    }
    store?.close();
    // Sans ça, `http.close` attend que chaque joueur se déconnecte de lui-même
    // et l'arrêt traîne jusqu'au SIGKILL. Les clients se reconnecteront au
    // nouveau serveur et retrouveront leur partie.
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    http.close(() => process.exit(0));
    http.closeAllConnections();
  });
}
