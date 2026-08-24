/* ============================================================
   main.js - boot, the game loop, and the round lifecycle.

   CLICK PLAY -> MATCH -> RUN -> STEAL -> CHAOS -> WIN -> AGAIN
   ============================================================ */

import { Emitter, clamp, clamp01, RNG } from './core/util.js';
import {
  initStorage, profile, displayName, setName, addCoins, addXp,
  applyMatchStats, recordResult, refreshUnlocks, collect, levelInfo,
  getSetting, setSetting, save, flush, storageBackend, store,
  levelStars, setLevelStars,
} from './core/storage.js';
import { Input } from './core/input.js';
import {
  initAudio, sfx, startMusic, startMenuMusic, stopMusic, setIntensity,
  setMusicEnabled, setSfxEnabled, duckMusic, playBrainrotSfx,
} from './core/audio.js';
import { setDetail } from './gfx/mesh.js';
import { Studio } from './gfx/studio.js';
import { GameView } from './game/view.js';
import { SoloSession, makeOpponent } from './game/solo.js';
import { setArena, mapForSeed, currentMap } from './game/arena.js';
import { levelById, starsEarned, goalText } from './data/levels.js';
import { CFG, DT, EVENTS, ABILITIES } from './game/sim.js';
import { CONFIG, yt } from './core/platform.js';
import { submitScore } from './game/scores.js';
import { matchRewards } from './data/progression.js';
import { matchBrainrot, rollBrainrot, BRAINROT_BY_ID } from './data/brainrots.js';
import { defaultLoadout } from './data/cosmetics.js';
import { UI } from './ui/ui.js';

const app = {
  ui: null, view: null, input: null, studio: null, mm: null,
  session: null, mode: 'menu',
  raf: 0, last: 0, acc: 0, frameAvg: 16.7,
  quality: 1, qualityLock: false, qTimer: 0,
  lastCd: -99, slow: 1, ending: false, resultShown: false,
  paused: false, opp: null, localIdx: 0, hostAudioOk: true,
};
globalThis.__stb = app;   // handy for debugging in the console

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   BOOT
   ============================================================ */
/**
 * Floor for how long the boot screen stays up, so the loading gags are not a
 * subliminal flash. Measured at 0: the real work already takes ~1.2s on a
 * desktop and longer on a phone, which is three or four gags - so any padding
 * on top was pure waiting. Raise it only if boot ever gets genuinely fast.
 */
const MIN_BOOT_MS = 0;

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
  await wait(180);

  ui.hideBoot();
  app.mode = 'menu';
  // A fresh player has no name, and the fallback "BRAINROT #0I71" tells an
  // opponent nothing. Ask once, right after the loading screen.
  if (!profile.name) ui.showNameEntry();
  else ui.show('menu');
  if (profile.firstRun) { profile.firstRun = false; save(); }
  /* The label under PLAY carries reachability now. The button label itself
     follows what this build is *configured* for, so a temporary outage never
     mislabels PLAY as a bot match it is not going to start. */
  startLoop();
  yt.gameReady();                // the player can interact now

  if (CONFIG.autoPractice) startMatch();

  if (CONFIG.dev) {
    console.info(`[steal-the-brainrot] save=${backend} detail=${detail.geo} ` +
      `quality=${app.quality} offline build`);
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

  // Every match is local, so PLAY simply starts one.
  ui.on('play', () => startMatch({ variant: getSetting('variant') || 'classic' }));
  ui.on('level', (id) => {
    const lv = levelById(id);
    if (lv) startMatch({ variant: lv.variant, level: lv });
  });
  ui.on('nameChosen', (n) => {
    if (n) setName(n);
    sfx.ui();
    ui.show('menu');
  });

  ui.on('cancel', () => backToMenu());
  ui.on('home', () => backToMenu());
  ui.on('again', () => startMatch({ variant: app.session?.variant || getSetting('variant') || 'classic' }));
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

  ui.on('screen', (name) => {
    // Keep simulating behind the results screen so the winner's victory
    // animation actually plays instead of cutting to the menu backdrop.
    const inArena = (name === 'hud' || name === 'result') && !!app.session;
    app.mode = inArena ? 'match' : 'menu';
    app.input.setEnabled(name === 'hud');
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
    if (k === 'music' || k === 'sfx' || k === 'mute') applyHostAudio();
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

  /* ...and it owns the mute switch while we are embedded.

     Do not cache this. Asked during boot the SDK can answer "audio is off"
     simply because it is not up yet, and the change event that would correct
     that is not guaranteed to arrive - which left the game permanently silent
     with isAudioEnabled() cheerfully reporting true. applyHostAudio re-asks
     every time instead, and the first real gesture forces one more check,
     since that is the moment the browser lets anything play. */
  applyHostAudio();
  yt.onAudioEnabledChange(() => applyHostAudio());
  const recheck = () => applyHostAudio();
  addEventListener('pointerdown', recheck, { passive: true, once: true });
  addEventListener('keydown', recheck, { passive: true, once: true });
  addEventListener('touchstart', recheck, { passive: true, once: true });

  addEventListener('resize', () => app.view?.resize());
  addEventListener('orientationchange', () => setTimeout(() => app.view?.resize(), 120));
}

/** Our own mute setting AND the host's have to agree before anything plays. */
function applyHostAudio() {
  app.hostAudioOk = yt.audioEnabled();
  const ok = app.hostAudioOk !== false;
  setMusicEnabled(ok && getSetting('music'));
  setSfxEnabled(ok && getSetting('sfx'));
}


/* ============================================================
   MATCH LIFECYCLE
   ============================================================ */
async function startMatch(opts = {}) {
  endSession();
  app.level = opts.level || null;
  app.ending = false;
  app.resultShown = false;
  app.slow = 1;
  app.lastCd = -99;

  const ui = app.ui;
  const variant = opts.variant || getSetting('variant') || 'classic';
  const seed = (opts.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
  const opp = makeOpponent(seed);
  const info = { idx: 0, seed, opp, variant };

  /* There is nobody to wait for, but the opponent card is still worth its
     beat - it is how you learn who you drew. What used to be a queue is now
     just that reveal, kept short. */
  ui.showSearch();
  ui.showOpponentFound(opp);

  /* Bake the arena during that beat rather than after it, so the work hides
     inside a pause the player is already sitting through.
     A level pins its map: rolling one from the seed would make the same level
     a different challenge on every attempt, and a 3-star run would not mean
     the same thing twice. */
  const map = setArena(opts.level ? opts.level.map : mapForSeed(seed));
  if (map) app.view.rebuildArena();
  app.map = currentMap();

  await wait(700);

  const readInput = () => app.input.read();

  const session = new SoloSession({
    idx: info.idx,
    seed,
    opp,
    variant,
    difficulty: opts.level ? opts.level.diff : pickDifficulty(),
    readInput,
  });
  app.session = session;
  app.opp = opp;
  app.localIdx = info.idx;

  const loadouts = [];
  const names = [];
  loadouts[info.idx] = { ...profile.loadout };
  names[info.idx] = displayName();
  loadouts[1 - info.idx] = { ...defaultLoadout(), ...(info.opp?.loadout || {}) };
  names[1 - info.idx] = (info.opp?.name || 'OPPONENT').slice(0, 12);

  const brDef = matchBrainrot(seed);
  app.view.setMatch({ localIdx: info.idx, loadouts, names, brainrotId: brDef.id });
  ui.setMapName(app.map.name, session.variant);
  ui.setBombMode(session.variant === 'tagbomb');
  // the magnet only works on a loose brainrot, which TAG BOMB never has
  ui.setAbilityAvailable(2, session.variant !== 'tagbomb');
  app.lastTick = -1;
  ui.setMatchNames(names[0], names[1]);
  ui.setScores(0, 0);
  ui.setHolder(-1);
  ui.setTime(CFG.ROUND_TIME);

  session.on('ended', onRoundEnded);
  session.on('emote', ({ who, id }) => { app.view.emote[who] = { id, t: 1.1 }; });

  ui.show('hud');
  app.view.showPlates(true);
  session.start();

  setIntensity(0);
  if (getSetting('music')) startMusic(seed);
  ui.toastInfo(`Objective: ${brDef.name}`);
}

function pickDifficulty() {
  const lvl = levelInfo().level;
  if (lvl < 3) return 'chill';
  if (lvl < 9) return 'normal';
  return 'sweaty';
}

function endSession() {
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

  /* Report the round to the host. Each mode is measured by its own number -
     CLASSIC has no tags and TAG BOMB awards no score - so send whichever one
     the player was actually playing for, which is also the number the HUD
     showed them all round. */
  yt.sendScore(app.session?.variant === 'tagbomb' ? (me.tags || 0) : me.score);

  /* --- level ladder --- */
  let levelResult = null;
  if (app.level) {
    const stars = starsEarned(app.level, { won, stats: me });
    const best = levelStars(app.level.id);
    if (stars > 0) setLevelStars(app.level.id, stars);
    levelResult = {
      id: app.level.id,
      name: app.level.name,
      goal: goalText(app.level),
      stars,
      best: Math.max(best, stars),
      improved: stars > best,
      // the next level only exists if this one was actually cleared
      next: stars > 0 && levelById(app.level.id + 1) ? app.level.id + 1 : 0,
    };
  }

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
    level: levelResult,
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
      case 'blast': sfx.megaKnock(); duckMusic(0.5); break;
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
  if (sim.variant === 'tagbomb') ui.setScores(sim.players[0].tags, sim.players[1].tags);
  else ui.setScores(sim.players[0].score, sim.players[1].score);
  ui.setTime(sim.timeLeft);
  ui.setHolder(sim.br.owner, sim.br.golden > 0);

  /* TAG BOMB: count the last five seconds out loud. The holder is the one
     who needs the panic, so the message is addressed to them. */
  if (sim.variant === 'tagbomb' && sim.phase === 'play') {
    const secs = Math.ceil(sim.timeLeft);
    if (secs !== app.lastTick && secs <= 5 && secs >= 1) {
      app.lastTick = secs;
      const mine = sim.br.owner === app.localIdx;
      ui.bigMsg(secs === 1 ? (mine ? 'RUN!!!' : '1!') : `\uD83D\uDCA3 ${secs}!`);
      sfx.countdown();
      if (mine) app.view.hitFlash = Math.max(app.view.hitFlash, 0.35);
    }
  }
  ui.setHoldBars(sim.players[0].holdTime, sim.players[1].holdTime);
  const me = sim.players[app.localIdx];
  const foe = sim.players[1 - app.localIdx];
  // abilities are pickup-gated: the button shows charges, not a countdown
  ui.setAbility(0, me.cd0, CFG.ABILITY_LOCK, me.ch0);
  ui.setAbility(1, me.cd1, CFG.ABILITY_LOCK, me.ch1);
  ui.setAbility(2, me.cd2, CFG.ABILITY_LOCK, me.ch2);
  ui.setAbility(3, me.dashCd, CFG.DASH_CD);


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
  governQuality(dt);

  if (app.mode === 'match' && app.session) {
    // end-of-round slow motion
    const s = app.session.sim;
    const target = (s.phase === 'over' && !app.resultShown) ? 0.35 : 1;
    app.slow += (target - app.slow) * (1 - Math.exp(-7 * dt));
    const gdt = dt * app.slow;

    app.session.update(gdt);
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
