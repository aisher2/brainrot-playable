/* ============================================================
   server.js - a static file host, and nothing else.

   This used to be the matchmaking relay: a WebSocket upgrade path,
   public and private rooms, pairing, a score API backed by a JSON
   file on disk. All of it is gone, along with server/ws.js, because
   the game no longer has a networked mode to serve and a Playables
   build is not permitted to call out anyway.

   What remains exists only so you can look at the built game
   locally:

     node server/server.js --root dist

   It serves files. It has no API, no sockets, and no state.
   ============================================================ */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
};

const PORT = Number(process.env.PORT || flag('port', 8080));
/* Anchor to the project, not to wherever the process happened to start:
   the launcher may run this from another directory entirely. */
const BASE = path.resolve(__dirname, '..');
const ROOT = path.resolve(BASE, flag('root', 'dist'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const TEXTUAL = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);

/* The game is one page of markup, one script and one stylesheet, so the
   headers matter more than any caching cleverness: index.html must always be
   revalidated, and the two assets it names are content-stamped by the build,
   which is what makes a long max-age safe on them. */
/* The exact Content-Security-Policy YouTube serves Playables under, copied
   from the Playables SDK Test Suite guide. Their advice is to override the
   header locally so violations surface during development rather than during
   certification, so `--csp` does that here:

     node server/server.js --root dist --csp

   Note what it permits: 'unsafe-inline' for both script-src and style-src, so
   an inlined stylesheet is fine, and connect-src is limited to 'self', which
   an offline build satisfies by having nothing to connect to. */
const YT_CSP = [
  "default-src 'none'",
  "script-src 'report-sample' 'self' 'unsafe-eval' 'unsafe-inline' blob:"
    + ' https://www.youtube.com/game_api/v0 https://www.youtube.com/game_api/v0/'
    + ' https://www.youtube.com/game_api/v1 https://www.youtube.com/game_api/v1/',
  "object-src 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self' data: https://fonts.googleapis.com https://fonts.gstatic.com",
  "connect-src 'self' blob: data:",
  'sandbox allow-pointer-lock allow-same-origin allow-scripts',
  "base-uri 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
].join('; ');
const USE_CSP = argv.includes('--csp');

/* --mock swaps the real SDK script for tools/ytgame-mock.js.

   The real SDK is a no-op outside YouTube, so ads, pause/resume, the audio
   callback and cloud save never run during development - they ship untested.
   The mock implements the documented API and adds buttons for the events the
   host would send.

   It is served from tools/, never copied into dist/, and only when this flag
   is passed, so there is no path by which a deploy picks it up. */
const USE_MOCK = argv.includes('--mock');
const SDK_TAG = '<script src="https://www.youtube.com/game_api/v1"></script>';
const MOCK_TAG = '<script src="/__ytgame-mock.js"></script>';

function headersFor(ext, isIndex) {
  const h = { 'content-type': TYPES[ext] || 'application/octet-stream' };
  h['cache-control'] = isIndex
    ? 'public, max-age=0, must-revalidate'
    : 'public, max-age=3600';
  h['x-content-type-options'] = 'nosniff';
  h['referrer-policy'] = 'no-referrer';
  if (USE_CSP && isIndex) h['content-security-policy'] = YT_CSP;
  return h;
}

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url.endsWith('/')) url += 'index.html';

  // the mock lives outside the served root on purpose
  if (USE_MOCK && url === '/__ytgame-mock.js') {
    const p = path.join(BASE, 'tools', 'ytgame-mock.js');
    fs.readFile(p, (e, b) => {
      if (e) { res.writeHead(404).end('mock missing'); return; }
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }).end(b);
    });
    return;
  }

  // never let a path escape the served directory
  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf0) => {
    let buf = buf0;
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const isIndex = url.endsWith('index.html');
    const head = headersFor(ext, isIndex);

    /* Substitute rather than append: two SDKs on one page would race, and the
       mock refuses to install if a real ytgame already exists. */
    if (USE_MOCK && isIndex) {
      const html = buf.toString('utf8');
      if (!html.includes(SDK_TAG)) {
        console.warn('--mock: could not find the SDK tag to replace');
      } else {
        buf = Buffer.from(html.replace(SDK_TAG, MOCK_TAG), 'utf8');
      }
    }

    const accepts = String(req.headers['accept-encoding'] || '').includes('gzip');
    if (accepts && TEXTUAL.has(ext) && buf.length > 1024) {
      const gz = zlib.gzipSync(buf, { level: 6 });
      head['content-encoding'] = 'gzip';
      head['content-length'] = gz.length;
      res.writeHead(200, head).end(gz);
      return;
    }
    head['content-length'] = buf.length;
    res.writeHead(200, head).end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
});
