/* ============================================================
   progression.js - XP curve, daily challenges, achievements,
   Pure data + pure functions; all state
   lives in core/storage.js.
   ============================================================ */

/* ---------- LEVELS ---------- */
export const MAX_LEVEL = 60;
/** XP needed to go from `lvl` to `lvl+1` */
export const xpForLevel = (lvl) => Math.round(70 + lvl * 42 + lvl * lvl * 4.5);

export function levelFromXp(totalXp) {
  let lvl = 1, rem = totalXp;
  while (lvl < MAX_LEVEL) {
    const need = xpForLevel(lvl);
    if (rem < need) break;
    rem -= need; lvl++;
  }
  const need = lvl >= MAX_LEVEL ? 1 : xpForLevel(lvl);
  return { level: lvl, into: rem, need, pct: lvl >= MAX_LEVEL ? 1 : rem / need };
}

/* ---------- MATCH STAT KEYS ----------
   Emitted by game/match.js at the end of every round.        */
export const STAT_KEYS = [
  'matches', 'wins', 'losses', 'draws',
  'score', 'holdTime', 'longestHold',
  'steals', 'dashHits', 'pickups', 'bonked',
  'lastSecondSteal', 'goldenTime', 'decoyTouches',
  'eventsSeen', 'perfectWin', 'comebackWin',
];

export function emptyStats() {
  const o = {};
  for (const k of STAT_KEYS) o[k] = 0;
  return o;
}

/* ---------- DAILY CHALLENGES ----------
   Three are drawn each day from this pool (seeded by date, so
   both a fresh install and a returning player see the same set). */
export const CHALLENGE_POOL = [
  { id:'c_steal3',   text:'Steal the Brainrot 3 times',        stat:'steals',      goal:3,  coins:60,  xp:40 },
  { id:'c_steal8',   text:'Steal the Brainrot 8 times',        stat:'steals',      goal:8,  coins:130, xp:90 },
  { id:'c_win2',     text:'Win 2 matches',                     stat:'wins',        goal:2,  coins:90,  xp:60 },
  { id:'c_win3',     text:'Win 3 matches',                     stat:'wins',        goal:3,  coins:140, xp:100 },
  { id:'c_hold30',   text:'Hold the Brainrot for 30s total',   stat:'holdTime',    goal:30, coins:80,  xp:50 },
  { id:'c_hold90',   text:'Hold the Brainrot for 90s total',   stat:'holdTime',    goal:90, coins:150, xp:110 },
  { id:'c_long20',   text:'Hold it 20s without dropping it',   stat:'longestHold', goal:20, coins:120, xp:80 },
  { id:'c_dash10',   text:'Land 10 dash hits',                 stat:'dashHits',    goal:10, coins:70,  xp:45 },
  { id:'c_dash20',   text:'Land 20 dash hits',                 stat:'dashHits',    goal:20, coins:120, xp:85 },
  { id:'c_play4',    text:'Play 4 matches',                    stat:'matches',     goal:4,  coins:60,  xp:40 },
  { id:'c_score500', text:'Bank 500 points across matches',    stat:'score',       goal:500,coins:100, xp:70 },
  { id:'c_golden10', text:'Hold a Golden Brainrot for 10s',    stat:'goldenTime',  goal:10, coins:110, xp:75 },
  { id:'c_clutch',   text:'Steal in the last 5 seconds',       stat:'lastSecondSteal', goal:1, coins:160, xp:120 },
  { id:'c_pickup12', text:'Pick up the Brainrot 12 times',     stat:'pickups',     goal:12, coins:80,  xp:50 },
];

/** deterministic day index -> three distinct challenges */
export function dailyChallenges(dayKey) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < dayKey.length; i++) { h ^= dayKey.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const pool = CHALLENGE_POOL.slice();
  const out = [];
  for (let i = 0; i < 3 && pool.length; i++) {
    h = (Math.imul(h, 48271) + 11) >>> 0;
    out.push(pool.splice(h % pool.length, 1)[0]);
  }
  return out;
}

/* ---------- ACHIEVEMENTS ----------
   `stat` is read from the lifetime totals; `test` overrides it. */
export const ACHIEVEMENTS = [
  { id:'firstblood', name:'First Bonk',       desc:'Land your first dash hit',            stat:'dashHits', goal:1,   coins:30,  xp:25 },
  { id:'steal10',    name:'Sticky Fingers',   desc:'Steal the Brainrot 10 times',         stat:'steals',   goal:10,  coins:90,  xp:70 },
  { id:'steal50',    name:'Professional Thief',desc:'Steal the Brainrot 50 times',        stat:'steals',   goal:50,  coins:260, xp:200 },
  { id:'bonked',     name:'Certified Bonkee', desc:'Get knocked over 25 times',           stat:'bonked',   goal:25,  coins:80,  xp:60 },
  { id:'hold30',     name:'Hold The Line',    desc:'Hold the Brainrot 30s in one match',  stat:'longestHold', goal:30, coins:150, xp:120 },
  { id:'win1',       name:'Winner Winner',    desc:'Win a match',                         stat:'wins',     goal:1,   coins:40,  xp:30 },
  { id:'win10',      name:'Brainrot Baron',   desc:'Win 10 matches',                      stat:'wins',     goal:10,  coins:200, xp:180 },
  { id:'win50',      name:'Certified Menace', desc:'Win 50 matches',                      stat:'wins',     goal:50,  coins:600, xp:500 },
  { id:'streak5',    name:'On A Roll',        desc:'Win 5 matches in a row',              stat:'bestStreak', goal:5, coins:250, xp:220 },
  { id:'clutch',     name:'Last Second Larry',desc:'Steal in the final 5 seconds',        stat:'lastSecondSteal', goal:1, coins:180, xp:150 },
  { id:'perfect',    name:'Flawless',         desc:'Win without ever being bonked',       stat:'perfectWin', goal:1, coins:220, xp:190 },
  { id:'comeback',   name:'Comeback Kid',     desc:'Win after trailing by 60+',           stat:'comebackWin', goal:1, coins:220, xp:190 },
  { id:'hoarder',    name:'Hoarder',          desc:'Collect 10 different Brainrots',      stat:'collected', goal:10, coins:200, xp:170 },
  { id:'collector',  name:'Museum Curator',   desc:'Collect 20 different Brainrots',      stat:'collected', goal:20, coins:450, xp:400 },
  { id:'omega',      name:'Omega Believer',   desc:'Collect the Mythic Brainrot',         stat:'mythics',  goal:1,   coins:800, xp:700 },
  { id:'champion',   name:'Brainrot Champion',desc:'Reach level 15',                      stat:'level',    goal:15,  coins:500, xp:0   },
  { id:'marathon',   name:'Marathon Brain',   desc:'Play 50 matches',                     stat:'matches',  goal:50,  coins:300, xp:250 },
];

export const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a]));

/* ---------- END-OF-MATCH REWARD MATH ---------- */
export function matchRewards(stats, streak) {
  const base = Math.round(stats.score * 0.25);
  const winBonus = stats.wins ? 60 : 12;
  const streakBonus = stats.wins ? Math.min(streak, 8) * 12 : 0;
  const stealBonus = stats.steals * 6;
  const coins = base + winBonus + streakBonus + stealBonus;
  const xp = Math.round(base * 0.7) + (stats.wins ? 50 : 15) + stats.steals * 5 + Math.round(stats.holdTime);
  return { coins, xp, base, winBonus, streakBonus, stealBonus };
}

export const dayKeyOf = (d = new Date()) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

export function msUntilMidnight(d = new Date()) {
  const n = new Date(d);
  n.setHours(24, 0, 0, 0);
  return n - d;
}
