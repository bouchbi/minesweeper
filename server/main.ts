import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room } from './room';

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = resolve(process.argv[2] ?? 'dist');

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
  // normalize + préfixe vérifié : empêche un ../../ de sortir de ROOT.
  let path = join(ROOT, normalize(decodeURIComponent(url.pathname)));
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

const room = new Room();
const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (socket: WebSocket) => {
  const conn = room.join(
    (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    () => socket.close(),
  );

  if (!conn) {
    socket.send(JSON.stringify({ t: 'error', message: 'Partie complète (8 joueurs maximum).' }));
    socket.close();
    return;
  }

  socket.on('message', (data, isBinary) => {
    if (isBinary) return; // le client n'envoie que du JSON
    room.handle(conn, data.toString());
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

http.listen(PORT, () => {
  const urls = lanUrls();
  console.log(`\n  Démineur co-op — serveur démarré\n`);
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
    room.dispose();
    wss.close();
    http.close(() => process.exit(0));
  });
}
