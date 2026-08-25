/* ============================================================
   check.mjs - import every module in a Node sandbox.

   Catches syntax errors, bad import paths and accidental
   top-level DOM access before the game ever reaches a browser.
     node tools/check.mjs
   ============================================================ */

import fs, { readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const SKIP = new Set(['main.js']);      // main.js boots the game on import

/* ---- the thinnest possible DOM so pure-logic modules load ---- */
const noop = () => {};
const fakeEl = new Proxy({}, {
  get(_t, k) {
    if (k === 'style') return new Proxy({}, { get: () => '', set: () => true });
    if (k === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
    if (k === 'children') return [];
    if (k === 'appendChild' || k === 'remove' || k === 'addEventListener') return noop;
    if (k === 'querySelector' || k === 'closest') return () => null;
    if (k === 'querySelectorAll') return () => [];
    return undefined;
  },
  set: () => true,
});
globalThis.window = globalThis;
globalThis.document = {
  getElementById: () => null,
  createElement: () => fakeEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: fakeEl,
  hidden: false,
  addEventListener: noop,
};
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', hardwareConcurrency: 4 }, configurable: true });
}
if (!globalThis.performance) {
  Object.defineProperty(globalThis, 'performance', { value: { now: () => Date.now() }, configurable: true });
}
globalThis.location = { protocol: 'http:', host: 'localhost:8080', search: '' };
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.get(k) ?? null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
globalThis.WebSocket = class { constructor() { throw new Error('no sockets in check'); } };

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(SRC).sort();
let ok = 0, bad = 0;

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (SKIP.has(path.basename(f))) { console.log(`  skip  ${rel}`); continue; }
  try {
    await import(pathToFileURL(f).href);
    console.log(`  ok    ${rel}`);
    ok++;
  } catch (e) {
    console.error(`  FAIL  ${rel}\n        ${e.message}`);
    bad++;
  }
}

/* ---- a headless smoke test of the simulation itself ---- */
try {
  const { createSim, stepSim, encodeState, decodeState, statsFor, DT } = await import(
    pathToFileURL(path.join(SRC, 'game/sim.js')).href);

  const s = createSim(1234, { brainrotId: 'banana' });
  const fx = [];
  let inputs = [
    { x: 0, z: -1, dash: false, taunt: false },
    { x: 0, z: 1, dash: false, taunt: false },
  ];
  const total = Math.ceil((60 + 4.8) / DT);
  for (let i = 0; i < total; i++) {
    // random-ish but deterministic pilots so events and pickups actually fire
    if (i % 37 === 0) {
      const a = (i * 0.37) % (Math.PI * 2);
      inputs = [
        { x: Math.cos(a), z: Math.sin(a), dash: i % 111 === 0, taunt: false },
        { x: -Math.cos(a * 1.3), z: -Math.sin(a * 1.3), dash: i % 97 === 0, taunt: false },
      ];
    }
    stepSim(s, inputs, fx);
    for (const p of s.players) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
        throw new Error(`player position went non-finite at tick ${i}`);
      }
      if (Math.abs(p.x) > 21 || Math.abs(p.z) > 21) {
        throw new Error(`player escaped the arena at tick ${i}: ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
      }
    }
    if (!Number.isFinite(s.br.x) || Math.abs(s.br.x) > 21) throw new Error('brainrot escaped at tick ' + i);
  }
  if (s.phase !== 'over') throw new Error('round did not finish, phase=' + s.phase);

  // encode/decode round trip must be lossless enough to keep simulating
  const wire = encodeState(s);
  const back = decodeState(wire, createSim(1234));
  if (back.tick !== s.tick) throw new Error('decode lost the tick');
  if (Math.abs(back.players[0].score - s.players[0].score) > 0) throw new Error('decode lost score');

  const st = statsFor(s, 0);
  console.log(`\n  sim   60s round simulated: ${s.tick} ticks, winner=${s.winner}, ` +
    `scores ${s.players[0].score}/${s.players[1].score}, events=${s.eventsSeen}`);
  console.log(`  sim   p1 holds ${st.holdTime.toFixed(1)}s, ${st.steals} steals, ${st.dashHits} hits, ` +
    `wire=${wire.length} numbers (~${(JSON.stringify(wire).length / 1024).toFixed(1)}kB/snapshot)`);
  ok++;
} catch (e) {
  console.error('  FAIL  simulation smoke test\n        ' + e.message + '\n' + (e.stack || ''));
  bad++;
}

/* ---- every ability must fire, land, and survive the wire ---- */
try {
  const { createSim, stepSim, encodeState, decodeState, CFG, ABILITIES, DT } = await import(
    pathToFileURL(path.join(SRC, 'game/sim.js')).href);
  if (ABILITIES.length !== 3) throw new Error('expected 3 abilities, got ' + ABILITIES.length);

  const idle = { x: 0, z: 0, dash: false, taunt: false, a0: false, a1: false, a2: false };
  const run = (setup, ticks, drive) => {
    const s = createSim(4242, { brainrotId: 'banana' });
    while (s.phase === 'countdown') stepSim(s, [idle, idle], null);
    // Abilities are pickup-gated now, so hand both players a full rack before
    // testing what the abilities themselves do.
    for (const p of s.players) { p.ch0 = CFG.ORB_STACK; p.ch1 = CFG.ORB_STACK; p.ch2 = CFG.ORB_STACK; }
    setup(s);
    const fx = [];
    for (let i = 0; i < ticks; i++) stepSim(s, drive(s, i), fx);
    return { s, fx };
  };

  // YEET KICK: stand them nose to nose and kick
  {
    const { s, fx } = run((s) => {
      s.players[0].x = 0; s.players[0].z = 0; s.players[0].face = 0;
      s.players[1].x = 2.2; s.players[1].z = 0;
    }, 40, (_s, i) => [i === 0 ? { ...idle, a0: true } : idle, idle]);
    if (!fx.some((f) => f.t === 'kickHit')) throw new Error('yeet kick never connected');
    if (s.players[0].ch0 !== CFG.ORB_STACK - 1) throw new Error('kick did not spend a charge');
    if (s.players[1].stunT <= 0 && s.players[1].bonked === 0) throw new Error('kick did not stun');
    if (s.players[0].score < CFG.KICK_BONUS) throw new Error('kick paid no bonus');
  }

  // BANANA: throw one, walk the victim into it
  {
    const { s, fx } = run((s) => {
      s.players[0].x = 0; s.players[0].z = 0; s.players[0].face = 0;
      s.players[1].x = 14; s.players[1].z = 0;
    }, 260, (_s, i) => [i === 0 ? { ...idle, a1: true } : idle, { ...idle, x: -1 }]);
    if (!fx.some((f) => f.t === 'banana')) throw new Error('banana was never thrown');
    if (!fx.some((f) => f.t === 'slip')) throw new Error('nobody slipped on the banana');
    if (s.players[0].score < CFG.SLIP_BONUS) throw new Error('slip paid no bonus');
  }

  // ULTIMATE: rip the brainrot out of the other player's hands
  {
    const { s, fx } = run((s) => {
      s.players[0].x = 0; s.players[0].z = 0;
      s.players[1].x = 6; s.players[1].z = 0;
      s.br.owner = 1;
    }, 90, (_s, i) => [i === 0 ? { ...idle, a2: true } : idle, idle]);
    if (!fx.some((f) => f.t === 'ultRip')) throw new Error('the magnet did not rip the brainrot free');
    if (s.br.owner === 1) throw new Error('the opponent still has the brainrot after the ultimate');
  }

  // both players must be gated identically - no platform advantage
  {
    const s = createSim(7, {});
    while (s.phase === 'countdown') stepSim(s, [idle, idle], null);
    const press = { ...idle, a0: true, a1: true, a2: true };

    // with nothing collected, pressing everything must do nothing at all
    stepSim(s, [press, press], null);
    const a = s.players[0], b = s.players[1];
    if (a.cd0 > 0 || a.cd1 > 0 || a.cd2 > 0) throw new Error('an ability fired with no charge banked');
    if (a.kickT > 0 || a.ultT > 0 || s.bananas.length) throw new Error('an ability took effect with no charge');

    // with one each, they spend exactly one and lock identically
    for (const p of s.players) { p.ch0 = 1; p.ch1 = 1; p.ch2 = 1; }
    stepSim(s, [press, press], null);
    if (a.ch0 !== 0 || a.ch1 !== 0 || a.ch2 !== 0) throw new Error('firing did not spend the charge');
    if (a.ch0 !== b.ch0 || a.ch1 !== b.ch1 || a.ch2 !== b.ch2) throw new Error('charges differ between players');
    if (a.cd0 !== b.cd0 || a.cd1 !== b.cd1 || a.cd2 !== b.cd2) throw new Error('ability locks differ between players');
    if (Math.abs(a.cd0 - CFG.ABILITY_LOCK) > DT * 2) throw new Error('ability lock is not ABILITY_LOCK');

    // and an empty slot stays empty however hard you mash it
    for (let i = 0; i < 120; i++) stepSim(s, [press, press], null);
    if (a.ch0 !== 0 || s.bananas.length > 2) throw new Error('mashing produced abilities from nothing');
  }

  // orbs must arrive in mirrored pairs and be collectable into charges
  {
    const s = createSim(31337, {});
    while (s.phase === 'countdown') stepSim(s, [idle, idle], null);
    const fx = [];
    for (let i = 0; i < Math.ceil(20 / DT); i++) stepSim(s, [idle, idle], fx);
    if (!s.orbs.length) throw new Error('no ability orbs ever dropped');
    if (s.orbs.length % 2 !== 0) throw new Error('orbs did not drop in pairs');
    for (const o of s.orbs) {
      const twin = s.orbs.find((q) => Math.abs(q.x + o.x) < 1e-6 && Math.abs(q.z + o.z) < 1e-6
        && q.kind === o.kind);
      if (!twin) throw new Error(`orb at (${o.x.toFixed(1)}, ${o.z.toFixed(1)}) has no mirrored twin`);
    }
    if (s.orbs.length > CFG.ORB_MAX) throw new Error('more orbs alive than ORB_MAX');

    // walk a player onto one and it becomes a charge
    const o = s.orbs[0];
    const p = s.players[0];
    p.x = o.x; p.z = o.z; p.y = o.y - 0.9;
    const before = p['ch' + o.kind];
    stepSim(s, [idle, idle], fx);
    if (p['ch' + o.kind] !== before + 1) throw new Error('standing on an orb did not grant a charge');
    if (!fx.some((f) => f.t === 'orbGrab')) throw new Error('no orbGrab effect was emitted');

    // and charges cap rather than growing forever
    p.ch0 = CFG.ORB_STACK;
    const cap = s.orbs.find((q) => q.kind === 0);
    if (cap) {
      p.x = cap.x; p.z = cap.z; p.y = cap.y - 0.9;
      stepSim(s, [idle, idle], null);
      if (p.ch0 > CFG.ORB_STACK) throw new Error('charges exceeded ORB_STACK');
    }
  }

  /* TAG BOMB: one bomb, one fuse, and the holder when it blows loses */
  {
    const { bombSeconds, firstHolder } = await import(
      pathToFileURL(path.join(SRC, 'game/sim.js')).href);

    // the fuse and the first holder come from the shared seed, so both
    // clients must compute them identically and stay inside the stated range
    let bad = 0;
    for (let i = 0; i < 20000; i++) {
      const seed = (Math.random() * 0xffffffff) >>> 0;
      if (bombSeconds(seed) !== bombSeconds(seed)) bad++;
      if (firstHolder(seed) !== firstHolder(seed)) bad++;
      const secs = bombSeconds(seed);
      if (secs < CFG.BOMB_MIN || secs > CFG.BOMB_MAX) throw new Error('fuse ' + secs + 's is outside 15-25');
    }
    if (bad) throw new Error('tag bomb setup is not deterministic across clients');

    // classic is untouched
    const classic = createSim(4242, { brainrotId: 'banana', variant: 'classic' });
    while (classic.phase === 'countdown') stepSim(classic, [idle, idle], null);
    classic.br.owner = 0;
    for (let i = 0; i < 120; i++) stepSim(classic, [idle, idle], null);
    if (classic.players[0].score <= 0) throw new Error('classic stopped paying for holding');

    // a full tag bomb round, holder chasing and prey fleeing
    const tb = createSim(777, { brainrotId: 'banana', variant: 'tagbomb' });
    if (tb.br.owner < 0) throw new Error('tag bomb did not start armed');
    while (tb.phase === 'countdown') stepSim(tb, [idle, idle], null);
    const fx = [];
    for (let i = 0; i < Math.ceil(40 / DT) && tb.phase === 'play'; i++) {
      const h = tb.br.owner, hold = tb.players[h], prey = tb.players[1 - h];
      const dx = prey.x - hold.x, dz = prey.z - hold.z, d = Math.hypot(dx, dz) || 1;
      const inp = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
      inp[h] = { x: dx / d, z: dz / d, a0: i % 120 === 0, a1: i % 200 === 0 };
      inp[1 - h] = { x: -dx / d * 0.85, z: -dz / d * 0.85, dash: i % 150 === 0 };
      stepSim(tb, inp, fx);
      if (tb.br.owner < 0) throw new Error('an ability knocked the bomb loose - it must never drop');
    }

    const tags = fx.filter((f) => f.t === 'tag').length;
    if (tags < 2) throw new Error('tagging never happened (' + tags + ')');
    if (tb.phase !== 'over') throw new Error('the round never ended');
    if (tb.winner !== 1 - tb.br.owner) throw new Error('the holder did not lose');
    if (!fx.some((f) => f.t === 'blast')) throw new Error('no explosion at the end');
    if (tb.players[0].score || tb.players[1].score) {
      throw new Error(`tag bomb awarded score (${tb.players[0].score}/${tb.players[1].score}) - it is win or lose only`);
    }
    if (tb.players[0].tags + tb.players[1].tags !== tags) throw new Error('tag counters disagree with the effects');

    console.log(`  mode  tag bomb: ${tags} tags over a ${bombSeconds(777).toFixed(1)}s fuse, `
      + 'bomb never dropped, holder loses, no score awarded');
  }

  // the wire has to carry ability state and live bananas
  {
    const s = createSim(99, {});
    while (s.phase === 'countdown') stepSim(s, [idle, idle], null);
    stepSim(s, [{ ...idle, a1: true }, { ...idle, a0: true }], null);
    for (let i = 0; i < 30; i++) stepSim(s, [idle, idle], null);
    const back = decodeState(encodeState(s), createSim(99, {}));
    if (back.bananas.length !== s.bananas.length) throw new Error('bananas lost in transit');
    if (Math.abs(back.players[1].cd0 - s.players[1].cd0) > 1e-3) throw new Error('cooldown lost in transit');
    if (Math.abs(back.players[0].cd1 - s.players[0].cd1) > 1e-3) throw new Error('cooldown lost in transit');
  }
  console.log('  abil  kick lands, banana trips, magnet rips; cooldowns equal; state survives the wire');
  ok++;
} catch (e) {
  console.error('  FAIL  abilities\n        ' + e.message);
  bad++;
}

/* ---- the shipped bundle must contain no way to reach the network ----

   This is the requirement the whole offline conversion rests on, so it is
   asserted against the built artifact rather than the source: what matters
   is what a reviewer downloads, not what the modules intended. The only URL
   allowed through is the Playables SDK, which the rules explicitly permit. */
try {
  const DIST = path.join(ROOT, 'dist');
  if (!fs.existsSync(path.join(DIST, 'bundle.js'))) {
    throw new Error('dist/bundle.js missing - run `node tools/build.mjs` first');
  }
  const bundle = fs.readFileSync(path.join(DIST, 'bundle.js'), 'utf8');
  const page = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

  const banned = ['XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
                  'RTCPeerConnection', 'socket.io', 'firebase', 'supabase', 'axios'];
  for (const b of banned) {
    if (bundle.includes(b)) throw new Error(`bundle still references ${b}`);
  }
  if (/\bfetch\s*\(/.test(bundle)) throw new Error('bundle still calls fetch()');

  const urls = new Set([...bundle.matchAll(/(?:https?|wss?):\/\/[^\s'\"`)]+/g)].map((m) => m[0]));
  for (const u of urls) throw new Error('bundle contains an external URL: ' + u);

  const pageUrls = [...page.matchAll(/(?:https?|wss?):\/\/[^\s'\"`)>]+/g)].map((m) => m[0]);
  const ALLOWED = ['https://www.youtube.com/game_api/v1', 'http://www.w3.org/2000/svg'];
  for (const u of pageUrls) {
    if (!ALLOWED.includes(u)) throw new Error('index.html contains an unexpected URL: ' + u);
  }
  if (!page.includes('https://www.youtube.com/game_api/v1')) {
    throw new Error('the Playables SDK script tag is missing');
  }

  /* Certification requires the SDK to load before game code. Match the
     official reference shape: a synchronous SDK tag followed immediately by
     a synchronous game-bundle tag. */
  /* Two real script tags: the SDK, then the inlined game. Match only opening
     tags at the start of an element, so a `<script>` written inside the
     inlined JS - in a comment, say - is not miscounted as a third. */
  const scripts = [...page.matchAll(/<script(?:\s[^>]*)?>/g)].map((m) => m[0]);
  const realScripts = scripts.filter((t, i) => i < 2 || !t.startsWith('<script>'));
  if (scripts.length < 2 || !scripts[0].includes('game_api/v1')) {
    throw new Error('the SDK is not the first script in the document');
  }
  if (realScripts.length > 2) {
    throw new Error(`expected 2 script tags, found ${realScripts.length}`);
  }
  if (!scripts[0].includes('game_api/v1')) {
    throw new Error('the first script is not the Playables SDK');
  }
  // charset first, then the SDK, then everything else
  if (page.indexOf('charset') > page.indexOf('<script')) {
    throw new Error('<meta charset> must come before the first script');
  }
  /* The SDK must be the first resource the page fetches, so the markup may
     name no other external file at all. The stylesheet is inlined and the
     icon files dropped and the bundle inlined, so the SDK is the only thing
     the document requests at all. */
  const refs = [...page.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('data:'));
  const unexpected = refs.filter((u) => u !== 'https://www.youtube.com/game_api/v1');
  if (unexpected.length) {
    throw new Error('the page fetches something before the SDK: ' + unexpected.join(', '));
  }
  /* The game code must not be a separate file. The SDK reports the whole
     performance buffer to the host with buffered:true, so any resource that
     finished downloading before it started is counted as loading first - and
     the preload scanner fetches a <script src> the moment it parses it. The
     bundle is inlined instead, which removes the request entirely. */
  if (/<script[^>]*\ssrc=["'][^"']*bundle\.js/.test(page)) {
    throw new Error('bundle.js is a separate request; it must be inlined');
  }
  if (!page.includes('__req(') || page.length < 100000) {
    throw new Error('the game bundle does not appear to be inlined in the page');
  }
  /* STB_CONFIG is prepended to the bundle, and the bundle is now inlined, so
     it legitimately appears in the page. What must not exist is a separate
     inline <script> for it ahead of the SDK - that was game code in the head.
     The SDK-first assertion above already covers that. */
  console.log('  offline bundle has no network primitives; only the Playables SDK URL remains');
  ok++;
} catch (e) {
  console.error('  FAIL  offline audit\n        ' + e.message);
  bad++;
}

/* ---- a saved profile must actually reach the rest of the game ----

   The bundler rewrites imports into a destructure, so a module that reassigns
   an exported binding leaves every importer holding the old value. storage.js
   did exactly that when loading a save: it read the JSON correctly and then
   assigned it to a fresh object nobody else referenced, so coins, XP, levels
   and stars silently reset on every load. This pins the object identity. */
try {
  const modUrl = pathToFileURL(path.join(SRC, 'core/storage.js')).href + '?persist=1';
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };

  const a = await import(modUrl);
  await a.initStorage();
  a.setName('PERSISTME');
  a.addCoins(777);
  await a.flush();

  // a second import with a fresh module registry stands in for a reload
  const b = await import(pathToFileURL(path.join(SRC, 'core/storage.js')).href + '?persist=2');
  await b.initStorage();
  if (b.profile.name !== 'PERSISTME') {
    throw new Error(`name did not survive a reload: got "${b.profile.name}"`);
  }
  if (b.profile.coins < 777) {
    throw new Error(`coins did not survive a reload: got ${b.profile.coins}`);
  }
  console.log('  save  profile survives a reload: name and coins both restored');
  ok++;
} catch (e) {
  console.error('  FAIL  save persistence\\n        ' + e.message);
  bad++;
}

/* ---- Playables cloud save: load completes before save, with no browser
   fallback when the SDK reports an error ---- */
try {
  const cloudWrites = [];
  globalThis.ytgame = {
    IN_PLAYABLES_ENV: true,
    game: {
      loadData: async () => '',
      saveData: async (data) => { cloudWrites.push(data); },
    },
  };
  const cloud = await import(pathToFileURL(path.join(SRC, 'core/storage.js')).href + '?cloud=1');
  const { backend } = await cloud.initStorage();
  if (backend !== 'ytgame') throw new Error(`expected ytg backend, got ${backend}`);
  cloud.setName('CLOUDONLY');
  await cloud.flush();
  if (cloudWrites.length !== 1) throw new Error(`expected one cloud write, got ${cloudWrites.length}`);
  if (cloudWrites[0].length * 2 >= 3 * 1024 * 1024) throw new Error('cloud save exceeds 3 MiB');

  let rejectedWrites = 0;
  globalThis.ytgame.game.loadData = async () => { throw new Error('offline'); };
  globalThis.ytgame.game.saveData = async () => { rejectedWrites++; };
  const rejected = await import(pathToFileURL(path.join(SRC, 'core/storage.js')).href + '?cloud-rejected=1');
  await rejected.initStorage();
  rejected.addCoins(1);
  await rejected.flush();
  if (rejectedWrites) throw new Error('saved after a failed cloud load');
  delete globalThis.ytgame;
  console.log('  cloud load precedes save; cloud data is UTF-16 and below 3 MiB');
  ok++;
} catch (e) {
  delete globalThis.ytgame;
  console.error('  FAIL  Playables cloud save\\n        ' + e.message);
  bad++;
}

/* ---- a sandboxed iframe can deny storage outright; the game must still run ---- */
try {
  const denied = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { denied(); },
  });
  // re-import with a cache-busting query so initStorage re-runs detection
  const mod = await import(pathToFileURL(path.join(SRC, 'core/storage.js')).href + '?denied=1');
  const { backend } = await mod.initStorage();
  if (backend !== 'memory') throw new Error(`expected the memory backend, got "${backend}"`);
  mod.addCoins(25);
  await mod.flush();                        // must not throw
  if (mod.profile.coins < 25) throw new Error('in-memory profile did not take the write');
  console.log(`  store storage denied -> fell back to "${backend}", game still writable`);
  ok++;
} catch (e) {
  console.error('  FAIL  storage-denied fallback\n        ' + e.message);
  bad++;
}

/* ---- the level ladder: goals, star thresholds and the unlock chain ---- */
try {
  const L = await import(pathToFileURL(path.join(SRC, 'data/levels.js')).href);
  const { LEVELS, starsEarned, levelById } = L;

  if (LEVELS.length < 8) throw new Error('ladder is suspiciously short');
  const ids = LEVELS.map((l) => l.id);
  if (ids.some((v, i) => v !== i + 1)) throw new Error('level ids must run 1..n with no gaps');
  for (const lv of LEVELS) {
    if (!['classic', 'tagbomb'].includes(lv.variant)) throw new Error(`level ${lv.id}: bad variant`);
    if (!(lv.map >= 0 && lv.map < 5)) throw new Error(`level ${lv.id}: map out of range`);
    if (!(lv.stars[1] > lv.stars[0])) throw new Error(`level ${lv.id}: 3-star target must beat 2-star`);
  }

  // a missed goal earns nothing, which is what keeps the next level shut
  const l2 = levelById(2);            // goal: score 22
  if (starsEarned(l2, { won: true, stats: { score: 10 } }) !== 0) {
    throw new Error('level 2 cleared despite missing its score goal');
  }
  if (starsEarned(l2, { won: false, stats: { score: 25 } }) !== 1) {
    throw new Error('level 2 should clear on score alone, win or not');
  }
  if (starsEarned(l2, { won: true, stats: { score: 41 } }) !== 3) {
    throw new Error('level 2 should be worth 3 stars at its top threshold');
  }

  // a TAG BOMB level is judged on tags, not score
  const l5 = levelById(5);            // goal: 2 tags
  if (starsEarned(l5, { won: false, stats: { score: 99, tags: 0 } }) !== 0) {
    throw new Error('score must not clear a tags goal');
  }
  if (starsEarned(l5, { won: false, stats: { score: 0, tags: 5 } }) !== 3) {
    throw new Error('5 tags should be worth 3 stars on level 5');
  }
  console.log(`  levels ${LEVELS.length} stages, goals and star thresholds all consistent`);
  ok++;
} catch (e) {
  console.error('  FAIL  level ladder\n        ' + e.message);
  bad++;
}

/* ---- every button in the markup must actually be wired ----

   PLAY AGAIN and MAIN MENU shipped dead: their handlers were removed as
   collateral when the name-entry code was cut, and nothing caught it because
   the buttons still rendered. A player finishing a match had no way off the
   results screen. This walks the ids in index.html and fails if one has no
   handler in the UI layer. */
try {
  const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  /* Two places legitimately bind buttons: ui.js for menu and screen controls,
     input.js for the in-match pad, where TAUNT and the ability buttons live. */
  /* Three places legitimately reference buttons: ui.js for menu and screen
     controls, main.js where the in-match pad elements are looked up, and
     input.js which binds them. */
  const wiring = ['ui/ui.js', 'core/input.js', 'main.js']
    .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('');
  const ids = [...page.matchAll(/<button[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
  if (ids.length < 8) throw new Error('found suspiciously few buttons: ' + ids.length);
  const dead = ids.filter((id) => !wiring.includes(`'${id}'`) && !wiring.includes(`"${id}"`));
  if (dead.length) {
    throw new Error('buttons with no handler: ' + dead.join(', '));
  }
  console.log(`  ui    all ${ids.length} buttons in the markup are wired`);
  ok++;
} catch (e) {
  console.error('  FAIL  dead buttons\n        ' + e.message);
  bad++;
}

console.log(`\n${bad ? '❌' : '✅'} ${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
