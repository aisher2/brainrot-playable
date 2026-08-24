/* ============================================================
   server.js - static host + matchmaking relay for
   "Steal the Brainrot".

     node server/server.js            # http://localhost:8080
     PORT=3000 node server/server.js

   Responsibilities:
     * serve the game files
     * pair exactly two REAL players per room, first-come-first-served
     * elect a host, hand both peers the same seed
     * forward peer traffic and nothing else

   It never simulates the game, so it stays cheap: a few hundred
   bytes of state per player and no per-tick work.
   ============================================================ */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { attach } = require('./ws');

const PORT = Number(process.env.PORT || 8080);
/** `--root dist` serves the built bundle instead of the source tree. */
const rootArg = process.argv.indexOf('--root');
const ROOT = rootArg > -1 && process.argv[rootArg + 1]
  ? path.resolve(process.cwd(), process.argv[rootArg + 1])
  : path.resolve(__dirname, '..');
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS || 500);
/* One address should not be able to eat the whole connection budget. Real
   players behind one NAT still get plenty; a script opening sockets in a
   loop hits the wall immediately. */
const MAX_PER_IP = Number(process.env.MAX_PER_IP || 8);
const MSG_PER_SEC = 140;             // generous: 60Hz input + 20Hz snapshots
const IDLE_MS = 45000;

/* ---- global leaderboard ---- */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const BOARD_KEEP = 200;              // rows retained on disk
const BOARD_MAX_SCORE = 2000;        // a 60s round cannot plausibly beat this
const SUBMITS_PER_HOUR = 40;         // per IP

/* ---- private rooms ("play with a friend") ---- */
const VARIANTS = new Set(['classic', 'tagbomb']);
const pickVariant = (v) => (VARIANTS.has(v) ? v : 'classic');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no O/0/I/1
const ROOM_TTL_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------
   static files
   ------------------------------------------------------------ */
/** text formats worth compressing; images and fonts are already packed */
const GZIP_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map', '.ico']);
const gzipCache = new Map();

/* ------------------------------------------------------------
   security headers

   The game is meant to be embeddable (YouTube Playables runs it in an
   iframe), so framing stays open on purpose - locking it down would break
   the platform it was built for. Everything else is closed:

   - script/style are same-origin, plus the inline config block and the
     Playables SDK when that build is used
   - connect-src has to allow arbitrary ws/wss/https because the relay and
     leaderboard can be configured to live on another host
   - object/base/form are switched off outright; the game uses none of them
   ------------------------------------------------------------ */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.youtube.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors *",
].join('; ');

const PERMISSIONS = [
  'accelerometer=()', 'camera=()', 'geolocation=()', 'gyroscope=()',
  'magnetometer=()', 'microphone=()', 'payment=()', 'usb=()',
  'interest-cohort=()',
].join(', ');

/** Applied to every response, static or API. */
function securityHeaders(req) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
    'permissions-policy': PERMISSIONS,
    'cross-origin-resource-policy': 'cross-origin',
  };
  // Only meaningful once the connection is already HTTPS; behind a proxy that
  // is what x-forwarded-proto tells us.
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto === 'https') h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/* ============================================================
   Global leaderboard - one small JSON file, no database.

   Scores arrive from the client, so this is a scoreboard, not an
   anti-cheat system: it clamps implausible values, keeps one row per
   player, and rate-limits submissions. Anyone determined can still
   forge a score; making that impossible needs a server that runs the
   simulation itself (see game/sim.js - it is written to allow that).
   ============================================================ */
let board = [];          // [{ id, name, score, won, hold, t }]
let boardDirty = false;

function loadBoard() {
  try {
    board = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    if (!Array.isArray(board)) board = [];
  } catch (_) { board = []; }
}

let saveTimer = null;

/**
 * Persist within a second of any change. The file is tiny (<=200 rows) so the
 * cost is nothing, and it means a crash or a hard kill from the host loses at
 * most one second of scores instead of up to ten.
 */
function scheduleSave() {
  boardDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveBoard(); }, 1000);
  saveTimer.unref?.();
}

function saveBoard() {
  if (!boardDirty) return;
  boardDirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = BOARD_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(board));
    fs.renameSync(tmp, BOARD_FILE);      // atomic-ish: never a half-written file
  } catch (e) {
    console.error('leaderboard save failed:', e.message);
  }
}

function submitScore(entry, ip) {
  const score = Math.round(Number(entry.score));
  if (!Number.isFinite(score) || score < 0 || score > BOARD_MAX_SCORE) return { ok: false, why: 'bad score' };

  const id = String(entry.id || '').slice(0, 32).replace(/[^\w-]/g, '');
  if (!id) return { ok: false, why: 'bad id' };
  const name = sanitizeProfile({ name: entry.name }).name;
  const hold = Math.max(0, Math.min(60, Number(entry.hold) || 0));

  const prev = board.find((r) => r.id === id);
  if (prev) {
    prev.name = name;
    prev.games = (prev.games || 1) + 1;
    prev.wins = (prev.wins || 0) + (entry.won ? 1 : 0);
    if (score > prev.score) { prev.score = score; prev.hold = hold; prev.t = Date.now(); }
  } else {
    board.push({ id, name, score, hold, t: Date.now(), games: 1, wins: entry.won ? 1 : 0 });
  }
  board.sort((a, b) => b.score - a.score);
  if (board.length > BOARD_KEEP) board.length = BOARD_KEEP;
  scheduleSave();
  const rank = board.findIndex((r) => r.id === id) + 1;
  return { ok: true, rank, best: board.find((r) => r.id === id).score };
}

const submitHits = new Map();          // ip -> [timestamps]
function submitAllowed(ip) {
  const now = Date.now();
  const hits = (submitHits.get(ip) || []).filter((t) => now - t < 3600000);
  if (hits.length >= SUBMITS_PER_HOUR) { submitHits.set(ip, hits); return false; }
  hits.push(now);
  submitHits.set(ip, hits);
  return true;
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

function safeJoin(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/\\/g, '/');
  const p = path.normalize(path.join(root, clean));
  if (!p.startsWith(root)) return null;      // no directory traversal
  return p;
}

/** `node server/server.js --dev` also accepts screenshots from the page,
 *  which is how the game gets verified without a visible browser window. */
const DEV = process.argv.includes('--dev');
const SHOT_DIR = path.join(__dirname, '..', 'tools', 'shots');

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (DEV && req.method === 'POST' && url === '/_devshot') {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 12 * 1024 * 1024) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const name = String(body.name || 'shot').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'shot';
        const url = String(body.data || '');
        const ext = /^data:image\/(\w+);/.exec(url)?.[1]?.replace('jpeg', 'jpg') || 'png';
        const data = url.replace(/^data:image\/\w+;base64,/, '');
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        const file = path.join(SHOT_DIR, name + '.' + ext);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file }));
        log('shot ->', path.relative(ROOT, file));
      } catch (e) {
        res.writeHead(400); res.end('bad shot');
      }
    });
    return;
  }

  /* ---- leaderboard API ----
     The game is often served from somewhere else (GitHub Pages, Netlify) while
     this process only runs the relay and the board, so /api has to be reachable
     cross-origin. Only the read and submit routes are opened up; nothing here
     is authenticated or carries cookies, so `*` is the right allowance. */
  if (url.startsWith('/api/')) {
    for (const [k, v] of Object.entries(securityHeaders(req))) res.setHeader(k, v);
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('vary', 'origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }
  }

  if (url === '/api/top' && req.method === 'GET') {
    const limit = Math.max(1, Math.min(50, Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 25));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      rows: board.slice(0, limit).map((r) => ({
        id: r.id, name: r.name, score: r.score, hold: r.hold, wins: r.wins || 0,
      })),
    }));
    return;
  }
  if (url === '/api/score' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!submitAllowed(ip)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, why: 'slow down' }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 4096) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      let out;
      try { out = submitScore(JSON.parse(Buffer.concat(chunks).toString('utf8')), ip); }
      catch (_) { out = { ok: false, why: 'bad json' }; }
      res.writeHead(out.ok ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, queued: queue.length,
      rooms: rooms.size, privateRooms: privateRooms.size, boardSize: board.length }));
    return;
  }

  let file = safeJoin(ROOT, url === '/' ? '/index.html' : url);
  if (!file) { res.writeHead(403); res.end('nope'); return; }

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404'); return; }
      const ext = path.extname(file).toLowerCase();

      /* Compress text assets. The bundle is ~370 kB raw and ~108 kB gzipped,
         which is the difference between a snappy and a sluggish first load on
         a phone. A CDN in front may already do this; when nothing does, this
         is the only thing that will. Results are cached, so each file is
         compressed once per process rather than per request. */
      const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      let body = data;
      let encoding = null;
      if (wantsGzip && GZIP_EXT.has(ext) && data.length > 1024) {
        const key = file + ':' + (st ? st.mtimeMs : 0) + ':' + data.length;
        let hit = gzipCache.get(key);
        if (!hit) {
          hit = zlib.gzipSync(data, { level: 6 });
          if (gzipCache.size > 64) gzipCache.clear();
          gzipCache.set(key, hit);
        }
        // never ship a "compressed" copy that is bigger than the original
        if (hit.length < data.length) { body = hit; encoding = 'gzip'; }
      }

      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        ...(encoding ? { 'content-encoding': encoding, vary: 'accept-encoding' } : {}),
        'content-length': body.length,
        // dev never caches (so edits show up); production caches assets for an
        // hour and always revalidates the HTML that points at them.
        'cache-control': DEV
          ? 'no-store, no-cache, must-revalidate'
          : (ext === '.html' ? 'public, max-age=0, must-revalidate' : 'public, max-age=3600'),
        ...securityHeaders(req),
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    });
  });
});

/* ------------------------------------------------------------
   matchmaking
   ------------------------------------------------------------ */
let nextId = 1;
const clients = new Map();     // id -> client
const queue = [];              // ids waiting for an opponent
const rooms = new Map();       // roomId -> {a, b}

function send(c, obj) {
  if (!c || !c.conn.open) return;
  try { c.conn.send(JSON.stringify(obj)); } catch (_) {}
}

/**
 * Names land on other people's screens, so they are reduced to a charset
 * that cannot mean anything to a parser: A-Z, 0-9, underscore. It matches
 * what the name screen already lets you type, and it means a hostile name
 * carries no markup even if a future renderer forgets to escape it.
 */
function safeName(v) {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 12) || 'BRAINROT';
}

function sanitizeProfile(p) {
  if (!p || typeof p !== 'object') return { name: 'BRAINROT', level: 1, loadout: null };
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const lo = p.loadout && typeof p.loadout === 'object' ? p.loadout : {};
  const out = {};
  for (const k of ['skin', 'hat', 'face', 'trail', 'emote', 'victory', 'plate']) {
    if (typeof lo[k] === 'string' && lo[k].length < 24) out[k] = lo[k];
  }
  return {
    name: safeName(p.name),
    level: Math.max(1, Math.min(999, Number(p.level) || 1)),
    loadout: out,
  };
}

function dequeue(id) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
}

/* ============================================================
   Private rooms: one player creates a code, a friend types it in.
   Same pairing path as public matchmaking once both are present.
   ============================================================ */
const privateRooms = new Map();        // CODE -> { hostId, created }

function makeCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!privateRooms.has(c)) return c;
  }
  return null;
}

function pair(a, b, reason) {
  const roomId = crypto.randomBytes(6).toString('hex');
  const seed = crypto.randomBytes(4).readUInt32BE(0) || 1;
  const aHost = crypto.randomBytes(1)[0] < 128;
  a.room = roomId; a.peer = b.id; a.queued = false;
  b.room = roomId; b.peer = a.id; b.queued = false;
  rooms.set(roomId, { a: a.id, b: b.id, started: Date.now() });
  const variant = a.variant || b.variant || 'classic';
  send(a, { t: 'match', room: roomId, seed, idx: aHost ? 0 : 1, host: aHost, opp: b.profile, variant, v: 1 });
  send(b, { t: 'match', room: roomId, seed, idx: aHost ? 1 : 0, host: !aHost, opp: a.profile, variant, v: 1 });
  log(`match ${roomId} (${reason}): ${a.profile.name} vs ${b.profile.name}`);
}

function dropPrivateRoom(id) {
  for (const [code, r] of privateRooms) if (r.hostId === id) privateRooms.delete(code);
}

/** Only ever pair two people who chose the same mode. */
function tryMatch() {
  let paired = true;
  while (paired) {
    paired = false;
    for (let i = 0; i < queue.length; i++) {
      const a = clients.get(queue[i]);
      if (!a || !a.conn.open) { queue.splice(i, 1); i--; continue; }
      for (let j = i + 1; j < queue.length; j++) {
        const b = clients.get(queue[j]);
        if (!b || !b.conn.open) { queue.splice(j, 1); j--; continue; }
        if ((a.variant || 'classic') !== (b.variant || 'classic')) continue;
        queue.splice(j, 1);
        queue.splice(i, 1);
        pair(a, b, 'public ' + (a.variant || 'classic'));
        paired = true;
        break;
      }
      if (paired) break;
    }
  }
  // keep everyone still waiting informed
  queue.forEach((id, i) => send(clients.get(id), { t: 'queued', n: i + 1 }));
}

function leaveRoom(c, notify = true) {
  if (!c.room) return;
  const room = rooms.get(c.room);
  rooms.delete(c.room);
  const peer = clients.get(c.peer);
  if (peer && notify) {
    send(peer, { t: 'gone' });
    peer.room = null;
    peer.peer = null;
  }
  c.room = null;
  c.peer = null;
  if (room) log(`room ${room.a}/${room.b} closed`);
}

attach(server, '/ws', (conn) => {
  if (clients.size >= MAX_CLIENTS) {
    try { conn.send(JSON.stringify({ t: 'err', m: 'server full' })); } catch (_) {}
    conn.close(1013);
    return;
  }
  let sameIp = 0;
  for (const other of clients.values()) if (other.conn.ip === conn.ip) sameIp++;
  if (sameIp >= MAX_PER_IP) {
    try { conn.send(JSON.stringify({ t: 'err', m: 'too many connections' })); } catch (_) {}
    conn.close(1013);
    log('rejected', conn.ip, '- ' + sameIp + ' connections already');
    return;
  }
  const id = nextId++;
  const c = {
    id, conn, room: null, peer: null, queued: false, variant: 'classic',
    profile: sanitizeProfile(null),
    msgs: 0, window: Date.now(), last: Date.now(),
  };
  clients.set(id, c);
  send(c, { t: 'welcome', id, v: 1 });

  conn.on('message', (raw) => {
    c.last = Date.now();
    // rate limit
    const now = Date.now();
    if (now - c.window > 1000) { c.window = now; c.msgs = 0; }
    if (++c.msgs > MSG_PER_SEC) return;
    if (raw.length > 64 * 1024) return;

    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'hello':
        c.profile = sanitizeProfile(m.profile);
        break;
      case 'queue':
        c.variant = pickVariant(m.variant);
        if (c.room) leaveRoom(c);
        if (!c.queued) { c.queued = true; queue.push(id); }
        send(c, { t: 'queued', n: queue.indexOf(id) + 1 });
        tryMatch();
        break;
      case 'cancel':
        c.queued = false;
        dequeue(id);
        dropPrivateRoom(id);
        break;

      case 'mkroom': {
        if (c.room) leaveRoom(c);
        dequeue(id); c.queued = false;
        dropPrivateRoom(id);
        c.variant = pickVariant(m.variant);
        const code = makeCode();
        if (!code) { send(c, { t: 'err', m: 'could not create a room' }); break; }
        privateRooms.set(code, { hostId: id, created: Date.now(), variant: c.variant });
        send(c, { t: 'room', code });
        log(`room ${code} opened by ${c.profile.name}`);
        break;
      }

      case 'joinroom': {
        /* Four characters is roughly 923k combinations - walkable by a script
           in hours. A few misses per connection makes that pointless without
           inconveniencing anyone typing a code by hand. */
        c.badJoins = c.badJoins || 0;
        if (c.badJoins >= 8) { send(c, { t: 'err', m: 'too many bad codes', code: 'noroom' }); break; }
        const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        const room = privateRooms.get(code);
        if (!room) { c.badJoins++; send(c, { t: 'err', m: 'No room with that code.', code: 'noroom' }); break; }
        const hostC = clients.get(room.hostId);
        if (!hostC || !hostC.conn.open) {
          privateRooms.delete(code);
          send(c, { t: 'err', m: 'That room has closed.', code: 'noroom' });
          break;
        }
        if (hostC.id === id) { send(c, { t: 'err', m: 'That is your own code.', code: 'self' }); break; }
        privateRooms.delete(code);
        if (c.room) leaveRoom(c);
        dequeue(id); c.queued = false;
        c.variant = room.variant || 'classic';   // the host picked the mode
        pair(hostC, c, 'friends ' + code);
        break;
      }
      case 'rly': {
        const peer = clients.get(c.peer);
        if (peer && peer.room === c.room && c.room) send(peer, { t: 'rly', d: m.d });
        break;
      }
      case 'ping':
        send(c, { t: 'pong', s: m.s });
        break;
      case 'bye':
        leaveRoom(c);
        c.queued = false;
        dequeue(id);
        dropPrivateRoom(id);
        break;
      default: break;
    }
  });

  conn.on('close', () => {
    dequeue(id);
    dropPrivateRoom(id);
    leaveRoom(c);
    clients.delete(id);
  });
});

/* flush the board and expire stale room codes */
setInterval(() => {
  saveBoard();
  const now = Date.now();
  for (const [code, r] of privateRooms) {
    if (now - r.created > ROOM_TTL_MS) privateRooms.delete(code);
  }
}, 10000).unref?.();

/* keep-alive + reaper */
setInterval(() => {
  const now = Date.now();
  for (const c of [...clients.values()]) {
    if (!c.conn.open) { dequeue(c.id); leaveRoom(c); clients.delete(c.id); continue; }
    if (now - c.last > IDLE_MS && !c.room) { c.conn.close(1001); continue; }
    if (!c.conn.isAlive) { c.conn.destroy(); continue; }
    c.conn.ping();
  }
}, 15000).unref?.();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

loadBoard();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveBoard(); process.exit(0); });
}

server.listen(PORT, () => {
  console.log(`
  🧠  STEAL THE BRAINROT
      root   ->  ${path.relative(process.cwd(), ROOT) || '.'}
      game   ->  http://localhost:${PORT}/
      relay  ->  ws://localhost:${PORT}/ws
      health ->  http://localhost:${PORT}/health
      board  ->  http://localhost:${PORT}/api/top   (${board.length} entries)

      Open two tabs and press PLAY in both to test real matchmaking.
`);
});

process.on('exit', saveBoard);
