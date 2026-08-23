/* ============================================================
   netclient.js - matchmaking.

   Online:   connect to the relay, queue, get paired with a REAL
             second player, receive {seed, idx, host, opponent}.
   Practice: identical handshake against an in-page loopback whose
             far end is driven by net/bot.js. Clearly separated and
             clearly labelled in the UI - never used online.
   ============================================================ */

import { Emitter } from '../core/util.js';
import { M, S, PROTOCOL_VERSION, defaultServerUrl } from './protocol.js';
import { WebSocketTransport, localPair } from './transport.js';
import { botName } from './bot.js';

export const NET_STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  SEARCHING: 'searching',
  FOUND: 'found',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

export class Matchmaker extends Emitter {
  constructor() {
    super();
    this.transport = null;
    this.status = NET_STATUS.IDLE;
    this.cancelled = false;
    this.lastError = '';
    this.queuePos = 0;
  }

  _set(st, detail) {
    this.status = st;
    this.emit('status', st, detail);
  }

  serverUrl(override) {
    const u = (override || '').trim();
    if (u) return u;
    return defaultServerUrl();
  }

  /**
   * @param opts {mode:'online'|'practice'|'friend', serverUrl, profile, difficulty,
   *              seed, humanHost, code}
   *   mode 'friend' with no code  -> create a room and wait for a friend
   *   mode 'friend' with a code   -> join that friend's room
   * @returns Promise<MatchInfo>
   */
  async find(opts) {
    this.cancelled = false;
    this.lastError = '';
    if (opts.mode === 'practice') return this._practice(opts);
    return this._online(opts);
  }

  /* ---------------- practice ---------------- */
  async _practice(opts) {
    const seed = (opts.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
    this._set(NET_STATUS.CONNECTING);
    await wait(180);
    if (this.cancelled) throw new CancelError();

    this._set(NET_STATUS.SEARCHING);
    await wait(500 + Math.random() * 500);
    if (this.cancelled) throw new CancelError();

    const bot = {
      id: 'bot',
      name: botName(seed),
      level: 1 + (seed % 20),
      loadout: botLoadout(seed),
      isBot: true,
    };
    const humanHost = opts.humanHost !== false;
    const { a, b, deal } = localPair(seed, opts.profile, bot, humanHost, opts.lagMs || 0);
    await a.connect();
    await b.connect();

    const info = await new Promise((resolve) => {
      a.once('message', (m) => {
        resolve({
          transport: a, idx: m.idx, host: m.host, seed: m.seed, opp: bot,
          mode: 'practice',
          bot: { transport: b, idx: 1 - m.idx, host: !m.host, difficulty: opts.difficulty || 'normal', profile: bot },
        });
      });
      deal();
    });

    this._set(NET_STATUS.FOUND, info);
    this.transport = a;
    return info;
  }

  /* ---------------- online ---------------- */
  async _online(opts) {
    const url = this.serverUrl(opts.serverUrl);
    if (!url) {
      this.lastError = 'No multiplayer server configured.';
      this._set(NET_STATUS.FAILED, this.lastError);
      throw new NetError(this.lastError);
    }

    this._set(NET_STATUS.CONNECTING);
    const t = new WebSocketTransport(url);
    this.transport = t;
    try {
      await t.connect();
    } catch (e) {
      this.lastError = 'Could not reach the matchmaking server.';
      this._set(NET_STATUS.FAILED, this.lastError);
      throw new NetError(this.lastError, e);
    }
    if (this.cancelled) { t.close(); throw new CancelError(); }

    t.send({ t: M.HELLO, v: PROTOCOL_VERSION, profile: opts.profile });
    if (opts.mode === 'friend') {
      if (opts.code) t.send({ t: M.JOIN_ROOM, code: opts.code });
      else t.send({ t: M.MAKE_ROOM });
    } else {
      t.send({ t: M.QUEUE });
    }
    this._set(NET_STATUS.SEARCHING);

    return new Promise((resolve, reject) => {
      const offMsg = t.on('message', (m) => {
        if (m.t === S.QUEUED) {
          this.queuePos = m.n || 0;
          this.emit('queued', m.n || 0);
          return;
        }
        if (m.t === S.ROOM) {
          this.roomCode = m.code;
          this.emit('roomCode', m.code);
          return;
        }
        if (m.t === S.MATCH) {
          cleanup();
          const info = {
            transport: t,
            idx: m.idx | 0,
            host: !!m.host,
            seed: (m.seed >>> 0) || 1,
            opp: m.opp || { name: 'OPPONENT', level: 1, loadout: null },
            mode: 'online',
            room: m.room,
            viaCode: !!(opts.mode === 'friend'),
          };
          this._set(NET_STATUS.FOUND, info);
          resolve(info);
          return;
        }
        if (m.t === S.ERROR) {
          cleanup();
          this.lastError = m.m || 'Server rejected the match.';
          this._set(NET_STATUS.FAILED, this.lastError);
          reject(new NetError(this.lastError));
        }
      });
      const offClose = t.on('close', () => {
        cleanup();
        // cancel() closes the socket itself, and that close lands before the
        // poll below notices the flag. Without this, backing out of a search
        // surfaces as "Lost connection" instead of a quiet cancel.
        if (this.cancelled) {
          this._set(NET_STATUS.CANCELLED);
          reject(new CancelError());
          return;
        }
        this.lastError = 'Lost connection while searching.';
        this._set(NET_STATUS.FAILED, this.lastError);
        reject(new NetError(this.lastError));
      });
      const cleanup = () => { offMsg(); offClose(); clearInterval(poll); };
      // keep the UI honest about how long we have been waiting
      const started = Date.now();
      const poll = setInterval(() => {
        if (this.cancelled) {
          cleanup();
          try { t.send({ t: M.CANCEL }); t.close(); } catch (_) {}
          this._set(NET_STATUS.CANCELLED);
          reject(new CancelError());
          return;
        }
        this.emit('waiting', (Date.now() - started) / 1000);
      }, 250);
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.transport) {
      try { this.transport.send({ t: M.CANCEL }); } catch (_) {}
      try { this.transport.close(); } catch (_) {}
    }
    this.transport = null;
    this._set(NET_STATUS.CANCELLED);
  }

  /** Quick reachability probe so the menu can show an honest status dot. */
  async probe(serverUrl, timeout = 3000) {
    const url = this.serverUrl(serverUrl);
    if (!url) return { ok: false, reason: 'not configured' };
    const t = new WebSocketTransport(url, timeout);
    try {
      await t.connect();
      t.close();
      return { ok: true, url };
    } catch (e) {
      return { ok: false, reason: 'unreachable', url };
    }
  }
}

export class CancelError extends Error {
  constructor() { super('cancelled'); this.cancelled = true; }
}
export class NetError extends Error {
  constructor(msg, cause) { super(msg); this.cause = cause; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SKINS = ['blob', 'mint', 'tangerine', 'blueberry', 'tall', 'chonk', 'brick'];
const HATS = ['none', 'cap', 'cone', 'bucket', 'horns'];
const FACES = ['happy', 'derp', 'sigma', 'shock', 'angy'];
const TRAILS = ['dust', 'bubbles', 'fire', 'sparkle'];
function botLoadout(seed) {
  const s = seed >>> 0;
  return {
    skin: SKINS[s % SKINS.length],
    hat: HATS[(s >> 3) % HATS.length],
    face: FACES[(s >> 6) % FACES.length],
    trail: TRAILS[(s >> 9) % TRAILS.length],
    emote: 'spin', victory: 'jump', plate: 'plain',
  };
}
