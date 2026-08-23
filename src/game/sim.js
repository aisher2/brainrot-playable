/* ============================================================
   sim.js - the authoritative game simulation.

   Hard rules for this file:
     * fixed 60Hz timestep, never variable
     * no Math.random - only the seeded RNG carried in the state
     * no DOM, no audio, no rendering
   That makes it safe to run on the host, re-run on the client for
   prediction/rollback, and (unchanged) inside a Node server later.
   ============================================================ */

import { RNG, clamp, TAU } from '../core/util.js';
import {
  A, groundInfo, resolveSolids, onBouncePad, speedZoneAt, randomSpot, staticHeight,
} from './arena.js';

export const DT = 1 / 60;

export const CFG = {
  ROUND_TIME: 60,
  COUNTDOWN: 3.6,
  OVER_HOLD: 1.2,

  P_RADIUS: 0.85,
  SPEED: 12.6,
  ACCEL: 92,
  AIR_ACCEL: 34,
  FRICTION: 11,
  HOLDER_SPEED: 0.94,        // holding the brainrot slows you a touch
  GRAVITY: -31,

  DASH_SPEED: 30,
  DASH_TIME: 0.17,
  DASH_CD: 1.0,
  DASH_HIT_R: 1.85,

  KNOCK: 25,
  KNOCK_UP: 8.5,
  STUN: 0.75,
  MEGA_KNOCK: 46,

  BOUNCE_VY: 15.5,
  /* The roaming platforms are trampolines: landing on one launches you well
     above a normal jump, and the harder you come down the higher you go. */
  TRAMP_VY: 18.5,
  TRAMP_IMPACT: 0.3,
  TRAMP_BONUS_MAX: 4,
  ZONE_PUSH: 26,
  ZONE_MAX: 22,

  BR_RADIUS: 0.62,
  BR_PICK_R: 1.5,
  BR_HOVER: 1.85,            // height above the holder's centre
  BR_POP_VY: 12,
  BR_POP_SPREAD: 9,
  BR_DROP_LOCK: 0.55,        // ex-holder cannot re-grab for this long
  BR_GLOBAL_LOCK: 0.14,

  SCORE_RATE: 4,             // +1 every 0.25s
  STEAL_BONUS: 10,
  DASH_HIT_BONUS: 5,
  LONGEST_HOLD_BONUS: 20,
  STEAL_WINDOW: 8,           // seconds after a drop that a pickup counts as a steal

  /* TAG BOMB. One bomb, one continuous fuse, and the only way to get rid of
     it is to physically catch the other player. Whoever is holding it when
     the fuse runs out loses the round outright - there is no score to fall
     back on, which is what makes the last seconds worth playing. */
  BOMB_MIN: 15,              // fuse is rolled per round, so no two feel alike
  BOMB_MAX: 25,
  TAG_R: 1.9,                // how close the holder must get to pass it on
  TAG_COOLDOWN: 0.5,         // stops the bomb ping-ponging on one collision
  TAG_PUSH: 9,               // shove them apart so the next tag has to be earned
  BLAST_STUN: 1.5,
  BLAST_PUSH: 16,

  EVENT_MIN: 10,
  EVENT_MAX: 15,
  EVENT_FIRST: 8,
  HAZARD_EVERY: 7.5,
  HAZARD_LIFE: 5,
  HAZARD_R: 2.6,
  HAZARD_SLOW: 0.42,

  /* ---- abilities (identical on desktop and mobile) ---- */
  /* Abilities are not on a timer any more: you have to pick them up off the
     floor. ABILITY_LOCK is only an anti-double-fire guard, not a cooldown. */
  ABILITY_LOCK: 0.4,
  ORB_GRAB: 1.35,            // how close you must get to collect one
  ORB_MAX: 6,                // alive at once (always an even number - see below)
  ORB_FIRST: 1.2,            // first drop after GO
  ORB_EVERY: 5.0,            // seconds between drops
  ORB_STACK: 2,              // charges you can bank per ability
  ORB_LIFE: 24,              // uncollected orbs eventually fade

  KICK_CD: 5,                // legacy tuning, kept for the kick's own timing
  KICK_WINDUP: 0.12,
  KICK_RANGE: 3.4,
  KICK_ARC: 1.15,            // half-angle, radians
  KICK_KNOCK: 34,
  KICK_UP: 10,
  KICK_STUN: 0.95,
  KICK_BONUS: 5,

  BANANA_CD: 7,              // E / the banana button
  BANANA_MAX: 2,             // per player, oldest is recycled
  BANANA_LIFE: 9,
  BANANA_THROW: 13,
  BANANA_R: 0.95,
  SLIP_TIME: 1.1,
  SLIP_BONUS: 5,

  ULT_CD: 26,                // R / the crown button
  ULT_TIME: 1.5,
  ULT_PULL: 46,              // how hard the brainrot is yanked toward you
  ULT_RANGE: 26,

  DECOY_COUNT: 5,
  FRENZY_TIME: 8,
  SPEED_TIME: 5,
  SPEED_MULT: 1.75,
  FREEZE_TIME: 2,
  GOLDEN_TIME: 5,
};

export const EVENTS = {
  FRENZY:   { id: 'FRENZY',   label: '🧠 BRAINROT FRENZY!', sub: 'only one is real', dur: CFG.FRENZY_TIME },
  SPEED:    { id: 'SPEED',    label: '⚡ SPEED BRAINROT!',  sub: 'everyone is fast',  dur: CFG.SPEED_TIME },
  TELEPORT: { id: 'TELEPORT', label: '🌀 CHAOS TELEPORT!',  sub: 'good luck',         dur: 0.6 },
  FREEZE:   { id: 'FREEZE',   label: '🧊 FREEZE!',          sub: 'someone got iced',  dur: CFG.FREEZE_TIME },
  MEGA:     { id: 'MEGA',     label: '💥 MEGA KNOCKBACK!',  sub: 'byeeee',            dur: 0.8 },
  GOLDEN:   { id: 'GOLDEN',   label: '👑 GOLDEN BRAINROT!', sub: 'double points',     dur: CFG.GOLDEN_TIME },
};
const EVENT_IDS = ['FRENZY', 'SPEED', 'TELEPORT', 'FREEZE', 'MEGA', 'GOLDEN'];

/**
 * The three abilities. Cooldowns and effects are identical on every
 * platform - only the way you trigger them differs (Q/E/R vs. a button).
 */
/**
 * The three abilities. None of them are available by default: each one has to
 * be collected as an orb from the arena floor, and using it spends a charge.
 */
/**
 * Round variants. `classic` is the original: hold the brainrot to score.
 * `tagbomb` inverts it - the thing is a bomb, holding is the danger, and the
 * only way to pass it is to catch the other player.
 *
 * The relay decides which one an online match plays and tells both clients,
 * so two people only ever meet someone who picked the same mode.
 */
export const VARIANTS = ['classic', 'tagbomb'];


/**
 * TAG BOMB rolls its round length from the seed, so both clients agree on it
 * without another wire field and no two rounds feel identical.
 */
export function bombSeconds(seed) {
  let h = (seed >>> 0) ^ 0x27d4eb2f;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  return CFG.BOMB_MIN + (h % 1000) / 1000 * (CFG.BOMB_MAX - CFG.BOMB_MIN);
}

/** Which player starts holding it. Also seed-derived, so it is agreed. */
export function firstHolder(seed) {
  let h = (seed >>> 0) ^ 0x165667b1;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) & 1;
}

export const ABILITIES = [
  { slot: 0, id: 'kick',   key: 'Q', icon: '🦵', name: 'YEET KICK' },
  { slot: 1, id: 'banana', key: 'E', icon: '🍌', name: 'BANANA SLIP' },
  { slot: 2, id: 'ult',    key: 'R', icon: '👑', name: 'BRAINROT MAGNET' },
];

export const SPAWNS = [
  { x: 0, z: 11, face: -Math.PI / 2 },
  { x: 0, z: -11, face: Math.PI / 2 },
];

/* ------------------------------------------------------------
   state
   ------------------------------------------------------------ */
function newPlayer(i) {
  const s = SPAWNS[i];
  return {
    x: s.x, y: 0, z: s.z,
    vx: 0, vy: 0, vz: 0,
    face: s.face,
    onGround: true, mover: -1,
    dashT: 0, dashCd: 0, dashX: 0, dashZ: 1,
    stunT: 0, freezeT: 0, speedT: 0, slowT: 0, tauntT: 0,
    lockT: 0,                 // cannot pick the brainrot up while > 0
    cd0: 0, cd1: 0, cd2: 0,   // ability cooldowns, seconds remaining
    ch0: 0, ch1: 0, ch2: 0,   // banked ability charges, earned from orbs
    tags: 0,                  // TAG BOMB: successful passes made
    kickT: 0,                 // kick wind-up / follow-through
    ultT: 0,                  // magnet is pulling
    slipT: 0,                 // face-down on a banana
    score: 0, acc: 0,
    holdTime: 0, curHold: 0, longestHold: 0, goldenTime: 0,
    steals: 0, dashHits: 0, pickups: 0, bonked: 0, abilityHits: 0,
    lastSecondSteal: 0,
    maxDeficit: 0,
    anim: 0,                  // 0 idle 1 hit 2 dash 3 taunt 4 bounce 5 kick 6 slip 7 ult
    animT: 0,
  };
}

export function createSim(seed = 1, opts = {}) {
  const s = {
    tick: 0,
    t: 0,
    phase: 'countdown',
    phaseT: CFG.COUNTDOWN,
    timeLeft: CFG.ROUND_TIME,
    seed: seed >>> 0,
    rs: (seed >>> 0) || 1,
    players: [newPlayer(0), newPlayer(1)],
    br: {
      x: 0, y: A.DAIS_H + 2.2, z: 0, vx: 0, vy: 0, vz: 0,
      owner: -1, lastOwner: -1, sinceDrop: 99, lock: 0,
      golden: 0, spin: 0, settled: false,
      fuse: 0,                // hot potato: seconds before it goes off
    },
    decoys: [],
    variant: VARIANTS.includes(opts.variant) ? opts.variant : 'classic',
    tagCd: 0,                 // brief lock after a tag so it cannot bounce back
    bananas: [],
    orbs: [],
    orbTimer: CFG.ORB_FIRST,
    hazards: [],
    ev: { id: '', t: 0, dur: 0, target: -1 },
    evTimer: CFG.EVENT_FIRST,
    hazTimer: CFG.HAZARD_EVERY,
    eventsSeen: 0,
    winner: -2,               // -2 running, -1 draw, 0/1 player index
    longestBonus: -1,
    lastEvent: '',
    brainrotId: opts.brainrotId || 'banana',
  };
  /* TAG BOMB starts armed: someone is already holding it when GO lands, and
     the round IS the fuse. */
  if (s.variant === 'tagbomb') {
    s.timeLeft = bombSeconds(seed);
    const who = firstHolder(seed);
    s.br.owner = who;
    s.br.fuse = s.timeLeft;
  }

  return s;
}

const rng = new RNG(1);
function R(s) { rng.s = s.rs; return rng; }
function saveR(s) { s.rs = rng.s; }

/* ------------------------------------------------------------
   step
   ------------------------------------------------------------ */
const _g = { h: 0, vx: 0, vz: 0, mover: -1 };
const _zone = { x: 0, z: 0 };

/**
 * Advance exactly one tick.
 * @param s      sim state (mutated)
 * @param inputs [{x,z,dash,taunt},{...}]
 * @param fx     optional array; effect events are pushed here for the
 *               presentation layer. Pass null during client prediction.
 */
export function stepSim(s, inputs, fx = null) {
  s.tick++;
  s.t += DT;

  if (s.phase === 'countdown') {
    s.phaseT -= DT;
    stepBrainrot(s, fx);
    if (s.phaseT <= 0) { s.phase = 'play'; s.phaseT = 0; if (fx) fx.push({ t: 'go' }); }
    // players are frozen in place but still fall onto the floor
    for (let i = 0; i < 2; i++) settle(s.players[i], s);
    return s;
  }

  if (s.phase === 'over') {
    s.phaseT -= DT;
    for (let i = 0; i < 2; i++) { const p = s.players[i]; p.vx *= 0.86; p.vz *= 0.86; settle(p, s); }
    stepBrainrot(s, fx);
    return s;
  }

  /* ---------------- play ---------------- */
  s.timeLeft = Math.max(0, s.timeLeft - DT);

  stepEvents(s, fx);
  stepHazards(s, fx);

  for (let i = 0; i < 2; i++) stepPlayer(s, i, inputs[i] || ZERO_IN, fx);
  separatePlayers(s);
  stepDashHits(s, fx);
  stepKicks(s, fx);
  stepBananas(s, fx);
  stepOrbs(s, fx);
  stepUltimates(s, fx);
  stepBrainrot(s, fx);
  stepPickups(s, fx);
  stepTagBomb(s, fx);
  stepScoring(s, fx);

  if (s.timeLeft <= 0) endRound(s, fx);
  return s;
}

const ZERO_IN = { x: 0, z: 0, dash: false, taunt: false };

/* ---------------- players ---------------- */
function stepPlayer(s, i, input, fx) {
  const p = s.players[i];
  const other = s.players[1 - i];

  p.dashCd = Math.max(0, p.dashCd - DT);
  p.stunT = Math.max(0, p.stunT - DT);
  p.freezeT = Math.max(0, p.freezeT - DT);
  p.speedT = Math.max(0, p.speedT - DT);
  p.slowT = Math.max(0, p.slowT - DT);
  p.tauntT = Math.max(0, p.tauntT - DT);
  p.cd0 = Math.max(0, p.cd0 - DT);
  p.cd1 = Math.max(0, p.cd1 - DT);
  p.cd2 = Math.max(0, p.cd2 - DT);
  p.kickT = Math.max(0, p.kickT - DT);
  p.ultT = Math.max(0, p.ultT - DT);
  p.slipT = Math.max(0, p.slipT - DT);
  p.lockT = Math.max(0, p.lockT - DT);
  p.animT = Math.max(0, p.animT - DT);
  if (p.animT <= 0) p.anim = 0;

  const frozen = p.freezeT > 0;
  const stunned = p.stunT > 0 || p.slipT > 0;
  const canAct = !frozen && !stunned;

  let ix = input.x || 0, iz = input.z || 0;
  const mag = Math.hypot(ix, iz);
  if (mag > 1) { ix /= mag; iz /= mag; }

  /* --- dash --- */
  if (p.dashT > 0) {
    p.dashT -= DT;
    if (p.dashT <= 0) { p.dashT = 0; }
  } else if (canAct && input.dash && p.dashCd <= 0) {
    let dx = ix, dz = iz;
    if (!dx && !dz) { dx = Math.cos(p.face); dz = Math.sin(p.face); }
    const l = Math.hypot(dx, dz) || 1;
    p.dashX = dx / l; p.dashZ = dz / l;
    p.dashT = CFG.DASH_TIME;
    p.dashCd = CFG.DASH_CD;
    p.anim = 2; p.animT = 0.32;
    p.face = Math.atan2(p.dashZ, p.dashX);
    if (fx) fx.push({ t: 'dash', p: i, x: p.x, y: p.y, z: p.z, dx: p.dashX, dz: p.dashZ });
  }

  if (canAct && input.taunt && p.tauntT <= 0 && p.dashT <= 0) {
    p.tauntT = 1.1; p.anim = 3; p.animT = 1.1;
    if (fx) fx.push({ t: 'taunt', p: i, x: p.x, y: p.y, z: p.z });
  }

  /* --- abilities. Aim comes from wherever you are already facing, so a
         phone needs no second stick and a keyboard needs no mouse. --- */
  if (canAct) {
    if (input.a0 && p.cd0 <= 0 && p.ch0 > 0) {
      p.ch0--;
      p.cd0 = CFG.ABILITY_LOCK;
      p.kickT = CFG.KICK_WINDUP;
      p.anim = 5; p.animT = 0.42;
      if (ix || iz) p.face = Math.atan2(iz, ix);
      if (fx) fx.push({ t: 'kick', p: i, x: p.x, y: p.y, z: p.z, face: p.face });
    }
    if (input.a1 && p.cd1 <= 0 && p.ch1 > 0) {
      p.ch1--;
      p.cd1 = CFG.ABILITY_LOCK;
      p.anim = 3; p.animT = 0.3;
      if (ix || iz) p.face = Math.atan2(iz, ix);
      throwBanana(s, i, fx);
    }
    if (input.a2 && p.cd2 <= 0 && p.ch2 > 0 && s.variant !== 'tagbomb') {
      p.ch2--;
      p.cd2 = CFG.ABILITY_LOCK;
      p.ultT = CFG.ULT_TIME;
      p.anim = 7; p.animT = CFG.ULT_TIME;
      if (fx) fx.push({ t: 'ult', p: i, x: p.x, y: p.y, z: p.z });
    }
  }

  /* --- movement --- */
  let speed = CFG.SPEED;
  if (s.br.owner === i) speed *= CFG.HOLDER_SPEED;
  if (p.speedT > 0) speed *= CFG.SPEED_MULT;
  if (p.slowT > 0) speed *= CFG.HAZARD_SLOW;

  if (p.dashT > 0) {
    const ds = CFG.DASH_SPEED * (p.speedT > 0 ? 1.25 : 1);
    p.vx = p.dashX * ds;
    p.vz = p.dashZ * ds;
  } else if (canAct && (ix || iz)) {
    const accel = p.onGround ? CFG.ACCEL : CFG.AIR_ACCEL;
    p.vx += ix * accel * DT;
    p.vz += iz * accel * DT;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > speed) { const k = speed / sp; p.vx *= k; p.vz *= k; }
    p.face = Math.atan2(iz, ix);
  } else {
    const f = Math.exp(-(p.onGround ? CFG.FRICTION : 1.6) * DT);
    p.vx *= f; p.vz *= f;
  }

  /* --- speed zones give the outer ring a racetrack feel --- */
  if (p.onGround && speedZoneAt(p.x, p.z, _zone)) {
    p.vx += _zone.x * CFG.ZONE_PUSH * DT;
    p.vz += _zone.z * CFG.ZONE_PUSH * DT;
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > CFG.ZONE_MAX) { const k = CFG.ZONE_MAX / sp; p.vx *= k; p.vz *= k; }
    if (fx && (s.tick % 4 === 0)) fx.push({ t: 'zone', p: i, x: p.x, y: p.y, z: p.z });
  }

  /* --- integrate --- */
  p.vy += CFG.GRAVITY * DT;
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  p.z += p.vz * DT;

  resolveSolids(p, CFG.P_RADIUS);
  const fallVy = p.vy;                    // settle() zeroes this on landing
  settle(p, s);

  /* --- bounce pads --- */
  if (p.onGround) {
    const pad = onBouncePad(p.x, p.z);
    if (pad >= 0 && staticHeight(p.x, p.z) < 0.3) {
      p.vy = CFG.BOUNCE_VY;
      p.onGround = false;
      p.anim = 4; p.animT = 0.4;
      if (fx) fx.push({ t: 'bounce', p: i, x: p.x, y: p.y, z: p.z, pad });
    }
  }

  /* --- the roaming platforms are trampolines --- */
  if (p.onGround && p.mover >= 0) {
    const impact = Math.max(0, -fallVy);
    p.vy = CFG.TRAMP_VY + Math.min(impact * CFG.TRAMP_IMPACT, CFG.TRAMP_BONUS_MAX);
    p.onGround = false;
    p.mover = -1;
    p.anim = 4; p.animT = 0.42;
    if (fx) fx.push({ t: 'tramp', p: i, x: p.x, y: p.y, z: p.z, power: p.vy });
  }

  /* --- hazard zones --- */
  for (let h = 0; h < s.hazards.length; h++) {
    const hz = s.hazards[h];
    if (hz.warm > 0) continue;
    const dx = p.x - hz.x, dz = p.z - hz.z;
    if (dx * dx + dz * dz < hz.r * hz.r && p.y < hz.y + 1.4) {
      if (p.slowT <= 0 && fx) fx.push({ t: 'hazard', p: i, x: p.x, y: p.y, z: p.z });
      p.slowT = 0.35;
    }
  }
}

/** gravity resolution against the floor / platforms */
function settle(p, s) {
  groundInfo(p.x, p.z, p.y, s.t, _g);
  if (p.y <= _g.h + 0.001) {
    if (!p.onGround && p.vy < -9) {
      p.anim = 4; p.animT = 0.22;
    }
    p.y = _g.h;
    p.vy = 0;
    p.onGround = true;
    if (_g.mover >= 0) {
      p.x += _g.vx * DT;
      p.z += _g.vz * DT;
      p.mover = _g.mover;
    } else p.mover = -1;
  } else {
    p.onGround = false;
    p.mover = -1;
  }
}

function separatePlayers(s) {
  const a = s.players[0], b = s.players[1];
  const dx = b.x - a.x, dz = b.z - a.z;
  const min = CFG.P_RADIUS * 2;
  const d2 = dx * dx + dz * dz;
  if (d2 > min * min || d2 < 1e-8) return;
  const d = Math.sqrt(d2);
  const push = (min - d) / d * 0.5;
  a.x -= dx * push; a.z -= dz * push;
  b.x += dx * push; b.z += dz * push;
}

/* ---------------- dash hits ---------------- */
/* ---------------- YEET KICK: a cone in front of you ---------------- */
function stepKicks(s, fx) {
  for (let i = 0; i < 2; i++) {
    const a = s.players[i];
    // lands on the frame the wind-up expires
    if (a.kickT <= 0 || a.kickT > DT) continue;
    const b = s.players[1 - i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d > CFG.KICK_RANGE || Math.abs(b.y - a.y) > 2.2) continue;
    // inside the arc?
    const to = Math.atan2(dz, dx);
    let da = (to - a.face) % TAU;
    if (da > Math.PI) da -= TAU;
    if (da < -Math.PI) da += TAU;
    if (Math.abs(da) > CFG.KICK_ARC) continue;
    if (b.stunT > 0.35) continue;                    // no chain-stunning

    const nx = d > 0.001 ? dx / d : Math.cos(a.face);
    const nz = d > 0.001 ? dz / d : Math.sin(a.face);
    b.vx = nx * CFG.KICK_KNOCK;
    b.vz = nz * CFG.KICK_KNOCK;
    b.vy = CFG.KICK_UP;
    b.onGround = false;
    b.stunT = CFG.KICK_STUN;
    b.anim = 1; b.animT = CFG.KICK_STUN;
    b.bonked++;
    a.abilityHits++;
    if (s.variant !== 'tagbomb') a.score += CFG.KICK_BONUS;

    const hadBrainrot = s.br.owner === 1 - i;
    if (hadBrainrot) dropBrainrot(s, nx, nz, fx, true);
    if (fx) fx.push({ t: 'kickHit', p: i, v: 1 - i, x: b.x, y: b.y + 0.6, z: b.z, nx, nz, stole: hadBrainrot });
  }
}

/* ---------------- BANANA SLIP: a lobbed trap ---------------- */
function throwBanana(s, i, fx) {
  const p = s.players[i];
  const mine = s.bananas.filter((b) => b.owner === i);
  if (mine.length >= CFG.BANANA_MAX) {
    // recycle the oldest rather than growing the list without bound
    const oldest = mine.reduce((a, b) => (a.life <= b.life ? a : b));
    s.bananas.splice(s.bananas.indexOf(oldest), 1);
  }
  const cx = Math.cos(p.face), cz = Math.sin(p.face);
  s.bananas.push({
    x: p.x + cx * 0.9, y: p.y + 0.9, z: p.z + cz * 0.9,
    vx: cx * CFG.BANANA_THROW + p.vx * 0.4,
    vy: 6.5,
    vz: cz * CFG.BANANA_THROW + p.vz * 0.4,
    life: CFG.BANANA_LIFE, owner: i, armed: false,
  });
  if (fx) fx.push({ t: 'banana', p: i, x: p.x, y: p.y, z: p.z });
}

function stepBananas(s, fx) {
  for (let k = s.bananas.length - 1; k >= 0; k--) {
    const b = s.bananas[k];
    b.life -= DT;
    if (b.life <= 0) {
      if (fx) fx.push({ t: 'bananaGone', x: b.x, y: b.y, z: b.z });
      s.bananas.splice(k, 1);
      continue;
    }
    if (!b.armed) {
      b.vy += CFG.GRAVITY * DT;
      b.x += b.vx * DT; b.y += b.vy * DT; b.z += b.vz * DT;
      resolveSolids(b, 0.3);
      const floor = staticHeight(b.x, b.z) + 0.12;
      if (b.y <= floor) { b.y = floor; b.vx = b.vy = b.vz = 0; b.armed = true; }
      continue;
    }
    // armed: whoever is not the owner slips on it
    for (let i = 0; i < 2; i++) {
      if (i === b.owner) continue;
      const p = s.players[i];
      if (p.slipT > 0 || p.stunT > 0) continue;
      const dx = p.x - b.x, dz = p.z - b.z;
      if (dx * dx + dz * dz > CFG.BANANA_R * CFG.BANANA_R) continue;
      if (Math.abs(p.y - b.y) > 1.6) continue;

      p.slipT = CFG.SLIP_TIME;
      p.anim = 6; p.animT = CFG.SLIP_TIME;
      p.bonked++;
      const sp = Math.hypot(p.vx, p.vz) || 1;
      p.vx = (p.vx / sp) * 14; p.vz = (p.vz / sp) * 14;
      p.vy = 6;
      p.onGround = false;
      const thrower = s.players[b.owner];
      thrower.abilityHits++;
      if (s.variant !== 'tagbomb') thrower.score += CFG.SLIP_BONUS;
      const hadBrainrot = s.br.owner === i;
      if (hadBrainrot) dropBrainrot(s, p.vx / 14, p.vz / 14, fx, true);
      if (fx) fx.push({ t: 'slip', p: b.owner, v: i, x: p.x, y: p.y, z: p.z, stole: hadBrainrot });
      s.bananas.splice(k, 1);
      break;
    }
  }
}

/* ---------------- ULTIMATE: yank the brainrot to you ---------------- */
/* ---------------- ABILITY ORBS ----------------
   Abilities are earned, not timed. Orbs drop into the arena and grant one
   charge of whatever they hold. They always arrive in 180-degree mirrored
   pairs so neither spawn is ever closer to a drop than the other - the same
   fairness rule the maps follow. */
function orbKind(rng, s) {
  /* The magnet exists to rip a loose brainrot out of the air. In TAG BOMB
     the bomb is strapped on and never loose, so the ability has nothing to
     do - dropping one would just waste a pickup. Kick and banana split it. */
  if (s.variant === 'tagbomb') return rng.next() < 0.5 ? 0 : 1;
  const r = rng.next();
  if (r < 0.4) return 0;          // yeet kick
  if (r < 0.8) return 1;          // banana
  return 2;                        // magnet, the rarest
}

function stepOrbs(s, fx) {
  const rng = R(s);

  for (let k = s.orbs.length - 1; k >= 0; k--) {
    const o = s.orbs[k];
    o.life -= DT;
    if (o.life <= 0) {
      s.orbs.splice(k, 1);
      if (fx) fx.push({ t: 'orbGone', x: o.x, y: o.y, z: o.z, kind: o.kind });
    }
  }

  s.orbTimer -= DT;
  if (s.orbTimer <= 0 && s.orbs.length + 2 <= CFG.ORB_MAX) {
    s.orbTimer = CFG.ORB_EVERY;
    const kind = orbKind(rng, s);
    const spot = randomSpot(rng, 5, 15);
    for (const sgn of [1, -1]) {
      const x = spot.x * sgn, z = spot.z * sgn;
      s.orbs.push({ x, y: staticHeight(x, z) + 1.1, z, kind, life: CFG.ORB_LIFE });
      if (fx) fx.push({ t: 'orbDrop', x, y: staticHeight(x, z) + 1.1, z, kind });
    }
  }

  // collection
  for (let k = s.orbs.length - 1; k >= 0; k--) {
    const o = s.orbs[k];
    for (let i = 0; i < 2; i++) {
      const p = s.players[i];
      if (p.stunT > 0 || p.slipT > 0 || p.freezeT > 0) continue;
      const dx = p.x - o.x, dz = p.z - o.z;
      if (dx * dx + dz * dz > CFG.ORB_GRAB * CFG.ORB_GRAB) continue;
      if (Math.abs((p.y + 0.9) - o.y) > 2.4) continue;
      const key = 'ch' + o.kind;
      const full = p[key] >= CFG.ORB_STACK;
      if (!full) p[key]++;
      s.orbs.splice(k, 1);
      if (fx) fx.push({ t: 'orbGrab', p: i, x: o.x, y: o.y, z: o.z, kind: o.kind, full });
      break;
    }
  }

  saveR(s);
}

function stepUltimates(s, fx) {
  for (let i = 0; i < 2; i++) {
    const p = s.players[i];
    if (p.ultT <= 0) continue;
    const br = s.br;

    // rip it out of the other player's hands on the first frame
    if (br.owner === 1 - i && p.ultT > CFG.ULT_TIME - DT * 1.5) {
      const dx = p.x - br.x, dz = p.z - br.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d < CFG.ULT_RANGE) {
        dropBrainrot(s, dx / d, dz / d, fx, true);
        if (fx) fx.push({ t: 'ultRip', p: i, x: br.x, y: br.y, z: br.z });
      }
    }
    if (br.owner >= 0) continue;

    // then reel it in
    const dx = p.x - br.x, dz = p.z - br.z;
    const d = Math.hypot(dx, dz);
    if (d > CFG.ULT_RANGE || d < 0.001) continue;
    const pull = CFG.ULT_PULL * DT;
    br.vx += (dx / d) * pull;
    br.vz += (dz / d) * pull;
    if (br.y < staticHeight(br.x, br.z) + 1.2) br.vy = Math.max(br.vy, 3.5);
    br.settled = false;
  }
}

function stepDashHits(s, fx) {
  for (let i = 0; i < 2; i++) {
    const a = s.players[i], b = s.players[1 - i];
    if (a.dashT <= 0) continue;
    if (b.stunT > 0.35) continue;                 // no chain-stunning
    const dx = b.x - a.x, dz = b.z - a.z;
    const dy = Math.abs(b.y - a.y);
    if (dy > 2.0) continue;
    const d2 = dx * dx + dz * dz;
    if (d2 > CFG.DASH_HIT_R * CFG.DASH_HIT_R) continue;

    const d = Math.sqrt(d2) || 0.001;
    const nx = dx / d, nz = dz / d;
    const power = 1 + (a.speedT > 0 ? 0.35 : 0);
    b.vx = nx * CFG.KNOCK * power;
    b.vz = nz * CFG.KNOCK * power;
    b.vy = CFG.KNOCK_UP;
    b.onGround = false;
    b.stunT = CFG.STUN;
    b.anim = 1; b.animT = CFG.STUN;
    b.bonked++;
    a.dashT = 0;
    a.vx *= 0.25; a.vz *= 0.25;
    a.dashHits++;
    if (s.variant !== 'tagbomb') a.score += CFG.DASH_HIT_BONUS;

    const hadBrainrot = s.br.owner === 1 - i;
    if (hadBrainrot) dropBrainrot(s, nx, nz, fx, true);

    if (fx) fx.push({ t: 'hit', p: i, v: 1 - i, x: b.x, y: b.y + 0.6, z: b.z, nx, nz, stole: hadBrainrot });
  }
}

/* ---------------- the brainrot ---------------- */
function stepBrainrot(s, fx) {
  const br = s.br;
  br.spin += DT;
  br.lock = Math.max(0, br.lock - DT);
  br.sinceDrop += DT;
  if (br.golden > 0) {
    br.golden = Math.max(0, br.golden - DT);
    if (br.golden === 0 && fx) fx.push({ t: 'goldenEnd' });
  }

  if (br.owner >= 0) {
    const p = s.players[br.owner];
    br.x = p.x; br.z = p.z;
    br.y = p.y + CFG.BR_HOVER;
    br.vx = br.vy = br.vz = 0;
    br.settled = true;
    return;
  }

  br.vy += CFG.GRAVITY * 0.86 * DT;
  br.x += br.vx * DT;
  br.y += br.vy * DT;
  br.z += br.vz * DT;

  resolveSolids(br, CFG.BR_RADIUS);
  groundInfo(br.x, br.z, br.y, s.t, _g);
  const floor = _g.h + CFG.BR_RADIUS;
  if (br.y <= floor) {
    br.y = floor;
    if (br.vy < -2.2) {
      br.vy = -br.vy * 0.42;
      if (fx) fx.push({ t: 'brBounce', x: br.x, y: br.y, z: br.z });
    } else {
      br.vy = 0;
      br.settled = true;
    }
    const f = Math.exp(-5.5 * DT);
    br.vx *= f; br.vz *= f;
    if (_g.mover >= 0) { br.x += _g.vx * DT; br.z += _g.vz * DT; }
  } else {
    br.settled = false;
  }

  /* --- decoys use the same cheap physics --- */
  for (let i = 0; i < s.decoys.length; i++) {
    const d = s.decoys[i];
    d.life -= DT;
    d.spin += DT;
    d.vy += CFG.GRAVITY * 0.8 * DT;
    d.x += d.vx * DT; d.y += d.vy * DT; d.z += d.vz * DT;
    resolveSolids(d, CFG.BR_RADIUS);
    const gh = staticHeight(d.x, d.z) + CFG.BR_RADIUS;
    if (d.y <= gh) {
      d.y = gh;
      d.vy = d.vy < -2 ? -d.vy * 0.4 : 0;
      const f = Math.exp(-5 * DT);
      d.vx *= f; d.vz *= f;
    }
  }
  for (let i = s.decoys.length - 1; i >= 0; i--) {
    if (s.decoys[i].life <= 0) {
      if (fx) fx.push({ t: 'decoyPop', x: s.decoys[i].x, y: s.decoys[i].y, z: s.decoys[i].z });
      s.decoys.splice(i, 1);
    }
  }
}

function dropBrainrot(s, nx, nz, fx, popped) {
  const br = s.br;
  const old = br.owner;
  if (old < 0) return;
  /* TAG BOMB: the bomb is strapped on. Abilities knock you about but they
     must never shake it loose - a kick that removed the bomb would be an
     instant win, and the pass has to be earned with a tag. */
  if (s.variant === 'tagbomb') return;
  const p = s.players[old];
  br.owner = -1;
  br.lastOwner = old;
  br.sinceDrop = 0;
  br.lock = CFG.BR_GLOBAL_LOCK;
  br.x = p.x; br.z = p.z; br.y = p.y + CFG.BR_HOVER;
  const spread = popped ? CFG.BR_POP_SPREAD : 3;
  R(s);
  const jitter = rng.range(-0.6, 0.6);
  saveR(s);
  const ca = Math.cos(jitter), sa = Math.sin(jitter);
  br.vx = (nx * ca - nz * sa) * spread;
  br.vz = (nx * sa + nz * ca) * spread;
  br.vy = CFG.BR_POP_VY;
  br.settled = false;
  p.lockT = CFG.BR_DROP_LOCK;
  // banked hold time
  p.longestHold = Math.max(p.longestHold, p.curHold);
  p.curHold = 0;
  if (fx) fx.push({ t: 'drop', p: old, x: br.x, y: br.y, z: br.z });
}

function stepPickups(s, fx) {
  const br = s.br;
  // in TAG BOMB the bomb is never loose, so there is nothing to pick up
  if (s.variant === 'tagbomb') return;
  if (br.owner >= 0 || br.lock > 0) return;
  for (let i = 0; i < 2; i++) {
    const p = s.players[i];
    if (p.stunT > 0 || p.freezeT > 0 || p.lockT > 0) continue;
    const dx = br.x - p.x, dz = br.z - p.z;
    const dy = br.y - p.y;
    if (dx * dx + dz * dz > CFG.BR_PICK_R * CFG.BR_PICK_R) continue;
    if (dy < -1.2 || dy > 3.0) continue;

    br.owner = i;
    p.pickups++;
    p.curHold = 0;
    const wasSteal = br.lastOwner === 1 - i && br.sinceDrop < CFG.STEAL_WINDOW;
    if (wasSteal) {
      p.steals++;
      p.score += CFG.STEAL_BONUS;
      if (s.timeLeft <= 5) p.lastSecondSteal = 1;
    }
    if (fx) fx.push({ t: 'pickup', p: i, steal: wasSteal, x: br.x, y: br.y, z: br.z });
    break;
  }

  /* decoys pop and briefly slow whoever grabbed the wrong one */
  for (let i = s.decoys.length - 1; i >= 0; i--) {
    const d = s.decoys[i];
    for (let k = 0; k < 2; k++) {
      const p = s.players[k];
      const dx = d.x - p.x, dz = d.z - p.z;
      if (dx * dx + dz * dz < CFG.BR_PICK_R * CFG.BR_PICK_R && Math.abs(d.y - p.y) < 2.6) {
        p.slowT = 0.55;
        if (fx) fx.push({ t: 'decoyGrab', p: k, x: d.x, y: d.y, z: d.z });
        s.decoys.splice(i, 1);
        break;
      }
    }
  }
}

/* ---------------- TAG BOMB ----------------
   The bomb never sits on the floor: it is always on somebody, and the only
   way to move it is to catch the other player. The fuse does NOT reset on a
   tag - it is one continuous countdown for the whole round, which is what
   turns the last five seconds into a scramble. */
function stepTagBomb(s, fx) {
  if (s.variant !== 'tagbomb') return;
  const br = s.br;
  s.tagCd = Math.max(0, s.tagCd - DT);
  br.fuse = s.timeLeft;                 // the round timer IS the fuse

  const i = br.owner;
  if (i < 0) return;
  const holder = s.players[i];
  const prey = s.players[1 - i];

  // a holder who cannot act cannot tag
  if (s.tagCd > 0 || holder.stunT > 0 || holder.freezeT > 0 || holder.slipT > 0) return;

  const dx = prey.x - holder.x, dz = prey.z - holder.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > CFG.TAG_R * CFG.TAG_R) return;
  if (Math.abs(prey.y - holder.y) > 2.2) return;

  /* TAG. Hand it over, shove them apart so the next one has to be earned,
     and lock it briefly so a single collision cannot bounce it back. */
  br.owner = 1 - i;
  br.lastOwner = i;
  br.sinceDrop = 0;
  s.tagCd = CFG.TAG_COOLDOWN;
  holder.tags++;
  prey.lockT = Math.max(prey.lockT, CFG.TAG_COOLDOWN);

  const d = Math.sqrt(d2) || 1;
  const nx = dx / d, nz = dz / d;
  prey.vx += nx * CFG.TAG_PUSH; prey.vz += nz * CFG.TAG_PUSH;
  holder.vx -= nx * CFG.TAG_PUSH * 0.6; holder.vz -= nz * CFG.TAG_PUSH * 0.6;
  prey.anim = 4; prey.animT = 0.3;

  if (fx) fx.push({ t: 'tag', p: i, to: 1 - i, x: prey.x, y: prey.y, z: prey.z });
}

function stepScoring(s, fx) {
  const br = s.br;
  // track the biggest hole each player has climbed out of (Comeback Kid)
  if (s.tick % 15 === 0) {
    const d = s.players[0].score - s.players[1].score;
    if (d < 0) s.players[0].maxDeficit = Math.max(s.players[0].maxDeficit, -d);
    if (d > 0) s.players[1].maxDeficit = Math.max(s.players[1].maxDeficit, d);
  }
  if (br.owner < 0) return;
  const p = s.players[br.owner];
  const mult = br.golden > 0 ? 2 : 1;
  p.holdTime += DT;
  p.curHold += DT;
  p.longestHold = Math.max(p.longestHold, p.curHold);
  if (br.golden > 0) p.goldenTime += DT;
  // TAG BOMB has no score at all - the round is won by not holding the bomb.
  if (s.variant === 'tagbomb') return;
  p.acc += CFG.SCORE_RATE * mult * DT;
  while (p.acc >= 1) {
    p.acc -= 1;
    p.score += 1;
    if (fx) fx.push({ t: 'tickScore', p: br.owner, mult });
  }
}

/* ---------------- chaos events ---------------- */
function stepEvents(s, fx) {
  if (s.ev.id) {
    s.ev.t -= DT;
    if (s.ev.t <= 0) {
      const ended = s.ev.id;
      s.ev = { id: '', t: 0, dur: 0, target: -1 };
      if (ended === 'FRENZY') for (const d of s.decoys) d.life = Math.min(d.life, 0.35);
      if (fx) fx.push({ t: 'eventEnd', id: ended });
    }
  }

  s.evTimer -= DT;
  if (s.evTimer > 0 || s.timeLeft < 4 || s.ev.id) return;

  R(s);
  // never repeat the same event twice in a row
  let id = EVENT_IDS[rng.int(0, EVENT_IDS.length - 1)];
  if (id === s.lastEvent) id = EVENT_IDS[(EVENT_IDS.indexOf(id) + 1 + rng.int(0, 4)) % EVENT_IDS.length];
  s.lastEvent = id;
  const def = EVENTS[id];
  s.ev = { id, t: def.dur, dur: def.dur, target: -1 };
  s.evTimer = rng.range(CFG.EVENT_MIN, CFG.EVENT_MAX);
  s.eventsSeen++;

  switch (id) {
    case 'FRENZY': {
      s.decoys.length = 0;
      for (let i = 0; i < CFG.DECOY_COUNT; i++) {
        const spot = randomSpot(rng, 5, 17);
        s.decoys.push({
          x: spot.x, y: 6 + rng.next() * 3, z: spot.z,
          vx: rng.range(-3, 3), vy: 0, vz: rng.range(-3, 3),
          spin: rng.angle(), life: CFG.FRENZY_TIME, kind: rng.int(0, 5),
        });
      }
      break;
    }
    case 'SPEED':
      for (const p of s.players) p.speedT = CFG.SPEED_TIME;
      break;
    case 'TELEPORT': {
      for (const p of s.players) {
        const spot = randomSpot(rng, 7, 17);
        p.x = spot.x; p.z = spot.z; p.y = staticHeight(spot.x, spot.z) + 3;
        p.vx = p.vz = 0; p.vy = 0; p.onGround = false;
      }
      break;
    }
    case 'FREEZE': {
      // random, but nudged toward whoever is winning so it never feels
      // like the game is punishing the player who is already behind
      const lead = s.players[0].score - s.players[1].score;
      const bias = clamp(0.5 + lead * 0.006, 0.28, 0.72);
      const target = rng.next() < bias ? 0 : 1;
      s.players[target].freezeT = CFG.FREEZE_TIME;
      s.players[target].vx = s.players[target].vz = 0;
      s.ev.target = target;
      break;
    }
    case 'MEGA': {
      for (const p of s.players) {
        const l = Math.hypot(p.x, p.z) || 1;
        p.vx = (p.x / l) * CFG.MEGA_KNOCK;
        p.vz = (p.z / l) * CFG.MEGA_KNOCK;
        p.vy = 13;
        p.onGround = false;
        p.stunT = 0.5;
        p.anim = 1; p.animT = 0.5;
      }
      if (s.br.owner >= 0) {
        const o = s.br.owner;
        const l = Math.hypot(s.players[o].x, s.players[o].z) || 1;
        dropBrainrot(s, -s.players[o].x / l, -s.players[o].z / l, fx, true);
      }
      break;
    }
    case 'GOLDEN':
      s.br.golden = CFG.GOLDEN_TIME;
      break;
  }
  saveR(s);
  if (fx) fx.push({ t: 'event', id, target: s.ev.target });
}

function stepHazards(s, fx) {
  for (let i = s.hazards.length - 1; i >= 0; i--) {
    const h = s.hazards[i];
    if (h.warm > 0) h.warm -= DT;
    h.life -= DT;
    if (h.life <= 0) s.hazards.splice(i, 1);
  }
  s.hazTimer -= DT;
  if (s.hazTimer > 0 || s.timeLeft < 6) return;
  R(s);
  s.hazTimer = CFG.HAZARD_EVERY * rng.range(0.75, 1.3);
  const n = rng.chance(0.35) ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const spot = randomSpot(rng, 4, 16);
    s.hazards.push({
      x: spot.x, z: spot.z, y: staticHeight(spot.x, spot.z),
      r: CFG.HAZARD_R * rng.range(0.8, 1.2),
      life: CFG.HAZARD_LIFE, warm: 0.9,
    });
  }
  saveR(s);
  if (fx) fx.push({ t: 'hazardSpawn' });
}

/* ---------------- end of round ---------------- */
function endRound(s, fx) {
  s.phase = 'over';
  s.phaseT = CFG.OVER_HOLD;
  s.timeLeft = 0;

  if (s.variant === 'tagbomb') {
    /* Whoever is holding it when the fuse runs out loses, full stop. There is
       no score in this mode, so this has to run before any bonus below. */
    const loser = s.br.owner;
    s.winner = loser < 0 ? -1 : 1 - loser;
    s.longestBonus = -1;
    if (loser >= 0) {
      const p = s.players[loser];
      p.bonked++;
      p.stunT = Math.max(p.stunT, CFG.BLAST_STUN);
      if (fx) fx.push({ t: 'blast', p: loser, x: p.x, y: p.y, z: p.z });
    }
    if (fx) fx.push({ t: 'end', winner: s.winner, bonusTo: -1 });
    return;
  }

  for (const p of s.players) p.longestHold = Math.max(p.longestHold, p.curHold);

  const a = s.players[0], b = s.players[1];
  let bonusTo = -1;
  if (a.longestHold > b.longestHold + 0.001) bonusTo = 0;
  else if (b.longestHold > a.longestHold + 0.001) bonusTo = 1;
  if (bonusTo >= 0) s.players[bonusTo].score += CFG.LONGEST_HOLD_BONUS;
  s.longestBonus = bonusTo;

  s.winner = a.score > b.score ? 0 : b.score > a.score ? 1 : -1;
  if (s.br.owner >= 0) { /* keep it, it looks better on the podium */ }
  if (fx) fx.push({ t: 'end', winner: s.winner, bonusTo });
}

/* ------------------------------------------------------------
   wire format - a flat number array, small enough to send at 20Hz
   ------------------------------------------------------------ */
const PF = [
  'x','y','z','vx','vy','vz','face','dashT','dashCd','dashX','dashZ',
  'stunT','freezeT','speedT','slowT','tauntT','lockT','score','acc',
  'holdTime','curHold','longestHold','goldenTime','steals','dashHits',
  'pickups','bonked','lastSecondSteal','maxDeficit','anim','animT',
  'cd0','cd1','cd2','ch0','ch1','ch2','kickT','ultT','slipT','abilityHits','tags',
];
const BF = ['x','y','z','vx','vy','vz','owner','lastOwner','sinceDrop','lock','golden','spin','fuse'];

export function encodeState(s) {
  const out = [s.tick, s.t, PHASES.indexOf(s.phase), s.phaseT, s.timeLeft, s.rs,
    s.evTimer, s.hazTimer, s.eventsSeen, s.winner, s.longestBonus == null ? -1 : s.longestBonus,
    round4(s.orbTimer), VARIANTS.indexOf(s.variant), round4(s.tagCd)];
  for (let i = 0; i < 2; i++) {
    const p = s.players[i];
    for (const k of PF) out.push(round4(p[k]));
    out.push(p.onGround ? 1 : 0, p.mover);
  }
  for (const k of BF) out.push(round4(s.br[k]));
  out.push(s.br.settled ? 1 : 0);
  out.push(EVENT_IDS.indexOf(s.ev.id), round4(s.ev.t), round4(s.ev.dur), s.ev.target);
  out.push(s.decoys.length);
  for (const d of s.decoys) out.push(round4(d.x), round4(d.y), round4(d.z), round4(d.vx), round4(d.vy), round4(d.vz), round4(d.spin), round4(d.life), d.kind);
  out.push(s.hazards.length);
  for (const h of s.hazards) out.push(round4(h.x), round4(h.y), round4(h.z), round4(h.r), round4(h.life), round4(h.warm));
  out.push(s.bananas.length);
  for (const b of s.bananas) {
    out.push(round4(b.x), round4(b.y), round4(b.z), round4(b.vx), round4(b.vy), round4(b.vz),
      round4(b.life), b.owner, b.armed ? 1 : 0);
  }
  out.push(s.orbs.length);
  for (const o of s.orbs) {
    out.push(round4(o.x), round4(o.y), round4(o.z), o.kind, round4(o.life));
  }
  return out;
}

export function decodeState(a, into) {
  const s = into || createSim(1);
  let k = 0;
  s.tick = a[k++]; s.t = a[k++]; s.phase = PHASES[a[k++]]; s.phaseT = a[k++];
  s.timeLeft = a[k++]; s.rs = a[k++]; s.evTimer = a[k++]; s.hazTimer = a[k++];
  s.eventsSeen = a[k++]; s.winner = a[k++]; s.longestBonus = a[k++];
  s.orbTimer = a[k++];
  s.variant = VARIANTS[a[k++]] || 'classic';
  s.tagCd = a[k++];
  for (let i = 0; i < 2; i++) {
    const p = s.players[i];
    for (const f of PF) p[f] = a[k++];
    p.onGround = !!a[k++]; p.mover = a[k++];
  }
  for (const f of BF) s.br[f] = a[k++];
  s.br.settled = !!a[k++];
  const ei = a[k++];
  s.ev.id = ei >= 0 ? EVENT_IDS[ei] : '';
  s.ev.t = a[k++]; s.ev.dur = a[k++]; s.ev.target = a[k++];
  const dn = a[k++];
  s.decoys.length = 0;
  for (let i = 0; i < dn; i++) {
    s.decoys.push({ x: a[k++], y: a[k++], z: a[k++], vx: a[k++], vy: a[k++], vz: a[k++], spin: a[k++], life: a[k++], kind: a[k++] });
  }
  const hn = a[k++];
  s.hazards.length = 0;
  for (let i = 0; i < hn; i++) {
    s.hazards.push({ x: a[k++], y: a[k++], z: a[k++], r: a[k++], life: a[k++], warm: a[k++] });
  }
  const bn = a[k++];
  s.bananas.length = 0;
  for (let i = 0; i < bn; i++) {
    s.bananas.push({ x: a[k++], y: a[k++], z: a[k++], vx: a[k++], vy: a[k++], vz: a[k++],
      life: a[k++], owner: a[k++], armed: !!a[k++] });
  }
  const on = a[k++] | 0;
  s.orbs.length = 0;
  for (let i = 0; i < on; i++) {
    s.orbs.push({ x: a[k++], y: a[k++], z: a[k++], kind: a[k++] | 0, life: a[k++] });
  }
  return s;
}

const PHASES = ['countdown', 'play', 'over'];
const round4 = (v) => Math.round((v || 0) * 1000) / 1000;

/** cheap structural clone used by client rollback */
export function copySim(src, dst) {
  const d = dst || createSim(src.seed);
  return decodeState(encodeState(src), d);
}

/** per-player stats in the shape data/progression.js expects */
export function statsFor(s, idx) {
  const p = s.players[idx];
  const o = s.players[1 - idx];
  const won = s.winner === idx;
  return {
    matches: 1,
    wins: won ? 1 : 0,
    losses: s.winner === 1 - idx ? 1 : 0,
    draws: s.winner === -1 ? 1 : 0,
    score: p.score,
    holdTime: p.holdTime,
    longestHold: p.longestHold,
    steals: p.steals,
    dashHits: p.dashHits + p.abilityHits,
    abilityHits: p.abilityHits,
    pickups: p.pickups,
    bonked: p.bonked,
    lastSecondSteal: p.lastSecondSteal,
    goldenTime: p.goldenTime,
    decoyTouches: 0,
    eventsSeen: s.eventsSeen,
    perfectWin: won && p.bonked === 0 ? 1 : 0,
    comebackWin: won && (p.maxDeficit || 0) >= 60 ? 1 : 0,
    oppScore: o.score,
  };
}
