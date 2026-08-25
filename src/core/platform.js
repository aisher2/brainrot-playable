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
  /** Developer rows in Settings; ?dev=1 also turns this on. */
  dev: raw.dev === true || params.get('dev') === '1',

  /** Skip straight into a match - handy for review/QA links. */
  autoPractice: params.get('practice') === '1',
};

/* relayUrl(), onlineEnabled() and leaderboardUrl() used to live here. They
   resolved CONFIG.relay and CONFIG.leaderboard into a socket and an API base.
   Both are gone: the game has no server to reach, and a Playables build is
   not allowed to reach one. Scores are kept in the saved profile instead. */

/* ============================================================
   YouTube Playables SDK adapter
   ============================================================ */
/* Resolved on every access instead of captured once.

   The SDK script installs a loader that can re-import a different build from
   flags on its own URL - which is how the certification harness swaps in an
   instrumented copy of itself. That replaces window.ytgame after our bundle
   has already evaluated, so a reference grabbed at module scope would point
   at an object nobody is listening to: our calls would appear to succeed
   while landing somewhere the host never sees. */
function getSdk() {
  try {
    const yt = globalThis.ytgame;
    /* Outside the host the SDK is a no-op that warns on every call. Google's
       own sample gates all of its SDK usage on IN_PLAYABLES_ENV rather than on
       the object existing, so this does the same: in the host it is the real
       SDK, anywhere else it is null and every adapter method below turns into
       the harmless fallback it already had. */
    return (yt && yt.IN_PLAYABLES_ENV) ? yt : null;
  } catch (_) { return null; }
}

/* The SDK deliberately exposes its namespace when served locally, but marks
   IN_PLAYABLES_ENV false and makes every API a no-op. That is still proof the
   script has loaded. Keep that separate from getSdk(): callers that talk to
   the host need the latter, while boot only needs to know that its preceding
   SDK script has executed. */
function sdkNamespaceLoaded() {
  try { return !!globalThis.ytgame; } catch (_) { return false; }
}

let firstFrameSent = false;
let readySent = false;

function safe(fn, label) {
  try { return fn(); } catch (e) { console.warn('[playables] ' + label + ' failed', e); return undefined; }
}

export const yt = {
  /** true when running inside the Playables host */
  get available() { return !!getSdk(); },

  /** The loading screen is painted. Must come before gameReady(). */
  firstFrameReady() {
    const sdk = getSdk();
    if (!sdk || firstFrameSent) return;
    firstFrameSent = true;
    safe(() => sdk.game?.firstFrameReady?.(), 'firstFrameReady');
  },

  /** The player can interact. Call once, after boot completes. */
  gameReady() {
    const sdk = getSdk();
    if (!sdk || readySent) return;
    if (!firstFrameSent) this.firstFrameReady();
    readySent = true;
    safe(() => sdk.game?.gameReady?.(), 'gameReady');
  },

  /** YouTube asks the game to suspend / resume. */
  onPause(fn) { const s = getSdk(); if (s) safe(() => s.system?.onPause?.(fn), 'onPause'); },
  onResume(fn) { const s = getSdk(); if (s) safe(() => s.system?.onResume?.(fn), 'onResume'); },

  /** Audio must follow YouTube's mute state, not just our own setting. */
  audioEnabled() {
    const sdk = getSdk();
    if (!sdk) return true;
    const v = safe(() => sdk.system?.isAudioEnabled?.(), 'isAudioEnabled');
    return v === undefined ? true : !!v;
  },
  onAudioEnabledChange(fn) {
    const s = getSdk();
    if (s) safe(() => s.system?.onAudioEnabledChange?.(fn), 'onAudioEnabledChange');
  },

  /**
   * Report a round's result to the host.
   *
   * The SDK validates this itself and throws on anything that is not a safe
   * integer, so the coercion here is not defensive padding - a fractional
   * hold time would be rejected outright. Non-finite values are dropped
   * rather than sent as 0, since a fake score is worse than no score.
   */
  sendScore(value) {
    const sdk = getSdk();
    if (!sdk) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const v = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)));
    safe(() => sdk.engagement?.sendScore?.({ value: v })?.catch?.(() => {}), 'sendScore');
  },

  /** Surface a fatal error to the host so it can report it. */
  /**
   * Tell the host something went wrong.
   *
   * The signature really is logError(): void - it takes no arguments. We were
   * passing the message in, which JS accepts silently but is not the contract,
   * and it would have been shipping error text to YouTube that the API never
   * asked for. The detail goes to the console instead, where it is useful to
   * whoever is actually debugging.
   */
  logError(err) {
    if (err) { try { console.error('[game]', err); } catch (_) { /* ignore */ } }
    const sdk = getSdk();
    if (!sdk) return;
    safe(() => sdk.health?.logError?.(), 'logError');
  },
};

/**
 * Resolve once the SDK namespace is present.
 *
 * The script is synchronous and sits above our bundle, so in the host this is
 * already true on the first check. Do not wait for IN_PLAYABLES_ENV here: the
 * documented local SDK is intentionally a no-op with that flag set to false.
 * Waiting for the flag held ordinary web builds on their loading screen for
 * the full timeout even though the SDK had loaded correctly.
 */
export function sdkReady(timeoutMs = 3000) {
  if (sdkNamespaceLoaded()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (sdkNamespaceLoaded()) return resolve(true);
      if (Date.now() - t0 >= timeoutMs) return resolve(false);
      setTimeout(tick, 30);
    };
    tick();
  });
}
