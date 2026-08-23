/* ============================================================
   playcheck.mjs - "two people press PLAY".

   netcheck.mjs proves the wire. This proves the *button*: it drives
   the same code path main.js runs when PLAY is clicked, twice, and
   asserts that each side ends up facing the other human - never a bot.

     node tools/playcheck.mjs
   ============================================================ */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWebSocket } from './wsclient.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8097);
const url = (p) => pathToFileURL(path.join(ROOT, 'src', p)).href;

installWebSocket();
if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
if (!globalThis.document) globalThis.document = { hidden: false, addEventListener() {} };
// pretend the page is served from the relay host, exactly like a real deploy
globalThis.location = { protocol: 'http:', host: `127.0.0.1:${PORT}`, search: '' };
globalThis.STB_CONFIG = { relay: 'auto', dev: false };

const { relayUrl, onlineEnabled } = await import(url('core/platform.js'));
const { Matchmaker } = await import(url('net/netclient.js'));
const { createSession } = await import(url('game/match.js'));
const { DT } = await import(url('game/sim.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const ok = (m) => console.log('  ok    ' + m);

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
await wait(700);

/* ---- the deploy config the shipped index.html carries ---- */
if (!onlineEnabled()) problems.push('default config has multiplayer switched off');
ok(`PLAY targets ${relayUrl()}`);

/* ---- what main.js does when PLAY is pressed ---- */
function pressPlay(name, skin) {
  const mm = new Matchmaker();
  return mm.find({
    mode: 'online',                       // <- the PLAY button, not PRACTICE
    serverUrl: relayUrl(),
    profile: { id: name, name, level: 3, loadout: { skin, hat: 'cap', face: 'happy', trail: 'dust', emote: 'spin', victory: 'jump', plate: 'plain' } },
  });
}

const pA = pressPlay('AISHER', 'blob').catch((e) => ({ err: e }));
await wait(400);                          // second player arrives a moment later
const pB = pressPlay('REALSTEVE', 'mint').catch((e) => ({ err: e }));
const [A, B] = await Promise.all([pA, pB]);

if (A.err || B.err) {
  problems.push('PLAY failed: ' + (A.err || B.err).message);
} else {
  if (A.bot || B.bot) problems.push('PLAY produced a bot peer');
  if (A.opp.isBot || B.opp.isBot) problems.push('PLAY produced a bot opponent');
  if (A.opp.name !== 'REALSTEVE') problems.push(`AISHER faced "${A.opp.name}"`);
  if (B.opp.name !== 'AISHER') problems.push(`REALSTEVE faced "${B.opp.name}"`);
  ok(`AISHER vs ${A.opp.name}, REALSTEVE vs ${B.opp.name} - both human`);

  // and the sessions PLAY builds must contain no bot either
  const sA = createSession(A, () => ({ x: 0, z: 1, dash: false, taunt: false }));
  const sB = createSession(B, () => ({ x: 0, z: -1, dash: false, taunt: false }));
  if (sA.bot || sB.bot) problems.push('createSession attached a bot to an online match');
  ok(`sessions: ${sA.session.role} + ${sB.session.role}, no bot attached`);

  sA.session.start(); sB.session.start();
  for (let i = 0; i < 200; i++) { sA.session.update(DT * 4); sB.session.update(DT * 4); await wait(8); }
  const t = Math.min(sA.session.sim.tick, sB.session.sim.tick);
  if (t < 100) problems.push('the match did not actually run (tick ' + t + ')');
  ok(`match running, both sims advanced past tick ${t}`);
  sA.session.dispose(); sB.session.dispose();
}

/* ---- a single player must NOT be quietly given a bot ---- */
{
  const mm = new Matchmaker();
  let settled = null;
  mm.find({ mode: 'online', serverUrl: relayUrl(), profile: { id: 'LONE', name: 'LONE', level: 1, loadout: {} } })
    .then((r) => { settled = { matched: r }; }, (e) => { settled = { err: e }; });
  await wait(3000);
  if (settled) problems.push('a lone player was matched with something after 3s: ' + JSON.stringify(Object.keys(settled)));
  else ok('a lone player keeps queueing for a human instead of being handed a bot');
  mm.cancel();
}

await wait(200);
server.kill();

if (problems.length) {
  console.error('\n' + problems.map((p) => '  FAIL  ' + p).join('\n'));
  if (log.trim()) console.error('\n--- server log ---\n' + log.trim());
  process.exit(1);
}
console.log('\n✅ PLAY matches real players');
process.exit(0);
