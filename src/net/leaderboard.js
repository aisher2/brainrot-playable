/* ============================================================
   leaderboard.js - the world board.

   Talks to the API that server/server.js exposes:
     GET  <base>/top?limit=25  -> { rows: [{id,name,score,hold,wins}] }
     POST <base>/score         -> { ok, rank, best }

   With no API configured it quietly keeps a local board instead, so
   a static deploy still has a working LEADERBOARD screen.
   ============================================================ */

import { profile, pushScore, displayName } from '../core/storage.js';
import { leaderboardUrl } from '../core/platform.js';

const TIMEOUT = 5000;

async function api(pathname, body) {
  const base = leaderboardUrl();
  if (!base) throw new Error('no endpoint');
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(base + pathname, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

export const hasGlobalBoard = () => !!leaderboardUrl();

/**
 * @returns {Promise<{scope:'global'|'local', rows:Array}>}
 */
export async function fetchBoard(kind = 'score') {
  if (leaderboardUrl()) {
    try {
      const data = await api('/top?limit=25&kind=' + encodeURIComponent(kind));
      if (Array.isArray(data?.rows)) {
        return { scope: 'global', rows: data.rows.map((r) => ({ ...r, me: r.id === profile.id })) };
      }
    } catch (_) { /* fall through to the local board */ }
  }
  const me = displayName();
  const rows = (profile.board || []).slice(0, 25).map((r) => ({ ...r, me: r.name === me }));
  return { scope: 'local', rows };
}

/** Always records locally; also posts to the world board when there is one. */
export async function submitScore(score, extra = {}) {
  pushScore(score, extra);
  if (!leaderboardUrl()) return { ok: false, scope: 'local' };
  try {
    const out = await api('/score', { id: profile.id, name: displayName(), score, ...extra });
    return { ok: !!out.ok, scope: 'global', rank: out.rank, best: out.best };
  } catch (_) {
    return { ok: false, scope: 'local' };
  }
}
