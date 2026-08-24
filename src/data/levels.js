/* ============================================================
   levels.js - the single-player ladder.

   The Playables build cannot make external calls, so it has no
   matchmaking, no friend rooms and no world board. Without those it
   needs somewhere for a solo player to make progress, which is what
   this is: a fixed run of hand-tuned bot matches with a stated goal
   and two optional star targets.

   Every level pins its own map and difficulty rather than rolling
   them, so a level is the same challenge for everyone and a 3-star
   run means the same thing on any device.
   ============================================================ */

/**
 * goal.type decides what clearing the level requires:
 *   'win'   - finish ahead of the bot
 *   'score' - reach goal.n points   (classic: points are held seconds)
 *   'tags'  - make goal.n tags      (tagbomb)
 * stars[0] / stars[1] are the 2- and 3-star thresholds, measured on the
 * mode's natural metric: score in classic, tags in TAG BOMB.
 */
export const LEVELS = [
  { id: 1,  name: 'FIRST GRAB',     variant: 'classic', map: 0, diff: 'rookie', goal: { type: 'win' },              stars: [18, 30] },
  { id: 2,  name: 'HOLD ON',        variant: 'classic', map: 0, diff: 'rookie', goal: { type: 'score', n: 22 },     stars: [30, 40] },
  { id: 3,  name: 'HOT POTATO',     variant: 'tagbomb', map: 2, diff: 'rookie', goal: { type: 'win' },              stars: [2, 4] },
  { id: 4,  name: 'THE SPIRE',      variant: 'classic', map: 1, diff: 'chill',  goal: { type: 'win' },              stars: [28, 42] },
  { id: 5,  name: 'QUICK HANDS',    variant: 'tagbomb', map: 2, diff: 'chill',  goal: { type: 'tags', n: 2 },       stars: [3, 5] },
  { id: 6,  name: 'LONG YARD',      variant: 'classic', map: 3, diff: 'chill',  goal: { type: 'score', n: 32 },     stars: [42, 55] },
  { id: 7,  name: 'CAROUSEL',       variant: 'classic', map: 4, diff: 'normal', goal: { type: 'win' },              stars: [38, 52] },
  { id: 8,  name: 'BOMB RUSH',      variant: 'tagbomb', map: 4, diff: 'normal', goal: { type: 'win' },              stars: [4, 6] },
  { id: 9,  name: 'PRESSURE',       variant: 'classic', map: 1, diff: 'normal', goal: { type: 'score', n: 40 },     stars: [50, 62] },
  { id: 10, name: 'SHORT FUSE',     variant: 'tagbomb', map: 3, diff: 'sweaty', goal: { type: 'tags', n: 4 },       stars: [5, 7] },
  { id: 11, name: 'SWEATY PALMS',   variant: 'classic', map: 3, diff: 'sweaty', goal: { type: 'win' },              stars: [52, 66] },
  { id: 12, name: 'FINAL BRAINROT', variant: 'tagbomb', map: 1, diff: 'brutal', goal: { type: 'win' },              stars: [5, 7] },
];

export const LEVEL_COUNT = LEVELS.length;

export function levelById(id) {
  return LEVELS.find((l) => l.id === id) || null;
}

/** The metric a level is scored on - what the star thresholds compare against. */
export function levelMetric(level, stats) {
  if (!stats) return 0;
  return level.variant === 'tagbomb' ? (stats.tags || 0) : (stats.score || 0);
}

/** Plain-language goal text for the level tile and the results screen. */
export function goalText(level) {
  const g = level.goal;
  if (g.type === 'score') return `SCORE ${g.n}`;
  if (g.type === 'tags') return `MAKE ${g.n} TAGS`;
  return 'WIN THE ROUND';
}

/**
 * How many stars a run earned: 0 means the goal was missed, so the level is
 * not cleared. Clearing is always worth at least one star.
 */
export function starsEarned(level, { won, stats }) {
  const g = level.goal;
  const metric = levelMetric(level, stats);
  let cleared;
  if (g.type === 'score') cleared = (stats?.score || 0) >= g.n;
  else if (g.type === 'tags') cleared = (stats?.tags || 0) >= g.n;
  else cleared = !!won;
  if (!cleared) return 0;
  if (metric >= level.stars[1]) return 3;
  if (metric >= level.stars[0]) return 2;
  return 1;
}
