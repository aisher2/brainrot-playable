/* ============================================================
   protocol.js - the wire contract.

   Two layers:
     1. CLIENT <-> SERVER   matchmaking + relay  (M_*)
     2. PEER   <-> PEER     gameplay, tunnelled through the relay (P_*)

   The server never simulates; it pairs players and forwards bytes.
   One of the two peers is elected host and runs the authoritative
   simulation. Swapping in a real authoritative server later means
   implementing the P_* half server-side - nothing else changes.
   ============================================================ */

export const PROTOCOL_VERSION = 1;

/* ---------- client -> server ---------- */
export const M = {
  HELLO:  'hello',
  QUEUE:  'queue',
  CANCEL: 'cancel',
  MAKE_ROOM: 'mkroom',    // "play with a friend": mint a code
  JOIN_ROOM: 'joinroom',  // ...and redeem one
  RELAY:  'rly',
  LEAVE:  'bye',
  PING:   'ping',
};

/* ---------- server -> client ---------- */
export const S = {
  WELCOME:  'welcome',
  QUEUED:   'queued',
  ROOM:     'room',       // here is your friend code
  MATCH:    'match',
  RELAY:    'rly',
  PEER_GONE:'gone',
  PONG:     'pong',
  ERROR:    'err',
};

/* ---------- peer <-> peer (inside RELAY.d) ---------- */
export const P = {
  SNAPSHOT: 'S',   // host -> client, 20Hz
  INPUT:    'I',   // client -> host, 30Hz
  CONFIG:   'C',   // host -> client, once
  READY:    'R',   // both, once
  RESULT:   'E',   // host -> client, end of round
  EMOTE:    'M',   // cosmetic, either direction
  PING:     'P',
  PONG:     'Q',
  REMATCH:  'A',
};

/* ------------------------------------------------------------
   input packing - 5 numbers instead of an object, sent 30x/sec
   ------------------------------------------------------------ */
export function packInput(tick, inp) {
  return [
    tick,
    Math.round(inp.x * 127),
    Math.round(inp.z * 127),
    (inp.dash ? 1 : 0) | (inp.taunt ? 2 : 0)
      | (inp.a0 ? 4 : 0) | (inp.a1 ? 8 : 0) | (inp.a2 ? 16 : 0),
  ];
}

export function unpackInput(a) {
  const f = a[3];
  return {
    tick: a[0],
    x: a[1] / 127,
    z: a[2] / 127,
    dash: !!(f & 1),
    taunt: !!(f & 2),
    a0: !!(f & 4),
    a1: !!(f & 8),
    a2: !!(f & 16),
  };
}

/* ------------------------------------------------------------
   framing
   ------------------------------------------------------------ */
export function encodeMsg(obj) {
  return JSON.stringify(obj);
}

export function decodeMsg(raw) {
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/** Sanity-check anything arriving from the network before it reaches the sim. */
export function validPeerMsg(m) {
  if (!m || typeof m !== 'object' || typeof m.k !== 'string') return false;
  switch (m.k) {
    case P.SNAPSHOT: return Array.isArray(m.s) && m.s.length > 20 && m.s.length < 4000;
    case P.INPUT:    return Array.isArray(m.i) && m.i.length === 4 && m.i.every(Number.isFinite);
    case P.CONFIG:   return typeof m.b === 'string' && m.b.length < 40;
    case P.RESULT:   return Array.isArray(m.s);
    case P.EMOTE:    return typeof m.e === 'string' && m.e.length < 20;
    default:         return true;
  }
}

/** Default relay endpoint: same origin as the page, /ws path. */
export function defaultServerUrl() {
  try {
    const loc = globalThis.location;
    if (!loc || !loc.host) return '';
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${loc.host}/ws`;
  } catch (_) {
    return '';
  }
}
