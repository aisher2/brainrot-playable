/* ============================================================
   transport.js - how bytes actually move.

   Two implementations behind one interface:

     WebSocketTransport  real matchmaking server (server/server.js)
     LocalPair           an in-page loopback used by PRACTICE mode,
                         which runs the *exact same* protocol so the
                         netcode path is exercised offline too.

   Interface:  connect() -> Promise, send(obj), close(), onMessage,
               onOpen, onClose, onError
   ============================================================ */

import { Emitter } from '../core/util.js';
import { encodeMsg, decodeMsg, M, S, PROTOCOL_VERSION } from './protocol.js';

export class Transport extends Emitter {
  constructor() { super(); this.state = 'closed'; }
  async connect() { throw new Error('not implemented'); }
  send(_obj) {}
  close() {}
  get connected() { return this.state === 'open'; }
}

/* ============================================================
   Real server
   ============================================================ */
export class WebSocketTransport extends Transport {
  constructor(url, timeout = 8000) {
    super();
    this.url = url;
    this.timeout = timeout;
    this.ws = null;
    this.rtt = 0;
    this._pingTimer = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.url) return reject(new Error('no server url'));
      let settled = false;
      this.state = 'connecting';
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { return reject(e); }
      this.ws = ws;

      const fail = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        this.state = 'closed';
        reject(e instanceof Error ? e : new Error('connection failed'));
      };
      const to = setTimeout(() => { try { ws.close(); } catch (_) {} fail(new Error('timed out')); }, this.timeout);

      ws.onopen = () => {
        settled = true;
        clearTimeout(to);
        this.state = 'open';
        this.emit('open');
        this._startPing();
        resolve(this);
      };
      ws.onmessage = (ev) => {
        const m = decodeMsg(ev.data);
        if (!m) return;
        if (m.t === S.PONG) { this.rtt = Date.now() - m.s; return; }
        this.emit('message', m);
      };
      ws.onerror = () => { this.emit('error', new Error('socket error')); fail(new Error('socket error')); };
      ws.onclose = () => {
        clearTimeout(to);
        clearInterval(this._pingTimer);
        const wasOpen = this.state === 'open';
        this.state = 'closed';
        if (wasOpen) this.emit('close');
        fail(new Error('closed'));
      };
    });
  }

  _startPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this.connected) this.send({ t: M.PING, s: Date.now() });
    }, 4000);
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(encodeMsg(obj)); } catch (_) { /* dropped */ }
  }

  close() {
    clearInterval(this._pingTimer);
    try { this.ws?.close(); } catch (_) {}
    this.state = 'closed';
    this.ws = null;
  }
}

/* ============================================================
   In-page loopback

   `LocalPair` fabricates the server for two endpoints living in the
   same tab. PRACTICE mode wires endpoint A to the player and
   endpoint B to the bot, so every message the online build sends is
   also sent (and parsed) offline.
   ============================================================ */
export class LocalTransport extends Transport {
  constructor(name) { super(); this.name = name; this.peer = null; this.lagMs = 0; this.jitterMs = 0; }

  connect() {
    this.state = 'open';
    queueMicrotask(() => this.emit('open'));
    return Promise.resolve(this);
  }

  /** simulate latency so practice mode feels like a real connection */
  setLag(ms, jitter = 0) { this.lagMs = ms; this.jitterMs = jitter; }

  send(obj) {
    if (!this.peer || this.peer.state !== 'open') return;
    const clone = decodeMsg(encodeMsg(obj));   // round-trip: catches non-serialisable data early
    const d = this.lagMs + (this.jitterMs ? Math.random() * this.jitterMs : 0);
    if (d <= 0) queueMicrotask(() => this.peer.emit('message', clone));
    else setTimeout(() => this.peer.emit('message', clone), d);
  }

  close() {
    if (this.state !== 'open') return;
    this.state = 'closed';
    const peer = this.peer;
    this.emit('close');
    if (peer && peer.state === 'open') setTimeout(() => peer.emit('message', { t: S.PEER_GONE }), 10);
  }
}

/**
 * Build a fake matchmaking session between two local endpoints.
 * Returns { a, b } - two LocalTransports already "matched".
 */
export function localPair(seed, aProfile, bProfile, aIsHost = true, lagMs = 0) {
  const a = new LocalTransport('A');
  const b = new LocalTransport('B');
  a.peer = b; b.peer = a;
  a.setLag(lagMs, lagMs ? lagMs * 0.35 : 0);
  b.setLag(lagMs, lagMs ? lagMs * 0.35 : 0);

  const room = 'local-' + (seed >>> 0).toString(36);
  const deal = () => {
    a.emit('message', {
      t: S.MATCH, room, seed, v: PROTOCOL_VERSION,
      idx: aIsHost ? 0 : 1, host: aIsHost, opp: bProfile, local: true,
    });
    b.emit('message', {
      t: S.MATCH, room, seed, v: PROTOCOL_VERSION,
      idx: aIsHost ? 1 : 0, host: !aIsHost, opp: aProfile, local: true,
    });
  };
  return { a, b, deal };
}
