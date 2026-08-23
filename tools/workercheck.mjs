/* ============================================================
   workercheck.mjs - the Cloudflare Worker build of the relay.

   Run the Worker locally first, in another terminal:
     npx wrangler dev --port 8787 --local
   then:
     node tools/workercheck.mjs

   Same assertions as servercheck/friendcheck, aimed at the Worker so
   the two implementations are held to one standard. Uses the strict
   WebSocket client - workerd speaks real WebSockets, so the handshake
   must validate.
   ============================================================ */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWebSocket } from './wsclient.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.WORKER_PORT || 8787);
const HOST = `127.0.0.1:${PORT}`;
const WS = `ws://${HOST}/ws`;
const HTTP = `http://${HOST}`;
const url = (p) => pathToFileURL(path.join(ROOT, 'src', p)).href;

installWebSocket();
if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
if (!globalThis.document) globalThis.document = { hidden: false, addEventListener() {} };
globalThis.location = { protocol: 'http:', host: HOST, search: '' };
globalThis.STB_CONFIG = { relay: 'auto', leaderboard: 'auto', dev: false };

const { Matchmaker } = await import(url('net/netclient.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const ok = (m) => console.log('  ok    ' + m);
const prof = (n) => ({ id: n, name: n, level: 1, loadout: {} });

/* ---- 1. the Worker serves the game ---- */
{
  const res = await fetch(HTTP + '/');
  const html = await res.text();
  if (!res.ok) problems.push('the Worker did not serve index.html');
  else if (!/STB_CONFIG/.test(html)) problems.push('served page has no config block');
  else ok(`serves the game (${html.length} bytes of index.html)`);

  const h = await (await fetch(HTTP + '/health')).json();
  if (!h.ok) problems.push('health endpoint is unhappy');
  else ok('health endpoint answers from the Durable Object');
}

/* ---- 2. two strangers press PLAY ---- */
{
  const t0 = Date.now();
  const [A, B] = await Promise.all([
    new Matchmaker().find({ mode: 'online', serverUrl: WS, profile: prof('RANDO1') }),
    new Matchmaker().find({ mode: 'online', serverUrl: WS, profile: prof('RANDO2') }),
  ]);
  if (A.opp.name !== 'RANDO2' || B.opp.name !== 'RANDO1') problems.push('randoms paired wrong');
  else if (A.seed !== B.seed) problems.push('randoms got different seeds');
  else if (A.host === B.host) problems.push('two hosts elected');
  else if (A.opp.isBot || B.opp.isBot) problems.push('a bot was substituted for a real player');
  else ok(`two randoms matched in ${Date.now() - t0}ms (seed ${A.seed}, one host)`);
  A.transport?.close(); B.transport?.close();
}

/* ---- 3. friends pair by code ---- */
{
  const mm = new Matchmaker();
  let code = null;
  mm.on('roomCode', (c) => { code = c; });
  const host = mm.find({ mode: 'friend', serverUrl: WS, profile: prof('ME') }).catch((e) => ({ err: e }));
  for (let i = 0; i < 100 && !code; i++) await wait(50);
  if (!code) problems.push('no room code was issued');
  else if (!/^[A-Z0-9]{4}$/.test(code)) problems.push('room code looks wrong: ' + code);
  else {
    const friend = new Matchmaker()
      .find({ mode: 'friend', code, serverUrl: WS, profile: prof('MATE') })
      .catch((e) => ({ err: e }));
    const [A, B] = await Promise.all([host, friend]);
    if (A.err || B.err) problems.push('friend pairing failed: ' + (A.err || B.err).message);
    else if (A.opp.name !== 'MATE' || B.opp.name !== 'ME') problems.push('friend code paired the wrong people');
    else if (A.seed !== B.seed) problems.push('friends got different seeds');
    else ok(`friend code ${code} paired ME with MATE`);
    A.transport?.close(); B.transport?.close();
  }
}

/* ---- 4. a bad code fails cleanly ---- */
{
  const bad = await new Matchmaker()
    .find({ mode: 'friend', code: 'ZZZZ', serverUrl: WS, profile: prof('LOST') })
    .then(() => null, (e) => e);
  if (!bad) problems.push('joining a nonexistent room somehow succeeded');
  else ok(`a bad code fails cleanly: "${bad.message}"`);
}

/* ---- 5. the world leaderboard, in Durable Object SQLite ---- */
{
  const post = (b) => fetch(HTTP + '/api/score', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  }).then((r) => r.json());

  await post({ id: 'w_ada', name: 'ADA', score: 240, won: 1, hold: 31 });
  await post({ id: 'w_bob', name: 'BOB', score: 512, won: 1, hold: 44 });
  await post({ id: 'w_ada', name: 'ADA', score: 120, won: 0, hold: 5 });     // worse, must not win
  const cheat = await post({ id: 'w_hax', name: 'HAX', score: 999999, won: 1, hold: 60 });

  const { rows } = await (await fetch(HTTP + '/api/top?limit=10')).json();
  const ada = rows.filter((r) => r.id === 'w_ada');
  if (rows[0]?.name !== 'BOB') problems.push('board is not sorted by score');
  else if (ada.length !== 1) problems.push('a player got two rows');
  else if (ada[0].score !== 240) problems.push(`a worse score overwrote a better one (${ada[0].score})`);
  else if (cheat.ok) problems.push('an implausible score was accepted');
  else ok(`leaderboard: ${rows.map((r) => r.name + ' ' + r.score).join(', ')}; cheat refused (${cheat.why})`);

  const cors = (await fetch(HTTP + '/api/top?limit=1')).headers.get('access-control-allow-origin');
  if (cors !== '*') problems.push('leaderboard is not readable cross-origin (got ' + cors + ')');
  else ok('leaderboard is readable cross-origin, so a Pages build can use it');
}

if (problems.length) {
  console.error('\n' + problems.map((p) => '  FAIL  ' + p).join('\n'));
  process.exit(1);
}
console.log('\n✅ Worker relay: randoms match, friend codes pair, world board persists');
process.exit(0);
