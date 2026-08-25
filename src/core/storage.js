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
// The SDK limit is 3 MiB of UTF-16 data. Keep the exact limit here rather
// than relying on a rejected promise after the player has made progress.
const MAX_CLOUD_SAVE_BYTES = 3 * 1024 * 1024;

export const store = new Emitter();

/* ---------- backend detection ---------- */
let backend = 'memory';
let memoryBlob = null;
let cloudLoadSucceeded = false;

function detectBackend() {
  try {
    const yt = globalThis.ytgame;
    /* IN_PLAYABLES_ENV, not merely "loadData exists".
       Outside the Playables host the SDK is deliberately a no-op: loadData
       resolves to an empty string and saveData discards. Testing only for the
       function meant a plain web deploy chose that backend and threw every
       coin, level and star away on reload, silently, because nothing errors.
       This is the guard the official sample applies to every SDK call. */
    if (yt && yt.IN_PLAYABLES_ENV && yt.game && typeof yt.game.loadData === 'function') {
      return 'ytgame';
    }
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
    try {
      const data = await globalThis.ytgame.game.loadData();
      // Even an empty string is a successful load. This acknowledgement is
      // required before the SDK permits a save, protecting an existing cloud
      // profile from being overwritten while a load is still in flight.
      cloudLoadSucceeded = true;
      return data;
    } catch (_) { return null; }
  }
  if (backend === 'local') {
    try { return localStorage.getItem(KEY); } catch (_) { return null; }
  }
  return memoryBlob;
}

async function backendSave(str) {
  if (backend === 'ytgame') {
    // Do not fall back to browser storage in Playables: cloud save is the
    // single source of progress there. A failed load/save must never create a
    // device-only fork that a player cannot recover on another device.
    if (!cloudLoadSucceeded) return;
    await globalThis.ytgame.game.saveData(str);
    return;
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
    seenHowTo: false,        // the signpost tutorial has been through once
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
      /* Mutate in place; never reassign this binding.

         The bundler rewrites `import { profile }` into a destructure, so every
         other module holds the object that existed at import time. Assigning
         `profile = migrate(p)` swapped the binding here and left everyone else
         pointing at the original empty profile - the save was read correctly
         and then loaded into an object nobody could see. Coins, XP, levels,
         stars and the collection all reset on every load because of it. */
      if (p && p.v === VERSION) {
        const merged = migrate(p);
        for (const k of Object.keys(profile)) delete profile[k];
        Object.assign(profile, merged);
      }
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
  try {
    let data = JSON.stringify(profile);
    // saveData requires well-formed UTF-16. Text entered through normal UI is
    // fine, but old/corrupt saves can contain lone surrogates.
    if (typeof data.toWellFormed === 'function') data = data.toWellFormed();
    if (data.length * 2 > MAX_CLOUD_SAVE_BYTES) {
      throw new RangeError('cloud save exceeds the 3 MiB SDK limit');
    }
    await backendSave(data);
  } catch (e) {
    /* A failed save is recoverable - the player keeps playing - but it is
       exactly the kind of thing worth reporting. Emitted rather than reported
       from here so core/ does not have to reach into the platform layer;
       main.js forwards it to health.logWarning. */
    console.warn('[save]', e);
    store.emit('saveFailed', e);
  }
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
