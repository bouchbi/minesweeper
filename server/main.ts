import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { normalizeRoomCode } from '../shared/protocol';
import { Room } from './room';

const PORT = Number(process.env.PORT ?? 8080);
/** 0.0.0.0 par défaut : indispensable dans un conteneur Docker. */
const HOST = process.env.HOST ?? '0.0.0.0';
/** Borne la mémoire : une salle en 1000×1000 pèse ~9 Mo. */
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 50);
/** Les clients n'envoient que de petits JSON ; `ws` accepte 100 Mio par défaut. */
const MAX_PAYLOAD = 16 * 1024;
/** Une connexion qui ne répond pas à un ping dans l'intervalle est coupée. */
const PING_MS = 30_000;

// Un chemin relatif est résolu depuis la racine du projet (le bundle vit dans
// dist-server/), pas depuis le cwd : le serveur se lance de n'importe où.
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(PROJECT_DIR, process.argv[2] ?? 'dist');

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

/** Une salle par code. Créée au premier arrivant, libérée quand elle se vide. */
const rooms = new Map<string, Room>();

function roomFor(code: string): Room | null {
  const existing = rooms.get(code);
  if (existing) return existing;
  if (rooms.size >= MAX_ROOMS) return null;
  const room = new Room(() => {
    // `leave` peut être appelé deux fois (error puis close) : on ne libère que
    // si c'est encore bien cette salle-là qui occupe le code.
    if (rooms.get(code) !== room) return;
    room.dispose();
    rooms.delete(code);
    console.log(`[${code}] salle libérée (${rooms.size} ouverte(s))`);
  });
  rooms.set(code, room);
  console.log(`[${code}] salle ouverte (${rooms.size} ouverte(s))`);
  return room;
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

  const code = normalizeRoomCode(new URL(req.url ?? '/', 'http://localhost').searchParams.get('room'));
  if (!code) {
    reject(socket, 'Code de salle invalide (4 à 12 lettres ou chiffres).');
    return;
  }
  const room = roomFor(code);
  if (!room) {
    reject(socket, 'Serveur plein : trop de salles ouvertes, réessaie plus tard.');
    return;
  }

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
    for (const room of rooms.values()) room.dispose();
    wss.close();
    http.close(() => process.exit(0));
  });
}
