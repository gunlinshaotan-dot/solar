/**
 * Solar Nemesis — local static server + optional live reload
 * Usage: node server.js   |   npm start   |   start.bat
 *
 * Live reload is OFF by default (Windows file watchers were spamming reloads).
 * Enable with:  set LIVE_RELOAD=1 && node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const LIVE_RELOAD = /^(1|true|yes|on)$/i.test(String(process.env.LIVE_RELOAD || ''));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const WATCH_EXT = new Set(['.js', '.css', '.html', '.webmanifest', '.json']);

/** @type {Set<import('http').ServerResponse>} */
const sseClients = new Set();
let reloadTimer = null;

function sendReload(reason = 'change') {
  if (!LIVE_RELOAD) return;
  const payload = `event: reload\ndata: ${JSON.stringify({ reason, t: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {
      sseClients.delete(res);
    }
  }
  console.log(`[live-reload] → ${sseClients.size} client(s) (${reason})`);
}

function queueReload(reason) {
  if (!LIVE_RELOAD) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => sendReload(reason), 600);
}

function safeJoin(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  const clean = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, clean);
  const root = path.resolve(ROOT) + path.sep;
  if (full !== path.resolve(ROOT) && !full.startsWith(root)) return null;
  return full;
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/__reload' && (req.method === 'POST' || req.method === 'GET')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let reason = 'manual';
      try {
        if (body) reason = JSON.parse(body).file || reason;
      } catch (_) {}
      if (url.searchParams.get('file')) reason = url.searchParams.get('file');
      sendReload(reason);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, liveReload: LIVE_RELOAD, clients: sseClients.size }));
    });
    return;
  }

  if (url.pathname === '/__events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`: connected liveReload=${LIVE_RELOAD}\n\n`);
    if (LIVE_RELOAD) sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  let filePath = safeJoin(url.pathname === '/' ? '/index.html' : url.pathname);
  if (!filePath) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    fs.stat(filePath, (err2) => {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      serveFile(res, filePath);
    });
  });
});

function watchDir(dir) {
  const skipNames = ['node_modules', '.git', 'textures', 'sounds'];
  let watcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = String(filename).replace(/\\/g, '/');
      if (skipNames.some((s) => name === s || name.startsWith(`${s}/`) || name.includes(`/${s}/`))) return;
      const ext = path.extname(name).toLowerCase();
      if (!WATCH_EXT.has(ext)) return;
      queueReload(name);
    });
  } catch (err) {
    console.warn('[watch] unavailable:', err.message);
    return;
  }
  watcher.on('error', (err) => console.warn('[watch]', err.message));
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Solar Nemesis — local server');
  console.log(`  → http://127.0.0.1:${PORT}`);
  if (LIVE_RELOAD) {
    watchDir(ROOT);
    console.log('  Live reload: ON (LIVE_RELOAD=1)');
  } else {
    console.log('  Live reload: OFF  (set LIVE_RELOAD=1 to enable)');
  }
  console.log('');
});
