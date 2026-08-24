/* ============================================================
   scores.js - the leaderboard, which is now entirely this device's.

   This replaces net/leaderboard.js, which fetched a world board from
   server/server.js and fell back to a local one when no API was
   configured. The fetch is gone: an offline build has no endpoint to
   call, and a Playables build is not permitted to call one anyway.

   What is left is the fallback path that already existed, promoted to
   being the whole thing. Scores live in the saved profile, so they
   travel with the player through whichever storage backend is active
   - including the Playables cloud save.
   ============================================================ */

import { profile, pushScore, displayName } from '../core/storage.js';

/** There is no world board any more, and nothing should offer one. */
export const hasGlobalBoard = () => false;

/**
 * @returns {Promise<{scope:'local', rows:Array}>}
 * Still async: the screen that renders this was written against a
 * promise, and keeping the shape means the UI did not have to change.
 */
export async function fetchBoard() {
  const me = displayName();
  const rows = (profile.board || []).slice(0, 25).map((r) => ({ ...r, me: r.name === me }));
  return { scope: 'local', rows };
}

/** Records the run in the profile. Nothing leaves the device. */
export async function submitScore(score, extra = {}) {
  pushScore(score, extra);
  return { ok: true, scope: 'local' };
}
