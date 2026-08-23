/* ============================================================
   servercheck.mjs - the two things the hosted server adds:

     1. a global leaderboard that survives a restart
     2. private "play with a friend" rooms joined by code

     node tools/servercheck.mjs
   ============================================================ */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWebSocket } from './wsclient.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8096);
const DATA = path.join(ROOT, 'data-test');
const url = (p) => pathToFileURL(path.join(ROOT, 'src', p)).href;

installWebSocket();
if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
if (!globalThis.document) globalThis.document = { hidden: false, addEventListener() {} };
globalThis.location = { protocol: 'http:', host: `127.0.0.1:${PORT}`, search: '' };
globalThis.STB_CONFIG = { relay: 'auto', leaderboard: 'auto', dev: false };

const { Matchmaker } = await import(url('net/netclient.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const ok = (m) => console.log('  ok    ' + m);
const API = `http://127.0.0.1:${PORT}/api`;

fs.rmSync(DATA, { recursive: true, force: true });

function boot() {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => console.error('  server:', String(d).trim()));
  return p;
}

let server = boot();
await wait(700);

/* ---------------- 1. leaderboard ---------------- */
const post = (body) => fetch(API + '/score', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json().then((j) => ({ status: r.status, ...j })));
const top = () => fetch(API + '/top?limit=25').then((r) => r.json());

await post({ id: 'p_ada', name: 'ADA', score: 240, won: 1, hold: 31.5 });
await post({ id: 'p_bob', name: 'BOB', score: 512, won: 1, hold: 44.0 });
await post({ id: 'p_cy', name: 'CY', score: 90, won: 0, hold: 8.2 });

let rows = (await top()).rows;
if (rows.length !== 3) problems.push(`expected 3 rows, got ${rows.length}`);
if (rows[0]?.name !== 'BOB') problems.push('board is not sorted by score');
else ok(`board sorted: ${rows.map((r) => r.name + ' ' + r.score).join(', ')}`);

// one row per player, best score kept
await post({ id: 'p_ada', name: 'ADA', score: 120, won: 0, hold: 5 });
rows = (await top()).rows;
const ada = rows.filter((r) => r.id === 'p_ada');
if (ada.length !== 1) problems.push('a player got two rows');
else if (ada[0].score !== 240) problems.push(`a worse score overwrote a better one (${ada[0].score})`);
else ok('one row per player; a worse score does not replace a better one');

// implausible scores are refused
const cheat = await post({ id: 'p_hax', name: 'HAX', score: 999999, won: 1, hold: 60 });
if (cheat.ok) problems.push('a 999999 score was accepted');
else ok('an implausible score is refused (' + cheat.why + ')');
const neg = await post({ id: 'p_neg', name: 'NEG', score: -5 });
if (neg.ok) problems.push('a negative score was accepted');

// ...and it survives a restart. Windows cannot trap SIGTERM, so this is a
// hard kill: exactly the crash case the 1s debounced write exists for.
await wait(1400);
server.kill();
await wait(600);
server = boot();
await wait(800);
rows = (await top()).rows;
if (!rows.find((r) => r.id === 'p_bob' && r.score === 512)) problems.push('the board did not survive a restart');
else ok(`board persisted across a restart (${rows.length} rows on disk)`);

/* ---------------- 2. private rooms ---------------- */
function join(name, code) {
  return new Matchmaker().find({
    mode: 'friend', code,
    serverUrl: `ws://127.0.0.1:${PORT}/ws`,
    profile: { id: name, name, level: 1, loadout: {} },
  });
}

{
  const mmHost = new Matchmaker();
  let code = null;
  mmHost.on('roomCode', (c) => { code = c; });
  const hostP = mmHost.find({
    mode: 'friend',
    serverUrl: `ws://127.0.0.1:${PORT}/ws`,
    profile: { id: 'HOSTY', name: 'HOSTY', level: 1, loadout: {} },
  }).catch((e) => ({ err: e }));

  for (let i = 0; i < 40 && !code; i++) await wait(50);
  if (!code) {
    problems.push('the server never issued a room code');
  } else if (!/^[A-Z0-9]{4}$/.test(code)) {
    problems.push('room code looks wrong: ' + code);
  } else {
    ok(`room code issued: ${code}`);
    const friendP = join('FRIENDO', code).catch((e) => ({ err: e }));
    const [A, B] = await Promise.all([hostP, friendP]);
    if (A.err || B.err) problems.push('code join failed: ' + (A.err || B.err).message);
    else {
      if (A.opp.name !== 'FRIENDO' || B.opp.name !== 'HOSTY') {
        problems.push(`friends paired with the wrong people: ${A.opp.name} / ${B.opp.name}`);
      } else if (A.seed !== B.seed) {
        problems.push('friends got different seeds');
      } else if (A.host === B.host) {
        problems.push('friend match elected two hosts');
      } else {
        ok(`code ${code} paired HOSTY with FRIENDO, same seed, one host`);
      }
      A.transport?.close(); B.transport?.close();
    }
  }
}

// a wrong code must fail cleanly, not hang
{
  const bad = await join('LOST', 'ZZZZ').then(() => null, (e) => e);
  if (!bad) problems.push('joining a nonexistent room somehow succeeded');
  else ok('a bad code fails cleanly: "' + bad.message + '"');
}

// a used code cannot be reused
{
  const mm = new Matchmaker();
  let code2 = null;
  mm.on('roomCode', (c) => { code2 = c; });
  const p = mm.find({ mode: 'friend', serverUrl: `ws://127.0.0.1:${PORT}/ws`,
    profile: { id: 'H2', name: 'H2', level: 1, loadout: {} } }).catch((e) => ({ err: e }));
  for (let i = 0; i < 40 && !code2; i++) await wait(50);
  const first = join('F2', code2).catch((e) => ({ err: e }));
  const [h, f] = await Promise.all([p, first]);
  const second = await join('F3', code2).then(() => null, (e) => e);
  if (!second) problems.push('a used room code was accepted twice');
  else ok('a used code cannot be redeemed again');
  h.transport?.close(); f.transport?.close();
}

server.kill();
await wait(200);
fs.rmSync(DATA, { recursive: true, force: true });

if (problems.length) {
  console.error('\n' + problems.map((p) => '  FAIL  ' + p).join('\n'));
  process.exit(1);
}
console.log('\n✅ world leaderboard persists, friend codes pair the right two people');
process.exit(0);
