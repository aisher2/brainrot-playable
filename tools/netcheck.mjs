/* ============================================================
   netcheck.mjs - end-to-end multiplayer test.

   Boots the real relay, connects TWO real clients over real
   WebSockets, lets the server pair them, then runs a full 60-second
   round with the production HostSession / ClientSession - including
   snapshot streaming, input relay and client-side rollback.

     node tools/netcheck.mjs

   Both peers are driven by the practice AI so the round is actually
   contested; the point of the test is the wire, not the players.
   ============================================================ */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8099);
const SPEED = Number(process.env.SPEED || 5);      // wall-clock acceleration (<= MAX_CATCHUP)
const url = (p) => pathToFileURL(path.join(ROOT, 'src', p)).href;

import { installWebSocket } from './wsclient.mjs';
installWebSocket();
if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
if (!globalThis.document) globalThis.document = { hidden: false, addEventListener() {} };

const { Matchmaker } = await import(url('net/netclient.js'));
const { HostSession, ClientSession } = await import(url('game/match.js'));
const { BotAI } = await import(url('net/bot.js'));
const { DT } = await import(url('game/sim.js'));
const { setArena, mapForSeed, currentMap } = await import(url('game/arena.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- boot the relay ---------- */
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const die = (msg) => {
  console.error('\n  FAIL  ' + msg);
  if (serverLog.trim()) console.error('\n--- server log ---\n' + serverLog.trim());
  server.kill();
  process.exit(1);
};

await wait(600);

const WS = `ws://127.0.0.1:${PORT}/ws`;
console.log(`  relay  ${WS}`);

/* ---------- two players walk into a queue ---------- */
async function joinQueue(name, skin) {
  const mm = new Matchmaker();
  return mm.find({
    mode: 'online',
    serverUrl: WS,
    profile: { id: name, name, level: 4, loadout: { skin, hat: 'cap', face: 'happy', trail: 'dust', emote: 'spin', victory: 'jump', plate: 'plain' } },
  });
}

let infoA, infoB;
{
  const pA = joinQueue('ALPHA', 'blob').catch((e) => ({ err: e }));
  await wait(220);                                   // stagger, like real players
  const pB = joinQueue('BETA', 'mint').catch((e) => ({ err: e }));
  [infoA, infoB] = await Promise.all([pA, pB]);
  if (infoA.err) die('ALPHA could not queue: ' + infoA.err.message);
  if (infoB.err) die('BETA could not queue: ' + infoB.err.message);
}

if (infoA.seed !== infoB.seed) die(`seed mismatch ${infoA.seed} vs ${infoB.seed}`);
if (infoA.idx === infoB.idx) die('both players got the same slot index');
if (infoA.host === infoB.host) die('host election produced two ' + (infoA.host ? 'hosts' : 'clients'));
if (infoA.opp.name !== 'BETA' || infoB.opp.name !== 'ALPHA') {
  die(`opponent profiles crossed: A sees ${infoA.opp.name}, B sees ${infoB.opp.name}`);
}
// PLAY must pair two humans. A bot on this path would be a serious bug.
if (infoA.bot || infoB.bot) die('an online match was handed a bot peer');
if (infoA.opp.isBot || infoB.opp.isBot) die('an online opponent is flagged as a bot');
if (infoA.mode !== 'online' || infoB.mode !== 'online') die('match did not run in online mode');
console.log(`  real   both peers are human: ALPHA sees "${infoA.opp.name}", BETA sees "${infoB.opp.name}", no bot involved`);
// Both clients derive the arena from the shared seed, exactly as main.js
// does. This is what makes the round below a real test of map determinism:
// a layout mismatch would show up immediately as rollback divergence.
setArena(mapForSeed(infoA.seed));
if (mapForSeed(infoA.seed) !== mapForSeed(infoB.seed)) die('clients picked different maps');
console.log(`  match  seed=${infoA.seed} | ALPHA idx=${infoA.idx} host=${infoA.host} | BETA idx=${infoB.idx} host=${infoB.host}`);
console.log(`  map    both clients on "${currentMap().name}" from the shared seed`);

/* ---------- build both sessions ---------- */
function build(info, seedSalt) {
  const ai = new BotAI(info.idx, 'normal', (info.seed ^ seedSalt) >>> 0);
  const base = {
    transport: info.transport, idx: info.idx, seed: info.seed,
    opp: info.opp, mode: 'online',
    readInput: () => ai.step(sess.sim, DT),
  };
  const sess = info.host ? new HostSession(base) : new ClientSession(base);
  return sess;
}
const a = build(infoA, 0x1234);
const b = build(infoB, 0x9abc);

let endedA = null, endedB = null;
a.on('ended', (d) => { endedA = d; });
b.on('ended', (d) => { endedB = d; });
a.on('peerLeft', () => die('ALPHA lost the peer mid-round'));
b.on('peerLeft', () => die('BETA lost the peer mid-round'));

a.start(); b.start();

/* ---------- drive both at an accelerated but equal rate ---------- */
const host = infoA.host ? a : b;
const client = infoA.host ? b : a;
/* Measure how far reconciliation has to move the local player.
   CHAOS TELEPORT and MEGA KNOCKBACK legitimately relocate people across
   the arena, so the raw maximum is meaningless - percentiles are what
   tell you whether ordinary play is smooth. */
const errs = [];
let snapshots = 0;
const realSnapshot = client._onSnapshot.bind(client);
client._onSnapshot = (d) => {
  snapshots++;
  const before = client.sim.players[client.idx];
  const bx = before.x, bz = before.z;
  realSnapshot(d);
  const after = client.sim.players[client.idx];
  errs.push(Math.hypot(after.x - bx, after.z - bz));
};
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

const started = Date.now();
const step = 1 / 60 * SPEED;
let orbGrabs = 0;
let abilityUses = 0;
let prevCh = [0, 0];
while (!(endedA && endedB)) {
  a.update(step);
  b.update(step);
  // charges only ever go up by collecting an orb, so a rise is a pickup
  const hsim = (infoA.host ? a : b).sim;
  for (let i = 0; i < 2; i++) {
    const p = hsim.players[i];
    const tot = p.ch0 + p.ch1 + p.ch2;
    if (tot > prevCh[i]) orbGrabs += tot - prevCh[i];
    else if (tot < prevCh[i]) abilityUses += prevCh[i] - tot;   // charges only fall by firing
    prevCh[i] = tot;
  }
  await wait(16);
  if (Date.now() - started > 90000) die('round never finished (host phase=' + host.sim.phase + ')');
}

/* ---------- assertions ---------- */
const hs = host.sim, cs = client.sim;
const problems = [];
if (hs.winner !== cs.winner) problems.push(`winner disagreement host=${hs.winner} client=${cs.winner}`);
for (let i = 0; i < 2; i++) {
  if (hs.players[i].score !== cs.players[i].score) {
    problems.push(`score disagreement p${i}: host=${hs.players[i].score} client=${cs.players[i].score}`);
  }
}
/* abilities are the newest thing on the wire, so check them explicitly */
{
  const collected = orbGrabs;
  // Abilities are charge-gated now: a spend is the only reliable signal that
  // one fired. The old check looked for a live cooldown, which the 0.4s
  // anti-spam lock has almost always finished by the final tick.
  if (!abilityUses) problems.push('neither player used an ability all round');
  for (let i = 0; i < 2; i++) {
    for (const k of ['cd0', 'cd1', 'cd2', 'ch0', 'ch1', 'ch2', 'abilityHits']) {
      if (Math.abs(hs.players[i][k] - cs.players[i][k]) > 0.05) {
        problems.push(`host and client disagree on p${i}.${k}: ${hs.players[i][k]} vs ${cs.players[i][k]}`);
      }
    }
  }
  if (hs.bananas.length !== cs.bananas.length) {
    problems.push(`banana count differs: host ${hs.bananas.length}, client ${cs.bananas.length}`);
  }

  // Abilities are pickup-gated, so an ability firing at all proves orbs were
  // collected. The orb field itself has to agree or the two sides would be
  // looking at different pickups on the floor.
  if (hs.orbs.length !== cs.orbs.length) {
    problems.push(`orb count differs: host ${hs.orbs.length}, client ${cs.orbs.length}`);
  } else {
    for (let k = 0; k < hs.orbs.length; k++) {
      if (Math.abs(hs.orbs[k].x - cs.orbs[k].x) > 0.05 || hs.orbs[k].kind !== cs.orbs[k].kind) {
        problems.push(`orb ${k} differs between host and client`);
      }
    }
  }
  if (!collected) problems.push('no ability orb was ever collected all round');
  console.log(`  abil   ability hits ${hs.players[0].abilityHits}/${hs.players[1].abilityHits}, ` +
    `${collected} orb(s) collected, ${abilityUses} spent, ` +
    `charges and ${hs.orbs.length} loose orb(s) agree across the wire`);
}

const p50 = pct(errs, 0.5), p95 = pct(errs, 0.95), pmax = Math.max(0, ...errs);
if (snapshots < 100) problems.push(`only ${snapshots} snapshots arrived in a 60s round`);
if (p95 > 2.5) problems.push(`client prediction drifted ${p95.toFixed(2)}u (p95) from the server`);
if (hs.players[0].score === 0 && hs.players[1].score === 0) problems.push('nobody scored - the objective never got picked up');

console.log(`  round  ${hs.tick} ticks in ${((Date.now() - started) / 1000).toFixed(1)}s wall (${SPEED}x)`);
console.log(`  score  ${hs.players[0].score} - ${hs.players[1].score}  winner=${hs.winner}` +
  `  steals=${hs.players[0].steals}/${hs.players[1].steals}` +
  `  hits=${hs.players[0].dashHits}/${hs.players[1].dashHits}` +
  `  events=${hs.eventsSeen}`);
console.log(`  net    ${snapshots} snapshots | rollback correction p50=${p50.toFixed(3)}u ` +
  `p95=${p95.toFixed(3)}u max=${pmax.toFixed(2)}u (max includes teleport events)`);

a.dispose(); b.dispose();
await wait(250);

/* ---------- a peer vanishing must not hang the other one ---------- */
{
  const pC = joinQueue('GAMMA', 'blob').catch((e) => ({ err: e }));
  await wait(150);
  const pD = joinQueue('DELTA', 'mint').catch((e) => ({ err: e }));
  const [infoC, infoD] = await Promise.all([pC, pD]);
  if (infoC.err || infoD.err) problems.push('second match never formed');
  else {
    const survivor = infoC.host ? infoC : infoD;
    const quitter = infoC.host ? infoD : infoC;
    const s = new HostSession({
      transport: survivor.transport, idx: survivor.idx, seed: survivor.seed,
      opp: survivor.opp, mode: 'online', readInput: () => ({ x: 0, z: 0, dash: false, taunt: false }),
    });
    let sawLeave = false;
    s.on('peerLeft', () => { sawLeave = true; s.forfeit(); });
    s.start();
    quitter.transport.close();
    for (let i = 0; i < 60 && !sawLeave; i++) { s.update(1 / 60); await wait(25); }
    if (!sawLeave) problems.push('host was never told the opponent disconnected');
    else if (s.sim.winner !== survivor.idx) problems.push('forfeit did not award the win to the remaining player');
    else console.log('  drop   opponent disconnect -> forfeit win for the player who stayed');
    s.dispose();
  }
}

await wait(200);
server.kill();

if (problems.length) {
  console.error('\n' + problems.map((p) => '  FAIL  ' + p).join('\n'));
  if (serverLog.trim()) console.error('\n--- server log ---\n' + serverLog.trim());
  process.exit(1);
}
console.log('\n✅ real 2-player match over a real relay: host and client agree');
process.exit(0);
