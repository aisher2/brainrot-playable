/* ============================================================
   main.js - boot, the game loop, and the round lifecycle.

   CLICK PLAY -> MATCH -> RUN -> STEAL -> CHAOS -> WIN -> AGAIN
   ============================================================ */

import { Emitter, clamp, clamp01, RNG } from './core/util.js';
import {
  initStorage, profile, publicProfile, displayName, addCoins, addXp,
  applyMatchStats, recordResult, refreshUnlocks, collect, levelInfo,
  getSetting, setSetting, save, flush, storageBackend, store,
} from './core/storage.js';
import { Input } from './core/input.js';
import {
  initAudio, sfx, startMusic, startMenuMusic, stopMusic, setIntensity,
  setMusicEnabled, setSfxEnabled, duckMusic, playBrainrotSfx,
} from './core/audio.js';
import { setDetail } from './gfx/mesh.js';
import { Studio } from './gfx/studio.js';
import { GameView } from './game/view.js';
import { createSession, HostSession } from './game/match.js';
import { setArena, mapForSeed, currentMap } from './game/arena.js';
import { CFG, DT, EVENTS, ABILITIES } from './game/sim.js';
import { Matchmaker, CancelError } from './net/netclient.js';
import { CONFIG, relayUrl, onlineEnabled, yt } from './core/platform.js';
import { submitScore } from './net/leaderboard.js';
import { matchRewards } from './data/progression.js';
import { matchBrainrot, rollBrainrot, BRAINROT_BY_ID } from './data/brainrots.js';
import { defaultLoadout } from './data/cosmetics.js';
import { UI } from './ui/ui.js';

const app = {
  ui: null, view: null, input: null, studio: null, mm: null,
  session: null, bot: null, mode: 'menu', matchMode: 'online',
  raf: 0, last: 0, acc: 0, fps: 60, frameAvg: 16.7,
  quality: 1, qualityLock: false, qTimer: 0,
  lastCd: -99, slow: 1, ending: false, resultShown: false,
  paused: false, opp: null, localIdx: 0, hostAudioOk: true, stealTap: false,
};
globalThis.__stb = app;   // handy for debugging in the console

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   BOOT
   ============================================================ */
/**
 * The game loads in well under a second, which leaves no time to read the
 * loading gags. Hold the boot screen to this floor so a few land - short
 * enough that it still reads as a fast load. Set to 0 to disable.
 */
const MIN_BOOT_MS = 1800;

async function boot() {
  const bootStart = Date.now();
  const ui = new UI(null);
  app.ui = ui;
  ui.startBootGags();

  ui.setLoading(0.05, 'waking up the brainrots');
  const { backend } = await initStorage();
  ui.setLoading(0.2, 'reading your brainrot diary');
  yt.firstFrameReady();          // loading screen is on screen

  // pick a geometry detail level once, from what the device tells us
  const detail = pickDetail();
  setDetail(detail.geo);
  app.quality = detail.q;

  await frame();
  ui.setLoading(0.34, 'assembling the arena');

  const canvas = document.getElementById('gl');
  let view;
  try {
    view = new GameView(canvas);
  } catch (e) {
    fatal('This game needs WebGL. Try a different browser.', e);
    return;
  }
  app.view = view;
  view.setQuality(app.quality);
  view.setCamSensitivity(getSetting('camSens'));
  ui.setLoading(0.62, 'sculpting 28 brainrots');

  await frame();
  app.studio = new Studio(192);
  ui.studio = app.studio;
  ui.setLoading(0.78, 'tuning the funny sounds');

  initAudio();
  setMusicEnabled(getSetting('music'));
  setSfxEnabled(getSetting('sfx'));
  // Arm the loading/menu theme now. Browsers will not let it sound before the
  // first gesture, so it queues itself and starts on the player's first touch.
  if (getSetting('music')) startMenuMusic();

  app.input = new Input({
    stickEl: document.getElementById('stick'),
    nubEl: document.getElementById('stickNub'),
    dashBtn: document.getElementById('btnDash'),
    a0Btn: document.getElementById('btnA0'),
    a1Btn: document.getElementById('btnA1'),
    a2Btn: document.getElementById('btnA2'),
    abilityBtn: document.getElementById('btnAbility'),
    touchLayer: document.getElementById('touchLayer'),
  });

  app.mm = new Matchmaker();
  wireUI();

  ui.setLoading(0.94, 'almost brainrotted');
  await frame();

  // Hold here rather than after the bar fills, so the gag reel is still
  // running during the wait and the bar keeps creeping instead of sticking.
  const left = MIN_BOOT_MS - (Date.now() - bootStart);
  if (left > 0) {
    const steps = Math.ceil(left / 90);
    for (let i = 1; i <= steps; i++) {
      await wait(left / steps);
      ui.setLoading(0.94 + 0.05 * (i / steps));
    }
  }

  ui.setLoading(1, 'ready');
  await wait(300);

  ui.hideBoot();
  app.mode = 'menu';
  ui.show('menu');
  if (profile.firstRun) { profile.firstRun = false; save(); }
  ui.setOnlineAvailable(onlineEnabled());
  probeServer();
  startLoop();
  yt.gameReady();                // the player can interact now

  if (CONFIG.autoPractice) startMatch('practice');

  if (CONFIG.dev) {
    console.info(`[steal-the-brainrot] save=${backend} detail=${detail.geo} ` +
      `quality=${app.quality} online=${onlineEnabled() ? relayUrl() : 'off'}`);
  }
}

/** the three presets the Graphics setting exposes */
const QUALITY = { low: 0.35, medium: 0.6, high: 1 };

function pickDetail() {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = matchMedia('(pointer:coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 500;
  const weak = mem <= 2 || cores <= 3 || (coarse && small && mem <= 4);
  const forced = getSetting('quality');
  if (forced === 'low') return { geo: 0.55, q: 0.35 };
  if (forced === 'medium') return { geo: 0.8, q: 0.6 };
  if (forced === 'high') return { geo: 1, q: 1 };
  if (weak) return { geo: 0.65, q: 0.5 };
  if (coarse) return { geo: 0.85, q: 0.75 };
  return { geo: 1, q: 1 };
}

/**
 * Yield a frame during boot. rAF is throttled (or stopped entirely) in a
 * background tab, so it always races a timer - otherwise the game would
 * never finish loading if the player opened it in a second tab.
 */
const frame = () => new Promise((r) => {
  let done = false;
  const fin = () => { if (!done) { done = true; r(); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 50);
});

function fatal(msg, err) {
  console.error(msg, err);
  const b = document.getElementById('boot');
  if (b) b.innerHTML = `<div style="text-align:center;padding:24px"><div style="font-size:52px">💀</div>
    <h2 style="font-size:18px">${msg}</h2></div>`;
}

/* ============================================================
   UI WIRING
   ============================================================ */
function wireUI() {
  const ui = app.ui;

  // PLAY queues for a real player. Only a build with no relay at all falls
  // through to practice, and in that build the button is labelled PLAY VS BOT.
  ui.on('play', () => startMatch(onlineEnabled() ? 'online' : 'practice'));
  ui.on('practice', () => startMatch('practice'));
  // "the queue is empty, just let me play" - keeps a lone visitor from
  // ever hitting a dead end on the search screen
  ui.on('playSolo', () => { app.mm.cancel(); startMatch('practice'); });

  /* ---- play with a friend: one side mints a code, the other redeems it ---- */
  ui.on('makeRoom', async () => {
    if (!relayUrl(getSetting('serverUrl'))) {
      ui.setFriendError('This build has no multiplayer server configured.');
      sfx.error();
      return;
    }
    app.mm.cancel();
    ui.setFriendBusy('opening a room...');
    ui.setFriendPending(true);
    const off = app.mm.on('roomCode', (code) => { ui.setFriendBusy(''); ui.setRoomCode(code); });
    try {
      await beginMatch({ mode: 'friend' });
    } catch (e) {
      if (!(e instanceof CancelError)) {
        ui.show('friend');
        ui.setRoomCode('');
        ui.setFriendError(app.mm.lastError || 'Could not open a room.');
        sfx.error();
      }
    } finally { off(); ui.setFriendPending(false); }
  });

  ui.on('joinRoom', async (code) => {
    if (!relayUrl(getSetting('serverUrl'))) {
      ui.setFriendError('This build has no multiplayer server configured.');
      sfx.error();
      return;
    }
    app.mm.cancel();
    ui.setFriendBusy('joining room ' + code + '...');
    ui.setFriendPending(true);
    try {
      await beginMatch({ mode: 'friend', code });
    } catch (e) {
      if (!(e instanceof CancelError)) {
        ui.show('friend');
        ui.setFriendError(app.mm.lastError || 'Could not join that room.');
        sfx.error();
      }
    } finally { ui.setFriendPending(false); }
  });

  ui.on('cancelFriend', () => app.mm.cancel());
  ui.on('cancel', () => { app.mm.cancel(); backToMenu(); });
  ui.on('quit', () => { endSession(); backToMenu(); });
  ui.on('home', () => backToMenu());
  ui.on('again', () => startMatch(app.matchMode));
  ui.on('loadout', () => { /* preview refreshes itself */ });

  // "🦵 YEET KICK — READY" the instant it comes off cooldown
  ui.onAbilityReady((i) => {
    if (app.mode !== 'match' || !app.session) return;
    if (app.session.sim.phase !== 'play') return;
    const a = ABILITIES[i];
    if (!a) return;                       // index 3 is dash; it is announced by its ring alone
    ui.toast(`${a.icon} ${a.name} — COLLECTED`, 'info');
    sfx.score();
  });

  // the steal prompt just fires a dash at the holder
  ui.on('stealTap', () => { app.stealTap = true; });

  ui.on('screen', (name) => {
    // Keep simulating behind the results screen so the winner's victory
    // animation actually plays instead of cutting to the menu backdrop.
    const inArena = (name === 'hud' || name === 'result') && !!app.session;
    app.mode = inArena ? 'match' : 'menu';
    app.input.setEnabled(name === 'hud');
    if (name !== 'hud') ui.setStealPrompt(false);
    if (app.view) app.view.showPlates(name === 'hud');
  });

  ui.on('setting', (k, v) => {
    if (k === 'music') { setMusicEnabled(v); if (v && app.mode === 'match') startMusic(); }
    if (k === 'sfx') setSfxEnabled(v);
    if (k === 'mute') { setMusicEnabled(!v && getSetting('music')); setSfxEnabled(!v && getSetting('sfx')); }
    if (k === 'quality') {
      app.qualityLock = v !== 'auto';
      const q = QUALITY[v];
      if (q != null) { app.quality = q; app.view?.setQuality(q); }
    }
    if (k === 'camSens') app.view?.setCamSensitivity(v);
    if (k === 'showFps' && !v) ui.setFps(0, false);
    if (k === 'serverUrl') probeServer();
    if (k === 'music' || k === 'sfx' || k === 'mute') applyHostAudio();
  });

  ui.on('testServer', async () => {
    ui.setConnResult('testing...');
    const r = await app.mm.probe(getSetting('serverUrl'));
    ui.setConnResult(r.ok ? 'relay reachable ✓' : `unreachable — practice mode still works`);
    probeServer();
  });

  ui.on('resetProgress', async () => {
    try { localStorage.removeItem('stealthebrainrot.v1'); } catch (_) {}
    location.reload();
  });

  store.on('levelup', (lvl) => {
    sfx.levelup();
    refreshUnlocks();
    app.ui.toastInfo('LEVEL UP! You are now level ' + lvl);
  });

  const setPaused = (on) => {
    if (app.paused === on) return;
    app.paused = on;
    if (on) { app.acc = 0; stopMusic(0.2); }
    else if (getSetting('music') && app.hostAudioOk) {
      const inRound = app.mode === 'match' && app.session && !app.resultShown;
      if (inRound) startMusic(app.session.seed || 7);
      else startMenuMusic();
    }
  };
  addEventListener('visibilitychange', () => setPaused(document.hidden));
  addEventListener('pagehide', () => setPaused(true));

  // YouTube can suspend the game; obey it and never keep simulating in the dark
  yt.onPause(() => setPaused(true));
  yt.onResume(() => setPaused(document.hidden));

  // ...and it owns the mute switch while we are embedded
  app.hostAudioOk = yt.audioEnabled();
  applyHostAudio();
  yt.onAudioEnabledChange((on) => { app.hostAudioOk = !!on; applyHostAudio(); });

  addEventListener('resize', () => app.view?.resize());
  addEventListener('orientationchange', () => setTimeout(() => app.view?.resize(), 120));
}

/** Our own mute setting AND the host's have to agree before anything plays. */
function applyHostAudio() {
  const ok = app.hostAudioOk !== false;
  setMusicEnabled(ok && getSetting('music'));
  setSfxEnabled(ok && getSetting('sfx'));
}

/**
 * Only touch the network when a relay is actually configured. On a plain
 * static host CONFIG.relay is '', so the game never opens a socket - which
 * is what keeps the console clean for a reviewer opening the page cold.
 */
async function probeServer() {
  const ui = app.ui;
  const url = relayUrl(getSetting('serverUrl'));
  if (!url) {
    ui.setOnlineAvailable(false);
    ui.setNetStatus('', 'solo mode');
    ui.setPlaySub('practice · 60 seconds');
    return;
  }
  ui.setNetStatus('', 'connecting');
  ui.setPlaySub('online · 1v1 · 60s');
  const r = await app.mm.probe(url, 2500);
  ui.setNetStatus(r.ok ? 'ok' : 'err', r.ok ? 'online' : 'offline');
  ui.setPlaySub(r.ok ? 'online · 1v1 · 60s' : 'server unreachable');
  // Reachability drives the status chip only. The button label follows what
  // this build is *configured* for, so a temporary outage never mislabels
  // PLAY as a bot match it is not going to start.
  ui.setOnlineAvailable(onlineEnabled());
}

/* ============================================================
   MATCH LIFECYCLE
   ============================================================ */
/** startMatch, but for the friend-room flow, which owns its own screen. */
async function beginMatch(opts) {
  return startMatch(opts.mode, opts);
}

async function startMatch(mode, opts = {}) {
  endSession();
  app.matchMode = mode === 'friend' ? 'online' : mode;
  app.ending = false;
  app.resultShown = false;
  app.slow = 1;
  app.lastCd = -99;

  const ui = app.ui;
  // a friend room keeps its own screen until the code is in play
  if (mode !== 'friend' || opts.code) ui.showSearch(mode === 'friend' ? 'online' : mode);
  if (mode === 'friend' && opts.code) {
    ui.setSearchSub('joining room ' + opts.code);
    const t = document.getElementById('searchTitle');
    if (t) t.textContent = 'JOINING YOUR FRIEND...';
  }

  // PLAY means a real opponent. If this deployment has no relay there is
  // nothing to queue for, so say so plainly rather than quietly swapping in
  // a bot the player did not ask for.
  // live queue feedback while we wait for a second human
  const offQueued = app.mm.on('queued', (n) => {
    ui.setSearchSub(n > 1 ? `you are #${n} in the queue` : 'waiting for another player to hit PLAY');
  });
  const offWaiting = app.mm.on('waiting', (secs) => {
    ui.setSearchWait(secs);
  });

  let info;
  try {
    info = await app.mm.find({
      mode,
      code: opts.code,
      serverUrl: relayUrl(getSetting('serverUrl')),
      profile: publicProfile(),
      difficulty: pickDifficulty(),
      humanHost: new URLSearchParams(location.search).get('role') !== 'client',
      lagMs: Number(new URLSearchParams(location.search).get('lag')) || 0,
    });
  } catch (e) {
    offQueued(); offWaiting();
    // The friend room owns its own screen and its own error line. Reporting
    // into the search screen here would write the failure somewhere the
    // player cannot see, so hand it back to the caller instead.
    if (mode === 'friend') throw e;
    if (e instanceof CancelError) { backToMenu(); return; }
    // Could not reach the relay. Do not strand the player on a dead screen -
    // say what happened and offer the bot as a clearly separate choice.
    sfx.error();
    const t = document.getElementById('searchTitle');
    if (t) t.textContent = "CAN'T REACH THE SERVER";
    ui.setSearchSub(app.mm.lastError || 'the matchmaking server did not answer');
    ui.showSoloOffer('practise against a bot instead');
    probeServer();
    return;
  }
  offQueued(); offWaiting();

  // Bake the arena before the opponent-found pause rather than after it: the
  // work then overlaps a wait the player is already sitting through, instead
  // of adding a visible hitch on a phone right as the round starts.
  const map = setArena(mapForSeed(info.seed));
  if (map) app.view.rebuildArena();
  app.map = currentMap();

  ui.showOpponentFound(info.opp);
  await wait(950);

  const readInput = () => {
    const inp = app.input.read();
    if (app.stealTap) { inp.dash = true; app.stealTap = false; }
    return inp;
  };
  const { session, bot } = createSession(info, readInput);
  app.session = session;
  app.bot = bot;
  app.opp = info.opp;
  app.localIdx = info.idx;

  const loadouts = [];
  const names = [];
  loadouts[info.idx] = { ...profile.loadout };
  names[info.idx] = displayName();
  loadouts[1 - info.idx] = { ...defaultLoadout(), ...(info.opp?.loadout || {}) };
  names[1 - info.idx] = (info.opp?.name || 'OPPONENT').slice(0, 12);

  const brDef = matchBrainrot(info.seed);
  app.view.setMatch({ localIdx: info.idx, loadouts, names, brainrotId: brDef.id });
  ui.setMapName(app.map.name);
  ui.setMatchNames(names[0], names[1]);
  ui.setScores(0, 0);
  ui.setHolder(-1);
  ui.setTime(CFG.ROUND_TIME);

  session.on('ended', onRoundEnded);
  session.on('peerLeft', onPeerLeft);
  session.on('emote', ({ who, id }) => { app.view.emote[who] = { id, t: 1.1 }; });

  ui.show('hud');
  app.view.showPlates(true);
  session.start();
  bot?.start();

  setIntensity(0);
  if (getSetting('music')) startMusic(info.seed);
  ui.toastInfo(`Objective: ${brDef.name}`);
}

function pickDifficulty() {
  const lvl = levelInfo().level;
  if (lvl < 3) return 'chill';
  if (lvl < 9) return 'normal';
  return 'sweaty';
}

function endSession() {
  if (app.bot) { app.bot.dispose(); app.bot = null; }
  if (app.session) { app.session.dispose(); app.session = null; }
  stopMusic(0.3);
  setIntensity(0);
}

function backToMenu() {
  endSession();
  app.mode = 'menu';
  app.ui.show('menu');
  if (getSetting('music') && app.hostAudioOk !== false) startMenuMusic();
}

function onPeerLeft() {
  const s = app.session;
  if (!s || s.finished) return;
  app.ui.toast('OPPONENT LEFT!', 'info');
  if (s instanceof HostSession) s.forfeit();
  else {
    s.sim.phase = 'over';
    s.sim.phaseT = 0;
    s.sim.winner = app.localIdx;
    s._finish();
  }
}

/* ============================================================
   ROUND END + REWARDS
   ============================================================ */
async function onRoundEnded(data) {
  if (app.resultShown) return;
  app.resultShown = true;

  const ui = app.ui;
  const me = data.me;
  const them = data.them;
  const won = data.winner === app.localIdx;
  const draw = data.winner === -1;

  app.input.setEnabled(false);
  setIntensity(0);
  stopMusic(0.6);
  await wait(260);

  if (won) { sfx.victory(); app.view.playVictory(app.localIdx, profile.loadout.victory); }
  else if (!draw) { /* the defeat sting plays below */ }
  else if (draw) sfx.matched();
  else { sfx.defeat(); app.view.playVictory(1 - app.localIdx, 'jump'); }

  /* --- progression --- */
  const streak = recordResult(won);
  const rewards = matchRewards({ ...me, wins: won ? 1 : 0 }, streak);
  const beforeLevel = levelInfo().level;
  addCoins(rewards.coins);
  addXp(rewards.xp);
  const { challengesCompleted, achievementsUnlocked } = applyMatchStats(me);

  /* --- a brainrot drops every round; winning tilts the odds --- */
  const rng = new RNG(((data.sim.seed ^ Date.now()) >>> 0) || 3);
  const def = rollBrainrot(rng, won ? 1.55 : 1.12);
  const isNew = collect(def.id);
  const unlocked = refreshUnlocks();
  const afterLevel = levelInfo().level;

  submitScore(me.score, { won: won ? 1 : 0, hold: Math.round(me.holdTime * 10) / 10 });

  await wait(900);
  // the menu theme returns under the results screen
  if (getSetting('music') && app.hostAudioOk !== false) startMenuMusic();
  ui.showResult({
    result: draw ? 'draw' : won ? 'win' : 'lose',
    winnerIdx: data.winner,
    myStats: me,
    theirStats: them,
    rewards,
    unlocked,
    challenges: challengesCompleted,
    achievements: achievementsUnlocked,
    newBrainrot: { def, isNew },
    levelUp: afterLevel > beforeLevel ? afterLevel : 0,
    streak,
  });
  playBrainrotSfx(def.sfx, 0.8);
  flush();
}

/* ============================================================
   FX -> presentation
   ============================================================ */
function handleFx(list, sim) {
  const ui = app.ui;
  const local = app.localIdx;
  for (const f of list) {
    switch (f.t) {
      case 'pickup': {
        const mine = f.p === local;
        if (f.steal) {
          ui.toast(mine ? 'BRAINROT STOLEN!' : 'THEY STOLE IT!', mine ? 'good' : 'steal');
          sfx.steal();
          duckMusic(0.5, 0.3);
        } else {
          ui.toast(mine ? 'YOU GOT IT!' : 'THEY GOT IT!', mine ? 'good' : '');
          sfx.pickup();
        }
        playBrainrotSfx(app.view.brainrotDef?.sfx, 0.7);
        break;
      }
      case 'hit':
        sfx.hit(f.p === local ? 1 : 0.85);
        if (getSetting('shake')) ui.flash('hit');
        if (f.v === local) sfx.bonk();
        if (f.stole) ui.toast('BONK! BRAINROT DROPPED!', 'steal');
        break;
      case 'dash':
        if (f.p === local || !f.local) sfx.dash();
        if (f.p === local) ui.fireAbility(3);
        break;
      case 'kick':
        sfx.dash();
        if (f.p === local) { ui.fireAbility(0); ui.toast('YEET!', 'good'); }
        break;
      case 'kickHit':
        sfx.hit(f.p === local ? 1 : 0.85);
        if (getSetting('shake')) ui.flash('hit');
        if (f.v === local) sfx.bonk();
        if (f.p === local) ui.toast(`BONK! +${CFG.KICK_BONUS}`, 'good');
        if (f.stole) ui.toast('BRAINROT DROPPED!', 'steal');
        break;
      case 'banana':
        sfx.bounce();
        if (f.p === local) ui.fireAbility(1);
        break;
      case 'slip':
        sfx.bonk();
        if (getSetting('shake')) ui.flash('hit');
        if (f.p === local) ui.toast(`SLIPPED! +${CFG.SLIP_BONUS}`, 'good');
        else if (f.v === local) ui.toast('BANANA!', 'steal');
        if (f.stole) ui.toast('BRAINROT DROPPED!', 'steal');
        break;
      case 'ult':
        sfx.golden();
        if (f.p === local) { ui.fireAbility(2); ui.bigMsg('MAGNET!'); }
        else ui.toast('THEY USED THE MAGNET!', 'steal');
        duckMusic(0.4, 0.3);
        break;
      case 'ultRip':
        sfx.steal();
        if (getSetting('shake')) ui.flash('gold');
        break;
      case 'bounce': sfx.bounce(); break;
      case 'tramp': sfx.boost(); break;
      case 'zone': break;
      case 'go': ui.bigMsg('GO!'); break;
      case 'event': {
        const def = EVENTS[f.id];
        if (!def) break;
        ui.eventBanner(def.label, def.sub);
        ui.toast('CHAOS EVENT!', 'info');
        switch (f.id) {
          case 'FRENZY': sfx.frenzy(); break;
          case 'SPEED': sfx.boost(); break;
          case 'TELEPORT': sfx.teleport(); break;
          case 'FREEZE': sfx.freeze(); break;
          case 'MEGA': sfx.megaKnock(); if (getSetting('shake')) ui.flash('hit'); break;
          case 'GOLDEN': sfx.golden(); ui.flash('gold'); break;
          default: break;
        }
        break;
      }
      case 'goldenEnd': break;
      case 'end': {
        const winner = f.winner;
        if (winner === -1) ui.bigMsg('DRAW!');
        else ui.bigMsg(winner === local ? 'YOU WIN!' : 'YOU LOSE!');
        break;
      }
      default: break;
    }
  }
  app.view.handleFx(list, sim);
}

/* ============================================================
   HUD SYNC
   ============================================================ */
function syncHud(sim) {
  const ui = app.ui;
  ui.setScores(sim.players[0].score, sim.players[1].score);
  ui.setTime(sim.timeLeft);
  ui.setHolder(sim.br.owner, sim.br.golden > 0);
  ui.setHoldBars(sim.players[0].holdTime, sim.players[1].holdTime);
  const me = sim.players[app.localIdx];
  const foe = sim.players[1 - app.localIdx];
  // abilities are pickup-gated: the button shows charges, not a countdown
  ui.setAbility(0, me.cd0, CFG.ABILITY_LOCK, me.ch0);
  ui.setAbility(1, me.cd1, CFG.ABILITY_LOCK, me.ch1);
  ui.setAbility(2, me.cd2, CFG.ABILITY_LOCK, me.ch2);
  ui.setAbility(3, me.dashCd, CFG.DASH_CD);

  /* The steal prompt is pure affordance: it appears only when a dash would
     actually connect, and vanishes the moment you drift out of range. */
  const canSteal = sim.phase === 'play'
    && sim.br.owner === 1 - app.localIdx
    && me.stunT <= 0 && me.freezeT <= 0 && me.slipT <= 0
    && Math.hypot(foe.x - me.x, foe.z - me.z) < CFG.DASH_HIT_R + 2.6
    && Math.abs(foe.y - me.y) < 2.2;
  ui.setStealPrompt(canSteal);

  if (sim.phase === 'countdown') {
    const n = Math.ceil(sim.phaseT - 0.6);
    const label = n > 0 ? String(n) : 'GO!';
    if (label !== app.lastCd) {
      app.lastCd = label;
      ui.countdown(label, n <= 0);
      sfx.countdown(Math.max(0, n));
    }
  }

  if (sim.phase === 'play') {
    setIntensity(sim.timeLeft <= 10 ? 1 : sim.timeLeft <= 25 ? 0.45 : 0.15);
    if (sim.timeLeft <= 10 && Math.ceil(sim.timeLeft) !== app.lastTick) {
      app.lastTick = Math.ceil(sim.timeLeft);
      sfx.tick();
      if (app.lastTick === 10) app.ui.toast('10 SECONDS!', 'steal');
    }
  }
}

/* ============================================================
   LOOP
   ============================================================ */
/** One frame of everything. Exposed on `app` so tooling can drive
    the game deterministically without relying on requestAnimationFrame. */
function stepFrame(dt) {
  dt = Math.min(Math.max(dt, 0), 0.1);

  app.frameAvg = app.frameAvg * 0.92 + (dt * 1000) * 0.08;
  app.fps = 1000 / Math.max(1, app.frameAvg);
  governQuality(dt);
  if (getSetting('showFps')) app.ui.setFps(app.fps, true);

  if (app.mode === 'match' && app.session) {
    // end-of-round slow motion
    const s = app.session.sim;
    const target = (s.phase === 'over' && !app.resultShown) ? 0.35 : 1;
    app.slow += (target - app.slow) * (1 - Math.exp(-7 * dt));
    const gdt = dt * app.slow;

    app.session.update(gdt);
    app.bot?.update(gdt);
    const fx = app.session.drainFx();
    if (fx.length) handleFx(fx, s);
    syncHud(s);
    app.view.render(s, gdt, { lookDelta: app.input.readLook() });
  } else {
    app.ui.tick(dt);
    app.view?.renderMenuScene(dt);
  }
}
app.step = stepFrame;

function startLoop() {
  app.last = performance.now();
  const tick = (now) => {
    app.raf = requestAnimationFrame(tick);
    const dt = (now - app.last) / 1000;
    app.last = now;
    if (app.paused) return;
    stepFrame(dt);
  };
  app.raf = requestAnimationFrame(tick);
}

function governQuality(dt) {
  if (app.qualityLock || !app.view) return;
  app.qTimer += dt;
  if (app.qTimer < 1.5) return;
  app.qTimer = 0;
  const ms = app.frameAvg;
  if (ms > 26 && app.quality > 0.36) {
    app.quality = app.quality > 0.7 ? 0.6 : 0.35;
    app.view.setQuality(app.quality);
    if (CONFIG.dev) console.info('[perf] quality ->', app.quality);
  } else if (ms < 13.5 && app.quality < 1) {
    app.quality = app.quality < 0.5 ? 0.6 : 1;
    app.view.setQuality(app.quality);
  }
}

/* ============================================================ */
addEventListener('error', (e) => console.error('[uncaught]', e.error || e.message));
addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason));

boot().catch((e) => fatal('Something broke while loading.', e));
