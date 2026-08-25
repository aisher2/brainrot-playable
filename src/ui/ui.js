/* ============================================================
   ui.js - every screen, the HUD, and the glue to the profile.

   Emits intents ('play', 'again', 'home', 'cancel',
   'emote', 'setting') and never touches the game directly.
   ============================================================ */

import { Emitter, clamp01, fmtTime, pad2 } from '../core/util.js';
import {
  profile, store, levelInfo, displayName, setName, tryEquip, isUnlocked,
  todaysChallenges, achievementList,
  collectedCount, setSetting, getSetting, save,
  levelStars, levelUnlocked, totalStars,
} from '../core/storage.js';
import { BRAINROTS, RARITY, RARITY_ORDER, BRAINROT_BY_ID } from '../data/brainrots.js';
import { SLOTS, findItem, unlockText } from '../data/cosmetics.js';
import { msUntilMidnight, xpForLevel, MAX_LEVEL } from '../data/progression.js';
import { LEVELS, LEVEL_COUNT, goalText } from '../data/levels.js';
import { fetchBoard } from '../game/scores.js';
import { CONFIG } from '../core/platform.js';
import { sfx } from '../core/audio.js';

const $ = (id) => document.getElementById(id);
/**
 * Build an element with TEXT content. Safe by default on purpose: player
 * names arrive from the leaderboard API, which anyone can write to, and an
 * innerHTML default meant a name could inject markup into every other
 * player's screen. Use elHtml only for markup this file authors itself.
 */
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Same, but the content is trusted markup written here - never user data. */
const elHtml = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

/* ---------------------------------------------------------------
   Loading screen gags. The progress bar stays honest - only the
   commentary is nonsense. All original; shuffled every launch so
   two boots never read the same.
   --------------------------------------------------------------- */
const BOOT_GAGS = [
  'waking up 28 idiots', 'negotiating with the brainrot', 'inflating the banana supply',
  'teaching the bot to lose gracefully', 'hiding the good hats', 'bribing the physics',
  'polishing four thousand tiny cubes', 'asking the arena to hold still',
  'measuring everyone grip strength', 'untangling the confetti', 'feeding the magnet',
  'stretching before the brawl', 'printing one (1) brainrot', 'gluing the hats on',
  'rehearsing the victory dance', 'making the floor slightly worse',
  'hiding bananas in tactical locations', 'explaining "steal" to the bot',
  'double knotting everyone laces', 'loading exactly enough chaos',
  'counting the bananas twice', 'yelling at the shaders', 'giving everyone the same legs',
  'sharpening the kick', 'checking nobody brought a real weapon',
  'convincing the camera to behave', 'installing extra nonsense',
  'arguing about the rules', 'warming up the slip animation', 'buffing the shiny bits',
];

const BOOT_TIPS = [
  ['TIP', 'dash into people. that is the whole tip.'],
  ['FACT', 'the brainrot does not care who you are.'],
  ['TIP', 'bananas are a war crime. use them anyway.'],
  ['FACT', 'holding it for twenty seconds counts as a personality.'],
  ['TIP', 'the last ten seconds decide everything. panic accordingly.'],
  ['FACT', 'nobody has ever slipped on a banana on purpose.'],
  ['TIP', 'kick first. apologise never.'],
  ['FACT', 'the magnet is not magnetic. it is worse.'],
  ['TIP', 'you can steal it back. you will need to.'],
  ['FACT', 'every hat is load bearing.'],
  ['TIP', 'standing still is a bold strategy and a bad one.'],
  ['FACT', 'the floor is only mostly solid.'],
];

const BOOT_FACES = ['🧠', '🍌', '👑', '🦵', '💨', '😵', '🤪', '🤯', '🥴'];

const SCREENS = ['menu', 'search', 'hud', 'result', 'collect', 'custom', 'board', 'quests', 'settings', 'levels', 'howto'];

/** rAF, but with a timer fallback: background tabs stop firing rAF and
    thumbnails would then never appear. */
function nextFrame(fn) {
  let done = false;
  const go = () => { if (!done) { done = true; fn(); } };
  requestAnimationFrame(go);
  setTimeout(go, 40);
}

export class UI extends Emitter {
  constructor(studio) {
    super();
    this.studio = studio;
    this.current = '';
    this.stack = [];
    this.customTab = 'skin';
    this.rarityFilter = 'all';
    this.thumbQueue = [];
    this.thumbTimer = 0;
    this.previewT = 0;
    this.toastCd = 0;
    this.lastScores = [0, 0];
    this.names = ['PLAYER 1', 'PLAYER 2'];
    this._soloTimer = 0;
    this._searchBase = '';
    this._bind();
  }

  /* ==================================================== boot */
  setLoading(pct, text) {
    const p = clamp01(pct);
    const f = $('loadfill');
    if (f) f.style.width = Math.round(p * 100) + '%';
    const n = $('bootPct');
    if (n) n.textContent = Math.round(p * 100) + '%';
    // The gag reel owns the caption while it is running; the real stage text
    // is the fallback so the screen still says something sensible without it.
    if (text && !this._bootTimer) { const t = $('loadtxt'); if (t) t.textContent = text; }
    if (p >= 1) {
      this.stopBootGags();
      const t = $('loadtxt');
      if (t) { t.textContent = 'brainrot achieved'; t.classList.add('pop'); }
    }
  }

  /** Rotating nonsense + a cycling mascot, so the wait is worth watching. */
  startBootGags() {
    const tip = $('bootTip');
    if (tip) {
      const [k, line] = BOOT_TIPS[(Math.random() * BOOT_TIPS.length) | 0];
      tip.innerHTML = '';
      const b = el('b', '', k);
      tip.appendChild(b);
      tip.appendChild(document.createTextNode(' · ' + line));
    }
    const bag = BOOT_GAGS.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
    let i = 0;
    const step = () => {
      const t = $('loadtxt');
      if (t) {
        t.textContent = bag[i % bag.length];
        t.classList.remove('pop');
        void t.offsetWidth;                 // restart the pop
        t.classList.add('pop');
      }
      const face = $('bootBrain');
      if (face && i % 2 === 1) face.textContent = BOOT_FACES[((i >> 1) + 1) % BOOT_FACES.length];
      i++;
    };
    step();
    this._bootTimer = setInterval(step, 430);
  }

  stopBootGags() {
    if (this._bootTimer) { clearInterval(this._bootTimer); this._bootTimer = 0; }
  }

  hideBoot() {
    this.stopBootGags();
    const b = $('boot');
    if (!b) return;
    b.style.transition = 'opacity .35s ease';
    b.style.opacity = '0';
    setTimeout(() => { b.remove(); }, 400);
    const ui = $('ui');
    if (ui) ui.hidden = false;
  }

  /* ==================================================== screens */
  show(name, opts = {}) {
    if (!SCREENS.includes(name)) return;
    for (const s of SCREENS) {
      const e = $('s-' + s);
      if (e) e.classList.toggle('show', s === name);
    }
    const prev = this.current;
    this.current = name;
    if (opts.push && prev) this.stack.push(prev);
    if (!opts.push) this.stack.length = 0;

    switch (name) {
      case 'menu':     this.renderMenu(); break;
      case 'collect':  this.renderCollection(); break;
      case 'custom':   this.renderCustomize(); break;
      case 'board':    this.renderBoard(); break;
      case 'quests':   this.renderQuests(); break;
      case 'levels':   this.renderLevels(); break;
      case 'settings': this.renderSettings(); break;
      default: break;
    }
    this.emit('screen', name);
  }

  back() {
    sfx.back();
    const prev = this.stack.pop();
    this.show(prev || 'menu');
  }

  /* ==================================================== binding */
  _bind() {
    const click = (id, fn) => {
      const e = $(id);
      if (e) e.addEventListener('click', (ev) => { ev.preventDefault(); sfx.ui(); fn(ev); });
    };

    click('btnPlay', () => this.emit('play'));
    click('btnBrainrots', () => this.show('collect', { push: true }));
    click('btnCustomize', () => this.show('custom', { push: true }));
    click('btnBoard', () => this.show('board', { push: true }));
    click('btnQuests', () => this.show('quests', { push: true }));
    click('btnSettings', () => this.show('settings', { push: true }));
    click('btnCancelSearch', () => this.emit('cancel'));
    click('btnLevels', () => this.show('levels', { push: true }));
    click('btnHowTo', () => this.showHowTo());
    click('btnSignNext', () => this._sign(1));
    click('btnSignSkip', () => this._signDone());
    for (const b of document.querySelectorAll('#modePick button')) {
      b.addEventListener('click', () => {
        setSetting('variant', b.dataset.v);
        this._refreshMode();
        sfx.ui();
      });
    }
    this._refreshMode();
    const nameInput = $('nameInput');
    if (nameInput) {
      nameInput.addEventListener('input', () => {
        setName(nameInput.value);
        const pv = $('pvName');
        if (pv) pv.textContent = displayName();
      });
      nameInput.addEventListener('blur', () => { nameInput.value = profile.name; save(true); });
    }

    // Escape / browser back closes a sheet
    addEventListener('keydown', (e) => {
      if (e.code !== 'Escape') return;
      if (['collect', 'custom', 'board', 'quests', 'settings'].includes(this.current)) this.back();
    });

    store.on('coins', () => this._refreshCoins());
    store.on('xp', () => this._refreshLevel());
  }

  /* ==================================================== menu */
  renderMenu() {
    this._refreshLevel();
    const q = $('questsLabel');
    if (q) {
      const pending = todaysChallenges().filter((c) => c.done).length;
      q.textContent = pending ? `QUESTS (${pending})` : 'QUESTS';
    }
  }

  /** highlight the chosen mode and say in one line what it is */
  _refreshMode() {
    const want = getSetting('variant') || 'classic';
    for (const b of document.querySelectorAll('#modePick button')) {
      b.classList.toggle('on', b.dataset.v === want);
    }
    const blurb = $('modeBlurb');
    if (blurb) {
      blurb.textContent = want === 'tagbomb'
        ? '2 PLAYERS \u00b7 CHASE \u00b7 TAG \u00b7 SURVIVE'
        : 'HOLD THE BRAINROT THE LONGEST';
    }
  }

  /** TAG BOMB reads its countdown as a fuse, not a round clock. */
  setBombMode(on) {
    this.bombMode = !!on;
    const hud = $('s-hud');
    if (hud) hud.classList.toggle('bomb', !!on);
    const t = $('timerBox');
    if (t) t.classList.toggle('bomb', !!on);
    const lab = t?.querySelector('small');
    if (lab) lab.textContent = on ? '\uD83D\uDCA3 FUSE' : 'TIME';
  }



  setPlaySub(text) { const e = $('playSub'); if (e) e.textContent = text; }

  _refreshLevel() {
    const li = levelInfo();
    // same rule for the level track: 60 is the end of it, so say so
    const n = $('lvlNum'); if (n) n.textContent = li.level >= MAX_LEVEL ? li.level + ' MAX' : li.level;
    const who = $('lvlWho'); if (who) who.textContent = displayName();
    const f = $('xpFill'); if (f) f.style.width = Math.round(li.pct * 100) + '%';
    this._refreshCoins();
  }

  _refreshCoins() {
    const c = $('coinCount');
    if (c) c.textContent = profile.coins + ' 🧠';
  }

  /* ==================================================== who are you */
  /** First run asks for a name; the menu chip reopens this any time. */
  /* ==================================================== matchmaking */
  /* Once a queue, now purely the moment you meet your opponent. Nothing is
     being waited for, so there is no timer, no "looking for a player", and
     no offer of a bot as a consolation - the bot is who you came to play. */
  showSearch() {
    this.show('search');
    const title = $('searchTitle');
    if (title) { title.textContent = 'FINDING AN OPPONENT...'; title.classList.remove('found'); }
    const foe = $('mmFoeCard');
    if (foe) foe.classList.remove('found');
    const fa = $('mmFoeAv'); if (fa) fa.textContent = '?';
    const fn = $('mmFoeName'); if (fn) fn.textContent = '...';
    const me = $('mmMeName'); if (me) me.textContent = displayName();
    const av = $('mmMeAv');
    if (av) av.textContent = FACE_EMOJI[profile.loadout.face] || '🙂';
    this.setSearchSub('');
  }

  setSearchSub(text) {
    const e = $('searchSub');
    if (e) { e.textContent = text; this._searchBase = text; }
  }



  showOpponentFound(opp) {
    const title = $('searchTitle');
    if (title) { title.textContent = 'OPPONENT FOUND!'; title.classList.add('found'); }
    const foe = $('mmFoeCard');
    if (foe) foe.classList.add('found');
    const fa = $('mmFoeAv');
    if (fa) fa.textContent = opp?.loadout ? (FACE_EMOJI[opp.loadout.face] || '😈') : '😈';
    const fn = $('mmFoeName');
    if (fn) fn.textContent = (opp?.name || 'OPPONENT').slice(0, 12);
    // there is only ever one kind of opponent now, so introduce it plainly
    this.setSearchSub('level ' + (opp?.level || 1));
    sfx.matched();
  }

  /* ==================================================== HUD */
  /** announce the arena at the top of the round, then fade it away */
  setMapName(name, variant) {
    const e = $('mapChip');
    if (!e) return;
    e.textContent = variant === 'tagbomb'
      ? `\uD83D\uDCA3 TAG BOMB \u00b7 ${name}`
      : (name || '');
    e.classList.toggle('potato', variant === 'tagbomb');
    e.classList.remove('on');
    void e.offsetWidth;                 // restart the animation
    if (name) e.classList.add('on');
  }

  setMatchNames(a, b) {
    this.names = [a, b];
    const n1 = document.querySelector('#scoreP1 .nm');
    const n2 = document.querySelector('#scoreP2 .nm');
    if (n1) n1.textContent = a;
    if (n2) n2.textContent = b;
  }

  setScores(a, b) {
    for (const [i, v] of [[0, a], [1, b]]) {
      const box = $('scoreP' + (i + 1));
      if (!box) continue;
      const s = box.querySelector('.sc');
      if (s && s.textContent !== String(v)) {
        s.textContent = v;
        if (v > this.lastScores[i]) {
          box.classList.remove('bump');
          void box.offsetWidth;
          box.classList.add('bump');
        }
      }
      this.lastScores[i] = v;
    }
  }

  setHoldBars(a, b) {
    const t = Math.max(1, a + b);
    const e1 = document.querySelector('#scoreP1 .hold');
    const e2 = document.querySelector('#scoreP2 .hold');
    if (e1) e1.style.width = (a / t * 100) + '%';
    if (e2) e2.style.width = (b / t * 100) + '%';
  }

  setTime(sec) {
    const n = $('timeNum');
    const v = Math.ceil(sec);
    if (n && n.textContent !== String(v)) n.textContent = v;
    const box = $('timerBox');
    if (box) box.classList.toggle('warn', sec <= 10.001);
  }

  setHolder(idx, golden) {
    const bar = $('holderBar');
    const txt = $('holderTxt');
    if (!bar || !txt) return;
    bar.classList.remove('p1', 'p2', 'loose');
    if (idx < 0) {
      bar.classList.add('loose');
      txt.textContent = 'BRAINROT IS LOOSE - GRAB IT!';
    } else {
      bar.classList.add(idx === 0 ? 'p1' : 'p2');
      txt.textContent = this.bombMode
        ? `\uD83D\uDCA3 ${this.names[idx]} HAS THE BOMB`
        : (golden ? '\uD83D\uDC51 2x - ' : 'BRAINROT HOLDER: ') + this.names[idx];
    }
    for (let i = 0; i < 2; i++) {
      const box = $('scoreP' + (i + 1));
      if (box) box.classList.toggle('owner', idx === i);
    }
  }

  toast(text, kind = '') {
    const host = $('toasts');
    if (!host) return;
    const t = el('div', 'toast ' + kind, text);
    host.appendChild(t);
    setTimeout(() => t.remove(), 1600);
    while (host.children.length > 3) host.firstChild.remove();
  }

  bigMsg(text) {
    const e = $('bigMsg');
    if (!e) return;
    e.textContent = text;
    e.classList.remove('on');
    void e.offsetWidth;
    e.classList.add('on');
  }

  countdown(label, isGo) {
    const e = $('countdown');
    if (!e) return;
    e.textContent = label;
    e.classList.remove('tick', 'go');
    void e.offsetWidth;
    e.classList.add(isGo ? 'go' : 'tick');
  }

  eventBanner(label, sub) {
    const e = $('eventBanner');
    if (!e) return;
    e.innerHTML = label + (sub ? `<div style="font-size:.4em;-webkit-text-stroke:3px var(--ink);opacity:.9">${sub}</div>` : '');
    e.classList.remove('on');
    void e.offsetWidth;
    e.classList.add('on');
  }

  /* ==================================================== abilities */
  _ability(i) {
    if (!this._abtns) this._abtns = [$('btnA0'), $('btnA1'), $('btnA2'), $('btnDash')];
    return this._abtns[i];
  }

  /**
   * One readout per ability: a conic sweep that unwinds, the seconds left,
   * and a green ring the moment it is usable again. This is the only
   * cooldown information a touch player gets, so it is never hidden.
   */
  setAbility(i, cd, max, charges) {
    const b = this._ability(i);
    if (!b) return;
    const pickup = typeof charges === 'number';
    const cooling = cd > 0.05;

    if (pickup) {
      // Pickup-gated: the readout is how many you have banked, not a timer.
      const had = b.dataset.charges | 0;
      if (had !== charges) {
        b.dataset.charges = String(charges);
        b.querySelector('.cnt').textContent = String(charges);
        if (charges > had) {
          b.classList.remove('gained');
          void b.offsetWidth;
          b.classList.add('gained');
          if (had === 0 && this._readyAnnounce) this._readyAnnounce(i);
        }
      }
      const usable = charges > 0 && !cooling;
      b.classList.toggle('empty', charges === 0);
      b.classList.toggle('has', charges > 0);
      b.classList.toggle('ready', usable);
      b.classList.toggle('cooling', false);
      b.dataset.ready = usable ? '1' : '0';
      return;
    }

    const wasReady = b.dataset.ready === '1';
    b.classList.toggle('cooling', cooling);
    b.classList.toggle('ready', !cooling);
    if (cooling) {
      const cdEl = b.querySelector('.cd');
      cdEl.style.setProperty('--sweep', (360 * (cd / max)).toFixed(0) + 'deg');
      const txt = cd >= 1 ? String(Math.ceil(cd)) : cd.toFixed(1);
      if (cdEl.textContent !== txt) cdEl.textContent = txt;
      b.dataset.ready = '0';
    } else if (!wasReady) {
      b.dataset.ready = '1';
      b.querySelector('.cd').textContent = '';
      if (this._readyAnnounce) this._readyAnnounce(i);
    }
  }

  /** Hide an ability the current mode does not use at all. */
  setAbilityAvailable(i, on) {
    const b = this._ability(i);
    if (b) b.hidden = !on;
  }

  /** flash the button when its ability actually fires */
  fireAbility(i) {
    const b = this._ability(i);
    if (!b) return;
    b.classList.remove('fired');
    void b.offsetWidth;
    b.classList.add('fired');
  }

  onAbilityReady(fn) { this._readyAnnounce = fn; }

  setDashReady(ready) { /* handled by setAbility(3, ...) */ }



  flash(kind) {
    const f = $('fx-flash');
    if (!f) return;
    f.className = '';
    void f.offsetWidth;
    f.className = kind;
  }

  /* ==================================================== results */
  /**
   * A level round is judged on its own goal, not just on who won: you can
   * take the round and still miss a SCORE target, so say which it was.
   */
  _levelOutcome(lv) {
    const host = $('resultLevel');
    if (!host) return;
    host.textContent = '';
    host.hidden = !lv;
    if (!lv) return;

    host.appendChild(el('span', 'rl-name', 'LEVEL ' + lv.id + ' · ' + lv.name));
    const row = el('span', 'rl-stars');
    for (let i = 0; i < 3; i++) row.appendChild(el('i', i < lv.stars ? 'on' : '', '★'));
    host.appendChild(row);
    host.appendChild(el('span', 'rl-note',
      lv.stars === 0 ? 'GOAL MISSED · ' + lv.goal
        : lv.improved ? (lv.next ? 'CLEARED · LEVEL ' + lv.next + ' UNLOCKED' : 'CLEARED')
        : 'BEST ' + lv.best + '/3'));
  }

  showResult(data) {
    this.show('result');
    const { result, myStats, theirStats, rewards, unlocked, challenges, achievements, newBrainrot, levelUp } = data;
    this._levelOutcome(data.level);

    const crown = $('resultCrown');
    const title = $('resultTitle');
    const who = $('winnerName');
    title.classList.remove('lose', 'draw');
    if (result === 'win') { crown.textContent = '🏆'; title.textContent = 'WINNER!'; }
    else if (result === 'draw') { crown.textContent = '🤝'; title.textContent = 'DRAW!'; title.classList.add('draw'); }
    else { crown.textContent = '💀'; title.textContent = 'DEFEAT'; title.classList.add('lose'); }
    who.textContent = result === 'draw' ? 'NOBODY WINS' : (result === 'win' ? displayName() : this.names[data.winnerIdx] || 'OPPONENT');

    const grid = $('statGrid');
    grid.innerHTML = '';
    const stat = (label, val) => {
      const d = el('div', 'st');
      d.appendChild(el('small', '', label));
      d.appendChild(el('b', '', val));
      grid.appendChild(d);
    };
    stat('SCORE', String(myStats.score));
    stat('OPPONENT', String(theirStats.score));
    stat('BRAINROT TIME', myStats.holdTime.toFixed(1) + 's');
    stat('LONGEST HOLD', myStats.longestHold.toFixed(1) + 's');
    stat('STEALS', String(myStats.steals));
    stat('DASH HITS', String(myStats.dashHits));

    const list = $('rewardList');
    list.innerHTML = '';
    let delay = 0;
    // a monster round can unlock a lot at once; keep the screen a screen
    const MAX_ROWS = 6;
    let hidden = 0;
    const row = (label, val, cls = '') => {
      if (list.children.length >= MAX_ROWS) { hidden++; return; }
      const d = elHtml('div', 'rw ' + cls, `<span>${label}</span><b>${val}</b>`);
      d.style.animationDelay = delay.toFixed(2) + 's';
      delay += 0.07;
      list.appendChild(d);
    };
    row('COINS EARNED', '+' + rewards.coins + ' 🧠', 'gold');
    row('XP EARNED', '+' + rewards.xp + ' XP');
    if (data.streak > 1) row('WIN STREAK', '🔥 ' + data.streak);
    if (newBrainrot) {
      row(`${newBrainrot.isNew ? 'NEW ' : ''}BRAINROT: ${newBrainrot.def.name}`,
        RARITY[newBrainrot.def.rarity].name, newBrainrot.isNew ? 'new' : '');
    }
    if (levelUp) row('LEVEL UP!', 'LV ' + levelUp, 'new');
    for (const c of challenges || []) row('CHALLENGE: ' + c.text, '+' + c.coins + ' 🧠', 'new');
    for (const a of achievements || []) row('ACHIEVEMENT: ' + a.name, '+' + a.coins + ' 🧠', 'new');
    for (const u of unlocked || []) row('UNLOCKED: ' + u.item.name, u.slot.toUpperCase(), 'new');
    if (hidden) list.appendChild(el('div', 'rw more', `+${hidden} MORE - SEE QUESTS &amp; CUSTOMIZE`));

    this._refreshLevel();
  }

  /* ==================================================== collection */
  renderLevels() {
    const host = $('levelGrid');
    if (!host) return;
    host.textContent = '';
    const total = $('starCount');
    if (total) total.textContent = '⭐ ' + totalStars() + '/' + (LEVEL_COUNT * 3);

    for (const lv of LEVELS) {
      const stars = levelStars(lv.id);
      const open = levelUnlocked(lv.id);
      const tile = el('button', 'lvltile' + (open ? '' : ' locked') + (stars ? ' done' : ''));
      tile.disabled = !open;

      tile.appendChild(el('b', 'lvlno', open ? String(lv.id) : '🔒'));
      tile.appendChild(el('span', 'lvlname', open ? lv.name : 'LOCKED'));
      tile.appendChild(el('span', 'lvlgoal',
        open ? (lv.variant === 'tagbomb' ? '💣 ' : '🧠 ') + goalText(lv) : ''));
      // three slots always, so a tile does not change height once it is cleared
      const row = el('span', 'lvlstars');
      for (let i = 0; i < 3; i++) row.appendChild(el('i', i < stars ? 'on' : '', '★'));
      tile.appendChild(row);

      if (open) tile.addEventListener('click', () => { sfx.ui(); this.emit('level', lv.id); });
      host.appendChild(tile);
    }
  }

  /* ---------------------------------------------------- how to play */
  /* Six signs, in the order a new player needs them: what the thing in the
     middle is, how to move, how to take it back, then the mode that inverts
     the whole idea. Kept to one sentence each - anything longer and it stops
     being a signpost and starts being a manual. */
  _signs() {
    const touch = this.input?.touchMode ?? matchMedia('(pointer:coarse)').matches;
    return [
      { i: '🧠', t: 'GRAB THE BRAINROT',
        b: 'It starts in the middle of the arena. Get there first.' },
      { i: '🕹', t: touch ? 'DRAG TO MOVE' : 'WASD TO MOVE',
        b: touch ? 'The stick is bottom-left. Drag it any direction.'
                 : 'Arrow keys work too. Drag the screen to look around.' },
      { i: '🏆', t: 'HOLD IT TO SCORE',
        b: 'Every second you carry the brainrot is a point. Keep it.' },
      { i: '💨', t: touch ? 'TAP DASH TO CHARGE' : 'SPACE TO DASH',
        b: 'Slam into the carrier to knock it loose and take it.' },
      { i: '🦵', t: touch ? 'TAP AN ABILITY' : 'Q, E AND R',
        b: 'Yeet kick, banana, magnet. They all buy you a few seconds.' },
      { i: '💣', t: 'TAG BOMB IS THE OPPOSITE',
        b: 'You do NOT want it. Touch your opponent to pass it on.' },
    ];
  }

  showHowTo() {
    this.signIdx = 0;
    this.show('howto', { push: true });
    this._renderSign();
  }

  _sign(step) {
    const list = this._signs();
    this.signIdx = (this.signIdx || 0) + step;
    if (this.signIdx >= list.length) { this._signDone(); return; }
    sfx.ui();
    this._renderSign();
  }

  _signDone() {
    sfx.ui();
    this.emit('howToDone');
    this.show('menu');
  }

  _renderSign() {
    const list = this._signs();
    const n = Math.max(0, Math.min(this.signIdx || 0, list.length - 1));
    const s = list[n];
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('signStep', (n + 1) + ' / ' + list.length);
    set('signIco', s.i);
    set('signTitle', s.t);
    set('signBody', s.b);

    const card = $('signCard');
    if (card) { card.classList.remove('swing'); void card.offsetWidth; card.classList.add('swing'); }

    const last = n === list.length - 1;
    const next = $('btnSignNext');
    if (next) next.querySelector('span').textContent = last ? "LET'S GO" : 'NEXT';
    const skip = $('btnSignSkip');
    if (skip) skip.hidden = last;

    const dots = $('signDots');
    if (dots) {
      dots.textContent = '';
      for (let k = 0; k < list.length; k++) dots.appendChild(el('i', k === n ? 'on' : ''));
    }
  }

  renderCollection() {
    const filters = $('rarityFilters');
    if (filters && !filters.children.length) {
      const mk = (id, label) => {
        const b = el('button', id === this.rarityFilter ? 'on' : '', label);
        b.addEventListener('click', () => {
          this.rarityFilter = id;
          for (const c of filters.children) c.classList.toggle('on', c === b);
          this._fillCollection();
          sfx.ui();
        });
        filters.appendChild(b);
      };
      mk('all', 'ALL');
      for (const r of RARITY_ORDER) mk(r, RARITY[r].name);
    }
    const count = $('collectCount');
    /* Playables requires the game to say when there is nothing further to
       unlock, rather than leaving a full bar to imply more is coming. */
    if (count) {
      const got = collectedCount();
      count.textContent = got >= BRAINROTS.length
        ? got + '/' + BRAINROTS.length + ' · ALL COLLECTED'
        : got + '/' + BRAINROTS.length;
    }
    this._fillCollection();
  }

  _fillCollection() {
    const grid = $('collectGrid');
    if (!grid) return;
    grid.innerHTML = '';
    this.thumbQueue.length = 0;
    const list = this.rarityFilter === 'all'
      ? BRAINROTS
      : BRAINROTS.filter((b) => b.rarity === this.rarityFilter);

    for (const b of list) {
      const owned = !!profile.collection[b.id];
      const card = el('div', `card r-${b.rarity}` + (owned ? '' : ' locked'));
      const thumb = el('div', 'thumb');
      const img = el('img');
      img.alt = b.name;
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
      thumb.appendChild(img);
      card.appendChild(thumb);
      card.appendChild(el('div', 'nm', owned ? b.name : '???'));
      card.appendChild(el('div', 'rar', RARITY[b.rarity].name + (owned ? ` x${profile.collection[b.id]}` : '')));
      card.addEventListener('click', () => {
        sfx.ui();
        if (owned) this.toastInfo(b.name + ' - ' + b.blurb);
        else this.toastInfo('Not collected yet. Win matches to find it!');
      });
      grid.appendChild(card);
      this.thumbQueue.push({ img, id: b.id, owned });
    }
    this._pumpThumbs();
  }

  _pumpThumbs() {
    if (!this.studio || !this.studio.ok) return;
    // each shot is a real render + encode (~6ms), so two per frame keeps the
    // grid filling visibly without ever stalling a frame
    const step = () => {
      let n = 0;
      while (this.thumbQueue.length && n < 2) {
        const job = this.thumbQueue.shift();
        const url = this.studio.brainrotShot(job.id, job.owned ? '' : 'decoy');
        if (url) job.img.src = url;
        n++;
      }
      if (this.thumbQueue.length) nextFrame(step);
    };
    nextFrame(step);
  }

  toastInfo(text) {
    const host = $('toasts');
    if (!host) return;
    const t = el('div', 'toast info', text);
    t.style.fontSize = 'clamp(11px,3.4vw,17px)';
    t.style.maxWidth = '86vw';
    host.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  /* ==================================================== customize */
  renderCustomize() {
    const tabs = $('customTabs');
    if (tabs) {
      tabs.innerHTML = '';
      for (const s of SLOTS) {
        const b = el('button', s.key === this.customTab ? 'on' : '', s.label);
        b.addEventListener('click', () => {
          this.customTab = s.key;
          sfx.ui();
          this.renderCustomize();
        });
        tabs.appendChild(b);
      }
    }
    const nameInput = $('nameInput');
    if (nameInput) nameInput.value = profile.name;
    const pv = $('pvName');
    if (pv) pv.textContent = displayName();
    this._refreshCoins();
    this._fillCustomGrid();
  }

  _fillCustomGrid() {
    const grid = $('customGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const slot = SLOTS.find((s) => s.key === this.customTab) || SLOTS[0];
    const jobs = [];
    for (const item of slot.list) {
      const owned = isUnlocked(slot.key, item.id);
      const equipped = profile.loadout[slot.key] === item.id;
      const card = el('div', `card r-${item.rarity || 'common'}${owned ? '' : ' locked'}${equipped ? ' equipped' : ''}`);
      const thumb = el('div', 'thumb');

      if (slot.key === 'skin' || slot.key === 'hat' || slot.key === 'face') {
        const img = el('img');
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
        thumb.appendChild(img);
        jobs.push({ img, slot: slot.key, id: item.id });
      } else {
        thumb.appendChild(el('div', '', SLOT_ICON(slot.key, item)));
        thumb.firstChild.style.cssText = 'font-size:30px;line-height:1';
      }
      card.appendChild(thumb);
      card.appendChild(el('div', 'nm', item.name));
      card.appendChild(el('div', owned ? 'rar' : 'cost', owned ? RARITY[item.rarity || 'common'].name : unlockText(item)));

      card.addEventListener('click', () => {
        const res = tryEquip(slot.key, item.id);
        if (res === 'poor') { sfx.error(); this.toastInfo('Not enough 🧠 - go win some matches!'); return; }
        if (res === 'locked') { sfx.error(); this.toastInfo(item.unlock?.type === 'level' ? `Unlocks at level ${item.unlock.lvl}` : 'Locked behind an achievement'); return; }
        if (res === 'bought') sfx.unlock(); else sfx.ui();
        this.renderCustomize();
        this.emit('loadout');
      });
      grid.appendChild(card);
    }
    if (this.studio?.ok && jobs.length) {
      const base = { ...profile.loadout };
      const step = () => {
        let n = 0;
        while (jobs.length && n < 2) {
          const j = jobs.shift();
          const url = this.studio.itemShot(j.slot, j.id, base);
          if (url) j.img.src = url;
          n++;
        }
        if (jobs.length) nextFrame(step);
      };
      nextFrame(step);
    }
  }

  /** animated 3D preview; driven from the main loop */
  tick(dt) {
    if (this.current !== 'custom' || !this.studio?.ok) return;
    this.previewT += dt;
    this.studio.drawPreview($('previewCanvas'), profile.loadout, this.previewT);
  }

  /* ==================================================== leaderboard */
  async renderBoard() {
    const list = $('boardList');
    if (!list) return;
    list.innerHTML = '<div class="row"><span class="who">loading...</span></div>';
    const { scope, rows } = await fetchBoard('score');
    const scopeEl = $('boardScope');
    if (scopeEl) scopeEl.textContent = scope;
    list.innerHTML = '';
    if (!rows.length) {
      list.appendChild(elHtml('div', 'row', '<span class="who">No scores yet. Go steal something.</span>'));
      return;
    }
    rows.forEach((r, i) => {
      const row = el('div', 'row' + (r.me ? ' me' : '') + (i === 0 ? ' top1' : ''));
      row.appendChild(el('span', 'rk', i === 0 ? '👑' : '#' + (i + 1)));
      row.appendChild(el('span', 'who', r.name));
      row.appendChild(el('span', 'val', r.score + ' 🧠'));
      list.appendChild(row);
    });
  }

  /* ==================================================== quests */
  renderQuests() {
    const daily = $('dailyList');
    const ach = $('achList');
    const reset = $('questReset');
    if (reset) {
      const ms = msUntilMidnight();
      reset.textContent = 'resets in ' + pad2(Math.floor(ms / 3600000)) + ':' + pad2(Math.floor(ms / 60000) % 60);
    }
    const mk = (host, items) => {
      host.innerHTML = '';
      for (const q of items) {
        const d = el('div', 'quest' + (q.done ? ' done' : ''));
        d.appendChild(el('div', 't',
          `<span>${q.text || q.name}</span><em>${q.done ? '✓ DONE' : '+' + q.coins + ' 🧠'}</em>`));
        const pb = el('div', 'pb');
        const fill = el('i');
        fill.style.width = Math.round(clamp01(q.value / q.goal) * 100) + '%';
        pb.appendChild(fill);
        d.appendChild(pb);
        if (q.desc) {
          const sub = el('div', '', `${q.desc} &middot; ${Math.floor(q.value)}/${q.goal}`);
          sub.style.cssText = 'font-size:9px;opacity:.5;font-family:system-ui;font-weight:600';
          d.appendChild(sub);
        } else {
          const sub = el('div', '', `${Math.floor(q.value)}/${q.goal}`);
          sub.style.cssText = 'font-size:9px;opacity:.5;font-family:system-ui;font-weight:600';
          d.appendChild(sub);
        }
        host.appendChild(d);
      }
    };
    if (daily) mk(daily, todaysChallenges());
    if (ach) mk(ach, achievementList());
  }

  /* ==================================================== settings */
  renderSettings() {
    const host = $('settingsList');
    if (!host) return;
    host.innerHTML = '';

    const toggle = (label, sub, key, onChange) => {
      const row = el('div', 'setrow');
      row.appendChild(elHtml('span', '', `${label}${sub ? `<small>${sub}</small>` : ''}`));
      const t = elHtml('div', 'toggle' + (getSetting(key) ? ' on' : ''), '<i></i>');
      t.addEventListener('click', () => {
        const v = !getSetting(key);
        setSetting(key, v);
        t.classList.toggle('on', v);
        sfx.ui();
        this.emit('setting', key, v);
        onChange?.(v);
      });
      row.appendChild(t);
      host.appendChild(row);
    };

    toggle('MUSIC', 'chiptune that gets frantic at the end', 'music');
    toggle('SOUND EFFECTS', '', 'sfx');
    toggle('SCREEN SHAKE', 'turn off if it feels like too much', 'shake');

    // quality
    const qrow = el('div', 'setrow');
    qrow.appendChild(elHtml('span', '', 'GRAPHICS<small>auto drops detail if the frame rate dips</small>'));
    const seg = el('div', 'seg');
    for (const q of ['auto', 'low', 'medium', 'high']) {
      const b = el('button', getSetting('quality') === q ? 'on' : '',
        q === 'medium' ? 'MED' : q.toUpperCase());
      b.addEventListener('click', () => {
        setSetting('quality', q);
        for (const c of seg.children) c.classList.toggle('on', c === b);
        sfx.ui();
        this.emit('setting', 'quality', q);
      });
      seg.appendChild(b);
    }
    qrow.appendChild(seg);
    host.appendChild(qrow);

    // camera sensitivity (swipe to look around)
    const crow = el('div', 'setrow');
    crow.appendChild(elHtml('span', '', 'CAMERA SWIPE<small>drag the arena to look around · 0 turns it off</small>'));
    const cseg = el('div', 'seg');
    for (const [label, v] of [['OFF', 0], ['LOW', 0.5], ['MED', 1], ['HIGH', 1.8]]) {
      const b = el('button', Math.abs((getSetting('camSens') ?? 1) - v) < 0.01 ? 'on' : '', label);
      b.addEventListener('click', () => {
        setSetting('camSens', v);
        for (const c of cseg.children) c.classList.toggle('on', c === b);
        sfx.ui();
        this.emit('setting', 'camSens', v);
      });
      cseg.appendChild(b);
    }
    crow.appendChild(cseg);
    host.appendChild(crow);

    // reset (player-facing, always available)
    const rrow = el('div', 'setrow');
    rrow.appendChild(elHtml('span', '', 'RESET PROGRESS<small>wipes coins, levels and collection</small>'));
    const rb = el('div', 'toggle');
    rb.style.cssText = 'width:auto;padding:0 14px;display:grid;place-items:center;font-family:var(--font);font-size:11px;color:#ff5b5b';
    rb.textContent = 'WIPE';
    let armed = false;
    rb.addEventListener('click', () => {
      if (!armed) { armed = true; rb.textContent = 'SURE?'; sfx.error(); setTimeout(() => { armed = false; rb.textContent = 'WIPE'; }, 3000); return; }
      this.emit('resetProgress');
    });
    rrow.appendChild(rb);
    host.appendChild(rrow);

    if (!CONFIG.dev) {
      // Everything below is for whoever is running the relay, not for players.
      // Add ?dev=1 to the URL to bring it back.
      return;
    }

  }




}

const FACE_EMOJI = {
  happy: '🙂', derp: '😜', sigma: '😎', shock: '😱', angy: '😠',
  dizzy: '😵', laser: '😤', stars: '🤩',
};

function SLOT_ICON(slot, item) {
  if (slot === 'emote') return item.icon || '🎭';
  if (slot === 'victory') return '🎉';
  if (slot === 'trail') return item.style === 'fire' ? '🔥' : item.style === 'spark' ? '✨'
    : item.style === 'bubble' ? '🫧' : item.style === 'goo' ? '🧪'
    : item.style === 'ribbon' ? '🌈' : item.style === 'rift' ? '🌀' : item.style === 'puff' ? '💨' : '🚫';
  if (slot === 'plate') return '🏷️';
  return '❔';
}

export { $ };
