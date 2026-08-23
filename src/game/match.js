/* ============================================================
   match.js - runs one 60 second round.

   Topology: the two peers elect a host. The host owns the
   authoritative simulation and broadcasts snapshots at 20Hz; the
   client predicts its own player at 60Hz and rolls back whenever a
   snapshot disagrees. Everything else (the opponent, the brainrot,
   chaos events) is smoothed in the view layer.

   Host and client run byte-identical `stepSim` code, so moving the
   host into a Node process later is a lift-and-shift.
   ============================================================ */

import { Emitter, clamp } from '../core/util.js';
import { DT, CFG, createSim, stepSim, encodeState, decodeState, statsFor, variantForSeed } from './sim.js';
import { M, S, P, packInput, unpackInput, validPeerMsg } from '../net/protocol.js';
import { BotAI } from '../net/bot.js';
import { matchBrainrot } from '../data/brainrots.js';

const SNAPSHOT_EVERY = 3;      // ticks -> 20Hz
const INPUT_EVERY = 2;         // ticks -> 30Hz
const MAX_CATCHUP = 6;         // ticks per frame, prevents death spirals
const MAX_ROLLBACK = 40;

const IDLE_INPUT = { x: 0, z: 0, dash: false, taunt: false, a0: false, a1: false, a2: false };

/* ============================================================
   Shared base
   ============================================================ */
class BaseSession extends Emitter {
  constructor(o) {
    super();
    this.transport = o.transport;
    this.idx = o.idx | 0;
    this.seed = o.seed >>> 0;
    this.opp = o.opp;
    this.mode = o.mode || 'online';
    this.readInput = o.readInput || (() => IDLE_INPUT);
    this.brainrot = matchBrainrot(this.seed);
    // Online both sides derive the variant from the shared seed, so it needs
    // no wire field; practice can be told explicitly.
    this.variant = o.variant || variantForSeed(this.seed);
    this.sim = createSim(this.seed, { brainrotId: this.brainrot.id, variant: this.variant });
    this.fx = [];
    this.acc = 0;
    this.running = false;
    this.finished = false;
    this.peerGone = false;
    this.rtt = 0;
    this._offs = [];
    this._bindTransport();
  }

  _bindTransport() {
    const t = this.transport;
    if (!t) return;
    this._offs.push(t.on('message', (m) => {
      if (!m) return;
      if (m.t === S.RELAY) {
        if (!validPeerMsg(m.d)) return;
        this._onPeer(m.d);
      } else if (m.t === S.PEER_GONE) {
        this._onPeerGone();
      }
    }));
    this._offs.push(t.on('close', () => this._onPeerGone()));
  }

  _send(k, extra) { this.transport?.send({ t: M.RELAY, d: { k, ...extra } }); }

  _onPeer(_d) {}

  _onPeerGone() {
    if (this.peerGone || this.finished) return;
    this.peerGone = true;
    this.emit('peerLeft');
  }

  start() { this.running = true; this.acc = 0; this.emit('start'); }

  /** advance real time; returns the number of fixed ticks consumed */
  update(dt) {
    if (!this.running) return 0;
    this.acc += Math.min(dt, 0.25);
    let n = 0;
    while (this.acc >= DT && n < MAX_CATCHUP) {
      this.acc -= DT;
      this._fixed();
      n++;
    }
    if (n === MAX_CATCHUP) this.acc = 0;   // we are hopelessly behind; drop the backlog
    return n;
  }

  _fixed() {}

  drainFx() {
    if (!this.fx.length) return EMPTY;
    const out = this.fx;
    this.fx = [];
    return out;
  }

  sendEmote(id) { this._send(P.EMOTE, { e: id }); }

  dispose() {
    this.running = false;
    for (const off of this._offs) off();
    this._offs.length = 0;
    try { this.transport?.send({ t: M.LEAVE }); } catch (_) {}
    try { this.transport?.close(); } catch (_) {}
    this.clear();
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    this.emit('ended', {
      sim: this.sim,
      me: statsFor(this.sim, this.idx),
      them: statsFor(this.sim, 1 - this.idx),
      winner: this.sim.winner,
      longestBonus: this.sim.longestBonus,
      brainrot: this.brainrot,
    });
  }
}
const EMPTY = [];

/* ============================================================
   HOST - authoritative
   ============================================================ */
export class HostSession extends BaseSession {
  constructor(o) {
    super(o);
    this.role = 'host';
    this.remoteInput = { x: 0, z: 0, dash: false, taunt: false };
    this.remoteLatch = { dash: false, taunt: false, a0: false, a1: false, a2: false };
    this.remoteTick = 0;
    this.pendingFx = [];
    this.sinceSnapshot = 0;
    this.lastInputAt = performance.now();
  }

  start() {
    super.start();
    this._send(P.CONFIG, { b: this.brainrot.id, seed: this.seed });
  }

  _onPeer(d) {
    switch (d.k) {
      case P.INPUT: {
        const inp = unpackInput(d.i);
        if (inp.tick < this.remoteTick - 120) return;    // stale / replayed
        this.remoteTick = Math.max(this.remoteTick, inp.tick);
        this.remoteInput.x = clamp(inp.x, -1, 1);
        this.remoteInput.z = clamp(inp.z, -1, 1);
        if (inp.dash) this.remoteLatch.dash = true;
        if (inp.taunt) this.remoteLatch.taunt = true;
        if (inp.a0) this.remoteLatch.a0 = true;
        if (inp.a1) this.remoteLatch.a1 = true;
        if (inp.a2) this.remoteLatch.a2 = true;
        this.lastInputAt = performance.now();
        break;
      }
      case P.EMOTE: this.emit('emote', { who: 1 - this.idx, id: d.e }); break;
      case P.PING: this._send(P.PONG, { s: d.s }); break;
      case P.PONG: this.rtt = Date.now() - d.s; break;
      default: break;
    }
  }

  _fixed() {
    const mine = this.readInput();
    const theirs = {
      x: this.remoteInput.x, z: this.remoteInput.z,
      dash: this.remoteLatch.dash, taunt: this.remoteLatch.taunt,
      a0: this.remoteLatch.a0, a1: this.remoteLatch.a1, a2: this.remoteLatch.a2,
    };
    this.remoteLatch.dash = false;
    this.remoteLatch.taunt = false;
    this.remoteLatch.a0 = this.remoteLatch.a1 = this.remoteLatch.a2 = false;

    const inputs = this.idx === 0 ? [mine, theirs] : [theirs, mine];

    const before = this.fx.length;
    stepSim(this.sim, inputs, this.fx);
    for (let i = before; i < this.fx.length; i++) this.pendingFx.push(this.fx[i]);

    this.sinceSnapshot++;
    if (this.sinceSnapshot >= SNAPSHOT_EVERY) {
      this.sinceSnapshot = 0;
      this._send(P.SNAPSHOT, {
        s: encodeState(this.sim),
        hi: [Math.round(mine.x * 127), Math.round(mine.z * 127)],
        f: this.pendingFx.length ? this.pendingFx : undefined,
        ts: Date.now(),
      });
      this.pendingFx = [];
    }

    if (this.sim.phase === 'over' && this.sim.phaseT <= 0) {
      this._send(P.RESULT, { s: encodeState(this.sim) });
      this._finish();
    }
  }

  /** the peer vanished: freeze the round and hand the win to whoever is left */
  forfeit() {
    if (this.finished) return;
    const s = this.sim;
    s.phase = 'over';
    s.phaseT = 0;
    s.timeLeft = 0;
    s.winner = this.idx;
    s.players[this.idx].score = Math.max(s.players[this.idx].score, s.players[1 - this.idx].score + 1);
    this._finish();
  }
}

/* ============================================================
   CLIENT - predicts locally, reconciles against snapshots
   ============================================================ */
export class ClientSession extends BaseSession {
  constructor(o) {
    super(o);
    this.role = 'client';
    this.auth = createSim(this.seed, { brainrotId: this.brainrot.id, variant: this.variant });
    this.authTick = 0;
    this.history = new Map();      // tick -> input
    this.sinceInput = 0;
    this.pendingDash = false;
    this.pendingTaunt = false;
    this.pendingA = [false, false, false];
    this.hostInput = { x: 0, z: 0, dash: false, taunt: false };
    this.gotSnapshot = false;
    this.lastSnapAt = 0;
    this.resimCount = 0;
    this._pingTimer = 0;
  }

  _onPeer(d) {
    switch (d.k) {
      case P.CONFIG:
        if (d.b) this.brainrot = matchBrainrot(this.seed);
        break;
      case P.SNAPSHOT:
        this._onSnapshot(d);
        break;
      case P.RESULT:
        decodeState(d.s, this.sim);
        this._finish();
        break;
      case P.EMOTE: this.emit('emote', { who: 1 - this.idx, id: d.e }); break;
      case P.PING: this._send(P.PONG, { s: d.s }); break;
      case P.PONG: this.rtt = Date.now() - d.s; break;
      default: break;
    }
  }

  _onSnapshot(d) {
    decodeState(d.s, this.auth);
    this.authTick = this.auth.tick;
    this.gotSnapshot = true;
    this.lastSnapAt = performance.now();
    if (d.hi) { this.hostInput.x = d.hi[0] / 127; this.hostInput.z = d.hi[1] / 127; }
    if (d.f) for (const f of d.f) this.fx.push(f);

    /* --- rollback + replay our own inputs on top --- */
    const localTick = this.sim.tick;
    decodeState(d.s, this.sim);
    let n = localTick - this.authTick;
    if (n > MAX_ROLLBACK) n = MAX_ROLLBACK;
    this.resimCount = Math.max(0, n);
    for (let t = this.authTick + 1; t <= localTick; t++) {
      const mine = this.history.get(t) || IDLE_INPUT;
      const theirs = { x: this.hostInput.x, z: this.hostInput.z, dash: false, taunt: false,
        a0: false, a1: false, a2: false };
      stepSim(this.sim, this.idx === 0 ? [mine, theirs] : [theirs, mine], null);
    }
    // forget inputs the host has already consumed
    for (const t of this.history.keys()) if (t < this.authTick - 4) this.history.delete(t);

    if (this.sim.phase === 'over' && this.sim.phaseT <= 0) this._finish();
  }

  _fixed() {
    const mine = this.readInput();
    if (mine.dash) this.pendingDash = true;
    if (mine.taunt) this.pendingTaunt = true;
    if (mine.a0) this.pendingA[0] = true;
    if (mine.a1) this.pendingA[1] = true;
    if (mine.a2) this.pendingA[2] = true;

    const tick = this.sim.tick + 1;
    const stored = { x: mine.x, z: mine.z, dash: mine.dash, taunt: mine.taunt,
      a0: mine.a0, a1: mine.a1, a2: mine.a2 };
    this.history.set(tick, stored);

    // local-only feedback so buttons feel instant even at high ping
    if (mine.dash && this.sim.players[this.idx].dashCd <= 0) {
      const p = this.sim.players[this.idx];
      this.fx.push({ t: 'dash', p: this.idx, x: p.x, y: p.y, z: p.z, dx: Math.cos(p.face), dz: Math.sin(p.face), local: true });
    }
    if (mine.taunt) {
      const p = this.sim.players[this.idx];
      this.fx.push({ t: 'taunt', p: this.idx, x: p.x, y: p.y, z: p.z, local: true });
    }

    const theirs = { x: this.hostInput.x, z: this.hostInput.z, dash: false, taunt: false,
      a0: false, a1: false, a2: false };
    stepSim(this.sim, this.idx === 0 ? [stored, theirs] : [theirs, stored], null);

    this.sinceInput++;
    const urgent = this.pendingDash || this.pendingTaunt
      || this.pendingA[0] || this.pendingA[1] || this.pendingA[2];
    if (this.sinceInput >= INPUT_EVERY || urgent) {
      this.sinceInput = 0;
      this._send(P.INPUT, {
        i: packInput(tick, {
          x: mine.x, z: mine.z, dash: this.pendingDash, taunt: this.pendingTaunt,
          a0: this.pendingA[0], a1: this.pendingA[1], a2: this.pendingA[2],
        }),
      });
      this.pendingDash = false;
      this.pendingTaunt = false;
      this.pendingA[0] = this.pendingA[1] = this.pendingA[2] = false;
    }

    if (++this._pingTimer >= 120) { this._pingTimer = 0; this._send(P.PING, { s: Date.now() }); }
  }

  /** how stale the authoritative state is, for the connection indicator */
  get staleness() {
    return this.gotSnapshot ? (performance.now() - this.lastSnapAt) / 1000 : 99;
  }
}

/* ============================================================
   BOT PEER - the far end of the practice loopback.
   Runs whichever role the human is NOT running.
   ============================================================ */
export class BotPeer {
  constructor(o) {
    this.ai = new BotAI(o.idx, o.difficulty, o.seed ^ 0x9e37);
    this.session = o.host
      ? new HostSession({ ...o, readInput: () => this._think() })
      : new ClientSession({ ...o, readInput: () => this._think() });
    this.dt = DT;
  }
  _think() {
    return this.ai.step(this.session.sim, this.dt);
  }
  start() { this.session.start(); }
  update(dt) { this.session.update(dt); this.session.drainFx(); }
  dispose() { this.session.dispose(); }
}

/* ============================================================
   Factory
   ============================================================ */
export function createSession(info, readInput) {
  const base = {
    transport: info.transport,
    idx: info.idx,
    seed: info.seed,
    opp: info.opp,
    mode: info.mode,
    variant: info.variant,
    readInput,
  };
  const session = info.host ? new HostSession(base) : new ClientSession(base);

  let bot = null;
  if (info.bot) {
    bot = new BotPeer({
      transport: info.bot.transport,
      idx: info.bot.idx,
      host: info.bot.host,
      seed: info.seed,
      opp: info.opp,
      mode: 'practice',
      variant: info.variant,
      difficulty: info.bot.difficulty,
    });
  }
  return { session, bot };
}

export { CFG, DT };
