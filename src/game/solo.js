/* ============================================================
   solo.js - a match against the local AI, with no network at all.

   This replaces what practice mode used to do. Previously even a
   bot match was played over the netcode: an in-page loopback
   transport, inputs packed into wire messages, snapshots, and
   rollback on the receiving end. That worked, but it meant the
   networking stack was reachable from every single match, and none
   of it can survive in a Playables build.

   Both players live in one simulation here, so none of that
   machinery is needed: there is no wire to pack for, no latency to
   predict around, and nothing to reconcile. Each fixed tick reads
   the player's input and the AI's, steps the sim once, and that is
   the whole loop.

   It keeps the same surface the rest of the game already talks to -
   start / update / drainFx / dispose, and the 'ended' event with
   the same payload - so nothing downstream had to change.
   ============================================================ */

import { Emitter } from '../core/util.js';
import { DT, CFG, createSim, stepSim, statsFor } from './sim.js';
import { matchBrainrot } from '../data/brainrots.js';
import { BotAI, botName } from './bot.js';

/** Never advance more than this many ticks in one frame after a stall. */
const MAX_CATCHUP = 6;
const EMPTY = [];
const IDLE_INPUT = { x: 0, z: 0, dash: false, taunt: false, a0: false, a1: false, a2: false };

/* The opponent's identity used to be minted inside the matchmaker, next to
   the code that would otherwise have fetched a real player. It is the same
   derivation, moved here: a name, a level and a cosmetic set, all seeded so a
   given match always draws the same character. */
const SKINS = ['blob', 'mint', 'tangerine', 'blueberry', 'tall', 'chonk', 'brick'];
const HATS = ['none', 'cap', 'cone', 'bucket', 'horns'];
const FACES = ['happy', 'derp', 'sigma', 'shock', 'angy'];
const TRAILS = ['dust', 'bubbles', 'fire', 'sparkle'];

export function makeOpponent(seed) {
  const s = seed >>> 0;
  return {
    id: 'bot',
    name: botName(s),
    level: 1 + (s % 20),
    loadout: {
      skin: SKINS[s % SKINS.length],
      hat: HATS[(s >> 3) % HATS.length],
      face: FACES[(s >> 6) % FACES.length],
      trail: TRAILS[(s >> 9) % TRAILS.length],
      emote: 'spin', victory: 'jump', plate: 'plain',
    },
    isBot: true,
  };
}

export class SoloSession extends Emitter {
  constructor(o) {
    super();
    this.idx = o.idx | 0;                 // which player the human drives
    this.seed = o.seed >>> 0;
    this.opp = o.opp;
    this.variant = o.variant || 'classic';
    this.readInput = o.readInput || (() => IDLE_INPUT);

    this.brainrot = matchBrainrot(this.seed);
    this.sim = createSim(this.seed, { brainrotId: this.brainrot.id, variant: this.variant });

    // the AI drives whichever player the human does not
    this.ai = new BotAI(1 - this.idx, o.difficulty || 'normal', this.seed ^ 0x9e37);

    this.fx = [];
    this.acc = 0;
    this.running = false;
    this.finished = false;
    this.rtt = 0;                         // always 0: nothing to measure
  }

  start() {
    this.running = true;
    this.acc = 0;
    this.emit('start');
  }

  /** advance real time; returns how many fixed ticks were consumed */
  update(dt) {
    if (!this.running) return 0;
    this.acc += Math.min(dt, 0.25);
    let n = 0;
    while (this.acc >= DT && n < MAX_CATCHUP) {
      this.acc -= DT;
      this._fixed();
      n++;
    }
    if (n === MAX_CATCHUP) this.acc = 0;  // hopelessly behind: drop the backlog
    return n;
  }

  _fixed() {
    if (this.finished) return;

    const mine = this.readInput() || IDLE_INPUT;
    const theirs = this.ai.step(this.sim, DT) || IDLE_INPUT;
    const inputs = this.idx === 0 ? [mine, theirs] : [theirs, mine];

    stepSim(this.sim, inputs, this.fx);

    if (this.sim.phase === 'over') this._finish();
  }

  drainFx() {
    if (!this.fx.length) return EMPTY;
    const out = this.fx;
    this.fx = [];
    return out;
  }

  /** Kept so the emote button still works; it only has to reach ourselves. */
  sendEmote(id) { this.emit('emote', { who: this.idx, id }); }

  dispose() {
    this.running = false;
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

export { CFG, DT };
