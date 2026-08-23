/* ============================================================
   friendcheck.mjs - CREATE A ROOM the way the app actually does it.

   servercheck.mjs proves the protocol with a fresh Matchmaker per
   call. main.js does something different: one long-lived app.mm,
   cancel() before every attempt, and the 'roomCode' listener
   attached from outside. This exercises that exact sequence,
   including backing out and trying again.

     node tools/friendcheck.mjs
   ============================================================ */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWebSocket } from './wsclient.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8097);
const DATA = path.join(ROOT, 'data-friend-test');
const url = (p) => pathToFileURL(path.join(ROOT, 'src', p)).href;

installWebSocket();
if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
if (!globalThis.document) globalThis.document = { hidden: false, addEventListener() {} };
globalThis.location = { protocol: 'http:', host: `127.0.0.1:${PORT}`, search: '' };
globalThis.STB_CONFIG = { relay: 'auto', leaderboard: 'auto', dev: false };

const { Matchmaker, CancelError } = await import(url('net/netclient.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const ok = (m) => console.log('  ok    ' + m);
const SERVER = `ws://127.0.0.1:${PORT}/ws`;

fs.rmSync(DATA, { recursive: true, force: true });
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => console.error('  server:', String(d).trim()));
await wait(700);

const profile = (name) => ({ id: name, name, level: 1, loadout: {} });

/* This is main.js's ui.on('makeRoom') handler, verbatim in shape:
   cancel, subscribe, find, unsubscribe. */
function makeRoom(mm) {
  mm.cancel();
  let code = null;
  const off = mm.on('roomCode', (c) => { code = c; });
  const done = mm
    .find({ mode: 'friend', serverUrl: SERVER, profile: profile('HOST') })
    .catch((e) => ({ err: e }))
    .finally(() => off());
  return { done, code: () => code };
}

function joinRoom(mm, code, name) {
  mm.cancel();
  return mm
    .find({ mode: 'friend', code, serverUrl: SERVER, profile: profile(name) })
    .catch((e) => ({ err: e }));
}

/* ---- 1. the very first CREATE A ROOM on a fresh singleton ---- */
const host = new Matchmaker();       // this is app.mm; it lives for the session
{
  const r = makeRoom(host);
  for (let i = 0; i < 40 && !r.code(); i++) await wait(50);
  if (!r.code()) problems.push('first CREATE A ROOM never produced a code');
  else ok(`first CREATE A ROOM issued ${r.code()}`);

  if (r.code()) {
    const friend = new Matchmaker();
    const [A, B] = await Promise.all([r.done, joinRoom(friend, r.code(), 'FRIEND')]);
    if (A.err || B.err) problems.push('first room failed to pair: ' + (A.err || B.err).message);
    else if (A.opp.name !== 'FRIEND' || B.opp.name !== 'HOST') problems.push('first room paired the wrong people');
    else if (A.seed !== B.seed) problems.push('first room: different seeds');
    else if (A.host === B.host) problems.push('first room: two hosts');
    else ok('first room paired HOST with FRIEND correctly');
    A.transport?.close(); B.transport?.close();
  }
}

/* ---- 2. back out, then CREATE A ROOM again on the SAME instance ---- */
{
  const r1 = makeRoom(host);
  for (let i = 0; i < 40 && !r1.code(); i++) await wait(50);
  const firstCode = r1.code();
  host.cancel();                       // the player taps BACK
  const c1 = await r1.done;
  if (!(c1?.err instanceof CancelError)) problems.push('backing out of a room did not cancel cleanly');
  else ok('backing out of a room cancels cleanly');

  await wait(150);
  const r2 = makeRoom(host);           // ...and immediately tries again
  for (let i = 0; i < 40 && !r2.code(); i++) await wait(50);
  if (!r2.code()) {
    problems.push('CREATE A ROOM produced no code on a reused Matchmaker (second attempt)');
  } else {
    ok(`second CREATE A ROOM on the same instance issued ${r2.code()}`);
    if (r2.code() === firstCode) problems.push('the retry reused the abandoned code');
    const friend = new Matchmaker();
    const [A, B] = await Promise.all([r2.done, joinRoom(friend, r2.code(), 'PAL')]);
    if (A.err || B.err) problems.push('retry room failed to pair: ' + (A.err || B.err).message);
    else if (A.opp.name !== 'PAL') problems.push('retry room paired the wrong person');
    else ok('the retry room still pairs correctly');
    A.transport?.close(); B.transport?.close();
  }
}

/* ---- 3. the host's own JOIN works on that same reused instance ---- */
{
  const other = new Matchmaker();
  const r = makeRoom(other);
  for (let i = 0; i < 40 && !r.code(); i++) await wait(50);
  const [A, B] = await Promise.all([r.done, joinRoom(host, r.code(), 'HOSTJOINS')]);
  if (A.err || B.err) problems.push('a reused instance could not JOIN: ' + (A.err || B.err).message);
  else ok('a reused instance can JOIN someone else’s code');
  A.transport?.close(); B.transport?.close();
}

/* ---- 4. an unreachable relay must REJECT, not hang ----
   main.js relies on this: startMatch rethrows friend-mode failures so the
   friend screen can show them. If find() ever resolved or hung instead,
   CREATE A ROOM would silently do nothing again. */
{
  const mm = new Matchmaker();
  const t0 = Date.now();
  const res = await mm.find({
    mode: 'friend', serverUrl: 'ws://127.0.0.1:59999/ws', profile: profile('LONELY'),
  }).then(() => 'resolved', (e) => e);
  const ms = Date.now() - t0;
  if (res === 'resolved') problems.push('an unreachable relay resolved instead of rejecting');
  else if (!(res instanceof Error)) problems.push('an unreachable relay rejected with a non-Error');
  else if (ms > 12000) problems.push(`an unreachable relay took ${ms}ms to give up`);
  else if (!mm.lastError) problems.push('no lastError set for the friend screen to display');
  else ok(`an unreachable relay fails in ${ms}ms: "${mm.lastError}"`);
}

server.kill();
await wait(200);
fs.rmSync(DATA, { recursive: true, force: true });

if (problems.length) {
  console.error('\n' + problems.map((p) => '  FAIL  ' + p).join('\n'));
  process.exit(1);
}
console.log('\n✅ CREATE A ROOM works the way main.js drives it, including retries');
process.exit(0);
