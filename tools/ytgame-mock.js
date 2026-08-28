/* ============================================================
   ytgame-mock.js - a stand-in for the Playables host, for local testing.

   DEVELOPMENT ONLY. This is never copied into dist/ and never served
   by a deploy. The dev server hands it out only when started with
   --mock, and it replaces the real SDK script tag while doing so:

     node server/server.js --root dist --mock

   Why it exists: the real SDK is deliberately a no-op when the game is
   not inside YouTube. IN_PLAYABLES_ENV is false, every call returns
   nothing, and so the branches that only run inside the host - ads,
   pause and resume, the audio callback, cloud save - are never
   exercised during development. They ship untested. This implements
   the documented API faithfully enough to run those branches, and adds
   a small control panel for firing the events the host would send.

   It implements the surface described in:
   developers.google.com/youtube/gaming/playables/reference/sdk
   ============================================================ */

(function () {
  'use strict';

  if (window.ytgame) {
    console.warn('[ytgame-mock] a real ytgame is already present; leaving it alone');
    return;
  }

  const KEY = '__ytgame_mock_save';
  const log = (...a) => console.info('%c[ytgame-mock]', 'color:#0a0', ...a);

  /* The SDK rejects with an SdkError, and games are told to handle it, so the
     mock has to throw the same shape or error paths never get tested. */
  const SdkErrorType = {
    UNKNOWN: 'UNKNOWN',
    API_UNAVAILABLE: 'API_UNAVAILABLE',
    INVALID_PARAMS: 'INVALID_PARAMS',
    SIZE_LIMIT_EXCEEDED: 'SIZE_LIMIT_EXCEEDED',
  };
  class SdkError extends Error {
    constructor(type, message) {
      super(message || type);
      this.name = 'SdkError';
      this.errorType = type;
    }
  }

  const pauseCbs = [];
  const resumeCbs = [];
  const audioCbs = [];
  let audioEnabled = true;

  /* Real calls cross an iframe boundary, so nothing resolves synchronously.
     Resolving on a microtask here would hide ordering bugs that only appear
     against the real host. */
  const latency = (v) => new Promise((r) => setTimeout(() => r(v), 120));

  const ytgame = {
    SDK_VERSION: '1.mock',
    IN_PLAYABLES_ENV: true,
    SdkError,
    SdkErrorType,

    game: {
      firstFrameReady() { log('firstFrameReady()'); },
      gameReady() { log('gameReady()'); },

      loadData() {
        let raw = '';
        try { raw = localStorage.getItem(KEY) || ''; } catch (_) { /* ignore */ }
        log('loadData() ->', raw ? raw.length + ' chars' : '(empty)');
        return latency(raw);
      },

      saveData(data) {
        if (typeof data !== 'string') {
          return Promise.reject(new SdkError(SdkErrorType.INVALID_PARAMS, 'data must be a string'));
        }
        // the documented limit is 3 MiB of UTF-16
        if (data.length * 2 > 3 * 1024 * 1024) {
          return Promise.reject(new SdkError(SdkErrorType.SIZE_LIMIT_EXCEEDED, 'save exceeds 3 MiB'));
        }
        try { localStorage.setItem(KEY, data); } catch (_) { /* ignore */ }
        log('saveData()', data.length + ' chars');
        return latency();
      },
    },

    system: {
      isAudioEnabled() { return audioEnabled; },
      onAudioEnabledChange(cb) {
        audioCbs.push(cb);
        return () => { const i = audioCbs.indexOf(cb); if (i >= 0) audioCbs.splice(i, 1); };
      },
      onPause(cb) {
        pauseCbs.push(cb);
        return () => { const i = pauseCbs.indexOf(cb); if (i >= 0) pauseCbs.splice(i, 1); };
      },
      onResume(cb) {
        resumeCbs.push(cb);
        return () => { const i = resumeCbs.indexOf(cb); if (i >= 0) resumeCbs.splice(i, 1); };
      },
      getLanguage() { return latency(navigator.language || 'en-US'); },
    },

    engagement: {
      ContentType: { VIDEO: 'VIDEO', PLAYABLE: 'PLAYABLE' },
      sendScore(score) {
        if (!score || !Number.isSafeInteger(score.value)) {
          return Promise.reject(new SdkError(SdkErrorType.INVALID_PARAMS, 'score.value must be a safe integer'));
        }
        log('sendScore()', score.value);
        return latency();
      },
      openYTContent(content) {
        if (!content || !content.id) {
          return Promise.reject(new SdkError(SdkErrorType.INVALID_PARAMS, 'content.id required'));
        }
        log('openYTContent()', content.id, content.contentType || 'VIDEO');
        return latency();
      },
    },

    ads: {
      requestInterstitialAd() {
        log('requestInterstitialAd()');
        return panel.adsFail
          ? Promise.reject(new SdkError(SdkErrorType.API_UNAVAILABLE, 'no fill'))
          : latency();
      },
      requestRewardedAd(rewardId) {
        log('requestRewardedAd()', rewardId);
        if (panel.adsFail) {
          return Promise.reject(new SdkError(SdkErrorType.API_UNAVAILABLE, 'no fill'));
        }
        // resolving false is the "watched nothing, earned nothing" case, which
        // a game must handle differently from a rejection
        return latency(!panel.rewardDenied);
      },
    },

    health: {
      logError() { log('health.logError()'); },
      logWarning() { log('health.logWarning()'); },
    },
  };

  Object.defineProperty(window, 'ytgame', { value: ytgame, writable: false, configurable: true });

  /* ---------- the control panel ----------
     The host sends pause, resume and audio changes on its own schedule. There
     is no way to provoke those from the game, so the mock provides buttons. */
  const panel = { adsFail: false, rewardDenied: false };

  function buildPanel() {
    const el = document.createElement('div');
    el.id = 'ytgame-mock-panel';
    el.style.cssText = [
      'position:fixed;right:8px;bottom:8px;z-index:2147483647',
      'font:11px/1.5 ui-monospace,Menlo,Consolas,monospace',
      'background:#0b1220ee;color:#cfe;border:1px solid #2c3e55;border-radius:8px',
      'padding:8px 9px;min-width:172px;backdrop-filter:blur(4px)',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'ytgame mock';
    title.style.cssText = 'color:#7fd1a0;margin-bottom:6px;letter-spacing:.08em';
    el.appendChild(title);

    const button = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'display:block;width:100%;margin:2px 0;padding:4px 6px;'
        + 'background:#16263c;color:#cfe;border:1px solid #2c3e55;border-radius:5px;'
        + 'cursor:pointer;font:inherit;text-align:left';
      b.addEventListener('click', fn);
      el.appendChild(b);
      return b;
    };

    button('pause', () => { log('-> onPause'); pauseCbs.forEach((f) => f()); });
    button('resume', () => { log('-> onResume'); resumeCbs.forEach((f) => f()); });

    const audioBtn = button('', () => {
      audioEnabled = !audioEnabled;
      log('-> onAudioEnabledChange', audioEnabled);
      audioCbs.forEach((f) => f(audioEnabled));
      audioBtn.textContent = 'audio: ' + (audioEnabled ? 'on' : 'off');
    });
    audioBtn.textContent = 'audio: on';

    const adBtn = button('', () => {
      panel.adsFail = !panel.adsFail;
      adBtn.textContent = 'ads: ' + (panel.adsFail ? 'failing' : 'ok');
    });
    adBtn.textContent = 'ads: ok';

    const rewardBtn = button('', () => {
      panel.rewardDenied = !panel.rewardDenied;
      rewardBtn.textContent = 'reward: ' + (panel.rewardDenied ? 'not earned' : 'earned');
    });
    rewardBtn.textContent = 'reward: earned';

    button('clear save', () => {
      try { localStorage.removeItem(KEY); } catch (_) { /* ignore */ }
      log('save cleared');
    });

    document.body.appendChild(el);
  }

  if (document.readyState === 'loading') {
    addEventListener('DOMContentLoaded', buildPanel, { once: true });
  } else {
    buildPanel();
  }

  log('installed - IN_PLAYABLES_ENV is true, this is NOT the real SDK');
}());
