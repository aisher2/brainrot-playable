/* ============================================================
   bot.js - the PRACTICE-mode opponent.

   IMPORTANT: this is deliberately kept out of the online path.
   Online matches only ever pair two real players; the bot exists so
   the game is playable and testable with no server, and so the
   netcode has something to talk to offline.
   ============================================================ */

import { A, PILLARS } from '../game/arena.js';
import { RNG, clamp } from '../core/util.js';

const PILLAR_CACHE = PILLARS;

const DIFFS = {
  chill:  { react: 0.34, aim: 0.55, dashRange: 2.6, dashChance: 0.55, wander: 0.9,  speed: 0.86 },
  normal: { react: 0.20, aim: 0.78, dashRange: 3.4, dashChance: 0.8,  wander: 0.55, speed: 0.96 },
  sweaty: { react: 0.10, aim: 0.94, dashRange: 4.2, dashChance: 0.95, wander: 0.28, speed: 1.0  },
};

export class BotAI {
  constructor(idx, difficulty = 'normal', seed = 12345) {
    this.idx = idx;
    this.d = DIFFS[difficulty] || DIFFS.normal;
    this.rng = new RNG(seed >>> 0 || 7);
    this.tx = 0; this.tz = 0;          // smoothed steering target
    this.ax = 0; this.az = 0;          // smoothed axis output
    this.think = 0;
    this.wanderA = this.rng.angle();
    this.wanderT = 0;
    this.dashWant = false;
    this.tauntWant = false;
    this.want = [false, false, false];   // kick / banana / ultimate
    this.decoyPick = -1;
    this.name = 'PRACTICE BOT';
  }

  /** @returns {{x,z,dash,taunt}} */
  step(s, dt) {
    const me = s.players[this.idx];
    const foe = s.players[1 - this.idx];
    const br = s.br;

    if (s.phase !== 'play') return { x: 0, z: 0, dash: false, taunt: false };

    this.think -= dt;
    this.wanderT -= dt;
    if (this.wanderT <= 0) {
      this.wanderT = this.rng.range(0.5, 1.4);
      this.wanderA = this.rng.angle();
    }

    if (this.think <= 0) {
      this.think = this.d.react * this.rng.range(0.7, 1.3);
      this._decide(s, me, foe, br);
    }

    // steer toward the chosen point, sliding around pillars
    let dx = this.tx - me.x, dz = this.tz - me.z;
    const dist = Math.hypot(dx, dz) || 1;
    dx /= dist; dz /= dist;

    const avoid = this._avoid(me, s);
    dx += avoid.x; dz += avoid.z;

    // a little wobble so it never looks like a homing missile
    const w = (1 - this.d.aim) * this.d.wander;
    dx += Math.cos(this.wanderA) * w;
    dz += Math.sin(this.wanderA) * w;

    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;

    const k = 1 - Math.exp(-14 * dt);
    this.ax += (dx * this.d.speed - this.ax) * k;
    this.az += (dz * this.d.speed - this.az) * k;

    const out = {
      x: this.ax, z: this.az, dash: this.dashWant, taunt: this.tauntWant,
      a0: this.want[0], a1: this.want[1], a2: this.want[2],
    };
    this.dashWant = false;
    this.tauntWant = false;
    this.want[0] = this.want[1] = this.want[2] = false;
    return out;
  }

  _decide(s, me, foe, br) {
    const toFoe = Math.hypot(foe.x - me.x, foe.z - me.z);
    this._abilities(s, me, foe, br, toFoe);

    if (br.owner === this.idx) {
      /* --- running away with the prize --- */
      const ax = me.x - foe.x, az = me.z - foe.z;
      const l = Math.hypot(ax, az) || 1;
      let tx = me.x + (ax / l) * 12, tz = me.z + (az / l) * 12;
      // stay inside the walls, and prefer circling over cornering yourself
      const r = Math.hypot(tx, tz);
      if (r > A.HALF - 4) {
        const tang = Math.atan2(me.z, me.x) + (this.rng.chance(0.5) ? 1 : -1) * 0.9;
        tx = Math.cos(tang) * 13; tz = Math.sin(tang) * 13;
      }
      this.tx = tx; this.tz = tz;
      if (toFoe < 3.2 && me.dashCd <= 0 && this.rng.chance(this.d.dashChance)) this.dashWant = true;
      if (toFoe > 12 && this.rng.chance(0.06)) this.tauntWant = true;
      return;
    }

    if (br.owner === 1 - this.idx) {
      /* --- hunt the holder --- */
      // aim slightly ahead of them
      const lead = clamp(toFoe * 0.14, 0, 1.2) * this.d.aim;
      this.tx = foe.x + foe.vx * lead;
      this.tz = foe.z + foe.vz * lead;
      if (toFoe < this.d.dashRange && me.dashCd <= 0 && Math.abs(foe.y - me.y) < 1.8
          && this.rng.chance(this.d.dashChance)) this.dashWant = true;
      return;
    }

    /* --- detour for an ability orb ----
       Only when it is genuinely on the way, and only if there is a free slot
       to put it in - otherwise the bot would abandon the brainrot to hoard. */
    const orb = this._bestOrb(s, me, br);
    if (orb) { this.tx = orb.x; this.tz = orb.z; return; }

    /* --- loose brainrot --- */
    let target = br;
    if (s.decoys.length) {
      // during FRENZY the bot is only mostly sure which one is real
      const fooled = this.rng.next() > (0.35 + this.d.aim * 0.5);
      if (fooled) {
        if (this.decoyPick < 0 || this.decoyPick >= s.decoys.length) this.decoyPick = this.rng.int(0, s.decoys.length - 1);
        target = s.decoys[this.decoyPick];
      } else this.decoyPick = -1;
    }
    this.tx = target.x; this.tz = target.z;

    // contest the pickup: dash in if the opponent will get there first
    const myD = Math.hypot(target.x - me.x, target.z - me.z);
    const foeD = Math.hypot(target.x - foe.x, target.z - foe.z);
    if (myD < 5 && foeD < myD + 1.5 && me.dashCd <= 0 && this.rng.chance(this.d.dashChance * 0.7)) {
      this.dashWant = true;
    }
  }

  /**
   * The bot plays by the same rules as a human: it can only use an ability it
   * has actually collected an orb for. It is deliberately a beat slower to
   * react than a good player.
   */
  _abilities(s, me, foe, br, toFoe) {
    const holdingFoe = br.owner === 1 - this.idx;
    const holdingMe = br.owner === this.idx;

    // YEET KICK: point blank, and best used on whoever has the brainrot
    if (me.ch0 > 0 && me.cd0 <= 0 && toFoe < 3.0 && Math.abs(foe.y - me.y) < 1.8) {
      const want = holdingFoe ? 0.9 : 0.45;
      if (this.rng.chance(want * this.d.dashChance)) this.want[0] = true;
    }

    // BANANA: drop one behind you while running away, or ahead while chasing
    if (me.ch1 > 0 && me.cd1 <= 0 && this.rng.chance(0.5 * this.d.dashChance)) {
      if (holdingMe && toFoe < 12) this.want[1] = true;
      else if (holdingFoe && toFoe > 3 && toFoe < 11) this.want[1] = true;
    }

    // ULTIMATE: only worth it when someone else has the prize, or it is loose
    if (me.ch2 > 0 && me.cd2 <= 0 && !holdingMe) {
      const dBr = Math.hypot(br.x - me.x, br.z - me.z);
      if ((holdingFoe && toFoe < 18) || (br.owner < 0 && dBr > 6 && dBr < 20)) {
        if (this.rng.chance(0.6)) this.want[2] = true;
      }
    }
  }

  /**
   * The nearest orb worth detouring for: close to us, not much further than
   * the brainrot, and for a slot we are not already holding the cap in.
   */
  _bestOrb(s, me, br) {
    if (!s.orbs || !s.orbs.length) return null;
    const dBr = Math.hypot(br.x - me.x, br.z - me.z);
    let best = null, bestD = Infinity;
    for (const o of s.orbs) {
      if (me['ch' + o.kind] >= 2) continue;
      const d = Math.hypot(o.x - me.x, o.z - me.z);
      if (d > 9) continue;                       // never cross the map for one
      if (br.owner < 0 && d > dBr + 3) continue; // do not lose a loose brainrot
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** steer away from pillars and live hazard zones */
  _avoid(me, s) {
    let ax = 0, az = 0;
    for (const p of PILLAR_CACHE) {
      const dx = me.x - p.x, dz = me.z - p.z;
      const d = Math.hypot(dx, dz);
      const rad = (p.r || A.PILLAR_R) + 2.2;
      if (d < rad && d > 0.01) {
        const w = (rad - d) / rad;
        ax += (dx / d) * w * 1.5;
        az += (dz / d) * w * 1.5;
      }
    }
    for (const b of s.bananas) {
      if (!b.armed || b.owner === this.idx) continue;
      const dx = me.x - b.x, dz = me.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d < 2.4 && d > 0.01) { ax += (dx / d) * 2.2; az += (dz / d) * 2.2; }
    }
    for (const h of s.hazards) {
      if (h.warm > 0) continue;
      const dx = me.x - h.x, dz = me.z - h.z;
      const d = Math.hypot(dx, dz);
      if (d < h.r + 1.4 && d > 0.01) {
        ax += (dx / d) * 1.8;
        az += (dz / d) * 1.8;
      }
    }
    const wall = A.HALF - 2.5;
    if (me.x > wall) ax -= (me.x - wall) * 0.6;
    if (me.x < -wall) ax -= (me.x + wall) * 0.6;
    if (me.z > wall) az -= (me.z - wall) * 0.6;
    if (me.z < -wall) az -= (me.z + wall) * 0.6;
    return { x: ax, z: az };
  }
}

/** Fun, non-repeating display names so practice matches feel populated. */
const ADJ = ['Sigma', 'Bombastic', 'Feral', 'Crispy', 'Sneaky', 'Turbo', 'Cursed', 'Wobbly', 'Gremlin', 'Deranged'];
const NOUN = ['Steve', 'Toaster', 'Goblin', 'Muffin', 'Wizard', 'Pigeon', 'Noodle', 'Bandit', 'Yapper', 'Menace'];
export function botName(seed = Date.now()) {
  const r = new RNG(seed >>> 0 || 3);
  return (r.pick(ADJ) + r.pick(NOUN)).toUpperCase().slice(0, 12);
}

export { DIFFS };
