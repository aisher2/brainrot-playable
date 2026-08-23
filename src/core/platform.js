/* ============================================================
   platform.js - build configuration + the YouTube Playables SDK.

   Two jobs:

   1. CONFIG - a handful of switches the deployed page can set
      without a rebuild (see the inline <script> in index.html).

   2. A safe adapter over `window.ytgame`. Every call is a no-op when
      the SDK is absent, so the exact same build runs on your own
      domain, inside the Playables iframe, and on localhost.

   Playables integration requirements covered here:
     firstFrameReady()  - loading screen is on screen
     gameReady()        - the player can actually interact
     onPause/onResume   - suspend everything when YouTube says so
     audio enable state - never make noise when YouTube is muted
   Cloud saves live in core/storage.js, which already prefers the SDK.
   ============================================================ */

const raw = (globalThis.STB_CONFIG && typeof globalThis.STB_CONFIG === 'object')
  ? globalThis.STB_CONFIG : {};

const params = (() => {
  try { return new URLSearchParams(globalThis.location?.search || ''); }
  catch (_) { return new URLSearchParams(''); }
})();

export const CONFIG = {
  /**
   * WebSocket relay for online 1v1.
   *  ''      -> no online play; the game runs its offline mode only and
   *             never attempts a connection (so: no console errors on a
   *             plain static host).
   *  'auto'  -> derive wss://<this page's host>/ws
   *  'wss://...' -> use exactly this.
   */
  relay: typeof raw.relay === 'string' ? raw.relay.trim() : '',

  /**
   * Where the global leaderboard lives.
   *  ''      -> local-only board stored in the browser
   *  'auto'  -> https://<this page's host>/api   (server/server.js serves it)
   *  'https://...' -> an explicit API base
   */
  leaderboard: typeof raw.leaderboard === 'string' ? raw.leaderboard.trim() : '',

  /** Developer rows in Settings, FPS counter, ?dev=1 also turns this on. */
  dev: raw.dev === true || params.get('dev') === '1',

  /** Skip straight into a practice match - handy for review/QA links. */
  autoPractice: params.get('practice') === '1',
};

/** Resolve CONFIG.relay into a concrete URL, or '' when online is off. */
export function relayUrl(override) {
  const pick = (override && override.trim()) || CONFIG.relay;
  if (!pick) return '';
  if (pick !== 'auto') return pick;
  try {
    const loc = globalThis.location;
    if (!loc || !loc.host) return '';
    return (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host + '/ws';
  } catch (_) {
    return '';
  }
}

export const onlineEnabled = () => !!relayUrl();

/** Resolve CONFIG.leaderboard into an API base, or '' when there is none. */
export function leaderboardUrl(override) {
  const pick = (override && override.trim()) || CONFIG.leaderboard;
  if (!pick) return '';
  if (pick !== 'auto') return pick.replace(/\/+$/, '');
  try {
    const loc = globalThis.location;
    if (!loc || !loc.host) return '';
    return loc.protocol + '//' + loc.host + '/api';
  } catch (_) {
    return '';
  }
}

/* ============================================================
   YouTube Playables SDK adapter
   ============================================================ */
const sdk = (() => {
  try { return globalThis.ytgame || null; } catch (_) { return null; }
})();

let firstFrameSent = false;
let readySent = false;

function safe(fn, label) {
  try { return fn(); } catch (e) { console.warn('[playables] ' + label + ' failed', e); return undefined; }
}

export const yt = {
  /** true when running inside the Playables host */
  get available() { return !!sdk; },

  /** The loading screen is painted. Must come before gameReady(). */
  firstFrameReady() {
    if (!sdk || firstFrameSent) return;
    firstFrameSent = true;
    safe(() => sdk.game?.firstFrameReady?.(), 'firstFrameReady');
  },

  /** The player can interact. Call once, after boot completes. */
  gameReady() {
    if (!sdk || readySent) return;
    if (!firstFrameSent) this.firstFrameReady();
    readySent = true;
    safe(() => sdk.game?.gameReady?.(), 'gameReady');
  },

  /** YouTube asks the game to suspend / resume. */
  onPause(fn) { if (sdk) safe(() => sdk.system?.onPause?.(fn), 'onPause'); },
  onResume(fn) { if (sdk) safe(() => sdk.system?.onResume?.(fn), 'onResume'); },

  /** Audio must follow YouTube's mute state, not just our own setting. */
  audioEnabled() {
    if (!sdk) return true;
    const v = safe(() => sdk.system?.isAudioEnabled?.(), 'isAudioEnabled');
    return v === undefined ? true : !!v;
  },
  onAudioEnabledChange(fn) {
    if (sdk) safe(() => sdk.system?.onAudioEnabledChange?.(fn), 'onAudioEnabledChange');
  },

  /** Surface a fatal error to the host so it can report it. */
  logError(err) {
    if (!sdk) return;
    safe(() => sdk.game?.logError?.(String(err && err.message || err)), 'logError');
  },
};
