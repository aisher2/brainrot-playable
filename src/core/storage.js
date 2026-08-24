/* ============================================================
   storage.js - the player profile and everything persistent.

   Three backends, tried in order:
     1. window.ytgame  (YouTube Playables SDK cloud save)
     2. localStorage
     3. in-memory      (private mode / sandboxed iframe)
   The rest of the game only ever touches `profile` + save().
   ============================================================ */

import { defaultLoadout, defaultUnlocks, SLOTS, findItem } from '../data/cosmetics.js';
import {
  emptyStats, levelFromXp, dailyChallenges, dayKeyOf,
  ACHIEVEMENTS,
} from '../data/progression.js';
import { BRAINROT_BY_ID, RARITY } from '../data/brainrots.js';
import { Emitter } from './util.js';

const KEY = 'stealthebrainrot.v1';
const VERSION = 1;

export const store = new Emitter();

/* ---------- backend detection ---------- */
let backend = 'memory';
let memoryBlob = null;

function detectBackend() {
  try {
    const yt = globalThis.ytgame;
    if (yt && yt.game && typeof yt.game.loadData === 'function') return 'ytgame';
  } catch (_) { /* ignore */ }
  try {
    const k = '__stb_probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return 'local';
  } catch (_) { /* ignore */ }
  return 'memory';
}

async function backendLoad() {
  if (backend === 'ytgame') {
    try { return await globalThis.ytgame.game.loadData(); } catch (_) { return null; }
  }
  if (backend === 'local') {
    try { return localStorage.getItem(KEY); } catch (_) { return null; }
  }
  return memoryBlob;
}

async function backendSave(str) {
  if (backend === 'ytgame') {
    try { await globalThis.ytgame.game.saveData(str); return; } catch (_) { /* fall through */ }
  }
  if (backend === 'local') {
    try { localStorage.setItem(KEY, str); return; } catch (_) { /* fall through */ }
  }
  memoryBlob = str;
}

/* ---------- default profile ---------- */
function freshProfile() {
  const uid = 'p' + Math.random().toString(36).slice(2, 9);
  return {
    v: VERSION,
    id: uid,
    name: '',
    coins: 120,
    xp: 0,
    loadout: defaultLoadout(),
    unlocks: defaultUnlocks(),
    collection: {},          // brainrotId -> count
    stats: emptyStats(),     // lifetime
    streak: 0,
    bestStreak: 0,
    challenges: { day: null, progress: {}, claimed: [] },
    achievements: {},        // id -> true when unlocked
    board: [],               // local high scores
    levels: {},              // level id -> stars earned (1-3)
    settings: {
      music: true, sfx: true, shake: true,
      quality: 'auto',       // auto | low | medium | high
      camSens: 1,            // 0 = locked camera, 2 = very swipe-sensitive
      serverUrl: '',         // blank -> derived from page origin
    },
    firstRun: true,
  };
}

export let profile = freshProfile();

/* ---------- lifecycle ---------- */
let saveTimer = 0;
let dirty = false;

export async function initStorage() {
  backend = detectBackend();
  const raw = await backendLoad();
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && p.v === VERSION) profile = migrate(p);
    } catch (_) { /* corrupt save -> fresh */ }
  }
  // Phones default to MEDIUM rather than AUTO so the first frame is already
  // within budget instead of being throttled down after a visible dip.
  if (profile.firstRun && profile.settings.quality === 'auto') {
    try {
      if (matchMedia('(pointer:coarse)').matches) profile.settings.quality = 'medium';
    } catch (_) { /* no matchMedia: keep auto */ }
  }
  rollDay();
  return { backend };
}

function migrate(p) {
  const base = freshProfile();
  const out = { ...base, ...p };
  out.settings = { ...base.settings, ...(p.settings || {}) };
  out.loadout = { ...base.loadout, ...(p.loadout || {}) };
  out.stats = { ...base.stats, ...(p.stats || {}) };
  out.challenges = { ...base.challenges, ...(p.challenges || {}) };
  out.unlocks = Array.from(new Set([...base.unlocks, ...(p.unlocks || [])]));
  out.firstRun = false;
  // drop any loadout entry pointing at something that no longer exists
  for (const s of SLOTS) if (!findItem(s.key, out.loadout[s.key])) out.loadout[s.key] = s.def;
  return out;
}

export function save(immediate = false) {
  dirty = true;
  if (immediate) return flush();
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 700);
}

export async function flush() {
  clearTimeout(saveTimer); saveTimer = 0;
  if (!dirty) return;
  dirty = false;
  try { await backendSave(JSON.stringify(profile)); } catch (e) { console.warn('[save]', e); }
}

if (typeof addEventListener === 'function') {
  addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  addEventListener('pagehide', flush);
}

/* ---------- day rollover: challenges + daily reward ---------- */
export function rollDay() {
  const key = dayKeyOf();
  if (profile.challenges.day !== key) {
    profile.challenges = { day: key, progress: {}, claimed: [] };
    dirty = true;
  }
  return key;
}

export function todaysChallenges() {
  const key = rollDay();
  return dailyChallenges(key).map((c) => {
    const val = profile.challenges.progress[c.id] || 0;
    const claimed = profile.challenges.claimed.includes(c.id);
    return { ...c, value: Math.min(val, c.goal), done: val >= c.goal, claimed };
  });
}

/* ---------- currency / xp ---------- */
export function addCoins(n) {
  profile.coins = Math.max(0, Math.round(profile.coins + n));
  store.emit('coins', profile.coins);
  save();
}

export function addXp(n) {
  const before = levelFromXp(profile.xp).level;
  profile.xp += Math.max(0, Math.round(n));
  const after = levelFromXp(profile.xp);
  store.emit('xp', after);
  if (after.level > before) store.emit('levelup', after.level);
  save();
  return { before, after: after.level, leveled: after.level > before };
}

export const levelInfo = () => levelFromXp(profile.xp);

/* ---------- unlocks ---------- */
export const isUnlocked = (slot, id) => profile.unlocks.includes(slot + ':' + id);

export function unlock(slot, id, silent = false) {
  const k = slot + ':' + id;
  if (profile.unlocks.includes(k)) return false;
  profile.unlocks.push(k);
  if (!silent) store.emit('unlock', { slot, id });
  save();
  return true;
}

/** Attempt to buy/equip. Returns 'equipped' | 'bought' | 'locked' | 'poor' */
export function tryEquip(slot, id) {
  const item = findItem(slot, id);
  if (!item) return 'locked';
  if (!isUnlocked(slot, id)) {
    const u = item.unlock || {};
    if (u.type === 'coins') {
      if (profile.coins < u.cost) return 'poor';
      addCoins(-u.cost);
      unlock(slot, id);
      profile.loadout[slot] = id;
      save();
      return 'bought';
    }
    return 'locked';
  }
  profile.loadout[slot] = id;
  store.emit('loadout', profile.loadout);
  save();
  return 'equipped';
}

/** Re-check level / achievement gated items and unlock what is now available. */
export function refreshUnlocks() {
  const lvl = levelInfo().level;
  const newly = [];
  for (const s of SLOTS) {
    for (const it of s.list) {
      if (isUnlocked(s.key, it.id)) continue;
      const u = it.unlock || {};
      if ((u.type === 'level' && lvl >= u.lvl) ||
          (u.type === 'ach' && profile.achievements[u.id])) {
        unlock(s.key, it.id, true);
        newly.push({ slot: s.key, item: it });
      }
    }
  }
  if (newly.length) save();
  return newly;
}

/* ---------- brainrot collection ---------- */
/* ---------- level ladder ---------- */
export const levelStars = (id) => profile.levels[id] || 0;

/** A level opens once the one before it has been cleared. */
export const levelUnlocked = (id) => id <= 1 || (profile.levels[id - 1] || 0) > 0;

export const totalStars = () =>
  Object.values(profile.levels).reduce((a, b) => a + (b || 0), 0);

/** Only ever improves a score, so a sloppy replay cannot cost you stars. */
export function setLevelStars(id, n) {
  if (!(n > (profile.levels[id] || 0))) return false;
  profile.levels[id] = n;
  save();
  store.emit('levels', id);
  return true;
}

export function collect(id) {
  const isNew = !profile.collection[id];
  profile.collection[id] = (profile.collection[id] || 0) + 1;
  save();
  return isNew;
}
export const collectedCount = () => Object.keys(profile.collection).length;
export const mythicCount = () =>
  Object.keys(profile.collection).filter((id) => BRAINROT_BY_ID[id]?.rarity === 'mythic').length;

/* ---------- stats, challenges, achievements ---------- */
/**
 * Fold one match's stats into lifetime totals + daily challenge progress.
 * Returns { challengesCompleted:[], achievementsUnlocked:[] }
 */
export function applyMatchStats(m) {
  rollDay();
  for (const k in m) {
    if (k === 'longestHold') profile.stats.longestHold = Math.max(profile.stats.longestHold, m[k]);
    else if (typeof m[k] === 'number' && k in profile.stats) profile.stats[k] += m[k];
  }
  // daily challenge progress
  const done = [];
  for (const c of dailyChallenges(profile.challenges.day)) {
    const prev = profile.challenges.progress[c.id] || 0;
    if (prev >= c.goal) continue;
    const add = c.stat === 'longestHold' ? Math.max(0, (m.longestHold || 0) - prev) : (m[c.stat] || 0);
    if (!add) continue;
    const next = prev + add;
    profile.challenges.progress[c.id] = next;
    if (next >= c.goal && !profile.challenges.claimed.includes(c.id)) {
      profile.challenges.claimed.push(c.id);
      addCoins(c.coins); addXp(c.xp);
      done.push(c);
    }
  }
  const unlocked = checkAchievements();
  save();
  return { challengesCompleted: done, achievementsUnlocked: unlocked };
}

function achStatValue(stat) {
  switch (stat) {
    case 'bestStreak': return profile.bestStreak;
    case 'collected':  return collectedCount();
    case 'mythics':    return mythicCount();
    case 'level':      return levelInfo().level;
    default:           return profile.stats[stat] || 0;
  }
}

export function checkAchievements() {
  const out = [];
  for (const a of ACHIEVEMENTS) {
    if (profile.achievements[a.id]) continue;
    if (achStatValue(a.stat) >= a.goal) {
      profile.achievements[a.id] = true;
      addCoins(a.coins);
      if (a.xp) addXp(a.xp);
      out.push(a);
    }
  }
  if (out.length) refreshUnlocks();
  return out;
}

export function achievementList() {
  return ACHIEVEMENTS.map((a) => ({
    ...a,
    value: Math.min(achStatValue(a.stat), a.goal),
    done: !!profile.achievements[a.id],
  }));
}

/* ---------- win streak ---------- */
export function recordResult(won) {
  if (won) {
    profile.streak++;
    profile.bestStreak = Math.max(profile.bestStreak, profile.streak);
  } else {
    profile.streak = 0;
  }
  save();
  return profile.streak;
}

/* ---------- local leaderboard ---------- */
export function pushScore(score, extra = {}) {
  profile.board.push({ name: displayName(), score, t: Date.now(), ...extra });
  profile.board.sort((a, b) => b.score - a.score);
  profile.board = profile.board.slice(0, 25);
  save();
}

export function displayName() {
  return (profile.name || '').trim().toUpperCase() || 'BRAINROT #' + profile.id.slice(1, 5).toUpperCase();
}

export function setName(n) {
  profile.name = (n || '').slice(0, 12);
  save();
}

/* ---------- settings ---------- */
export function setSetting(k, v) {
  profile.settings[k] = v;
  store.emit('setting', k, v);
  save();
}
export const getSetting = (k) => profile.settings[k];

/** Everything the opponent needs to render you. */
export function publicProfile() {
  return {
    id: profile.id,
    name: displayName(),
    level: levelInfo().level,
    loadout: { ...profile.loadout },
  };
}

export { RARITY };
export const storageBackend = () => backend;
