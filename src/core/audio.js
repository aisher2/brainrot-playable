/* ============================================================
   audio.js - 100% synthesized. No audio files are downloaded,
   which keeps the Playables bundle tiny and start-up instant.

   - SFX: short oscillator/noise patches with pitch envelopes.
   - Music: a scheduled chiptune loop that gains layers and tempo
     in the final 10 seconds of a round.
   ============================================================ */

import { clamp01, RNG } from './util.js';

let ctx = null;
let master = null, musicBus = null, sfxBus = null;
let noiseBuf = null;
let unlocked = false;

const state = {
  music: true,
  sfx: true,
  intensity: 0,   // 0 = calm, 1 = final countdown
  playing: false,
  mode: null,     // 'menu' | 'match'
};

/** set while the menu theme is wanted but the audio context is still locked */
let wantMenu = false;
/** bumped on every start/stop so a fade-out cannot clobber a newer loop */
let musicGen = 0;

/* ------------------------------------------------------------
   setup
   ------------------------------------------------------------ */
export function initAudio() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ latencyHint: 'interactive' });

  master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
  musicBus = ctx.createGain(); musicBus.gain.value = 0.34; musicBus.connect(master);
  sfxBus = ctx.createGain(); sfxBus.gain.value = 0.85; sfxBus.connect(master);

  // 1 second of white noise, reused by every noisy patch
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  const resume = () => {
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => { if (wantMenu) startMenuMusic(); }, () => {});
    }
    if (!unlocked) {
      unlocked = true;
      if (wantMenu) startMenuMusic();
    }
  };
  addEventListener('pointerdown', resume, { passive: true });
  addEventListener('keydown', resume, { passive: true });
  addEventListener('touchstart', resume, { passive: true });
  return ctx;
}

/** the menu sits a little lower than the match so the jokes do not shout */
const baseGain = () => (state.mode === 'menu' ? 0.3 : 0.34);

export function setMusicEnabled(on) {
  state.music = on;
  if (musicBus) musicBus.gain.setTargetAtTime(on ? baseGain() : 0, ctx.currentTime, 0.08);
  if (on && wantMenu && state.mode !== 'menu') startMenuMusic();
}
export function setSfxEnabled(on) {
  state.sfx = on;
  if (sfxBus) sfxBus.gain.setTargetAtTime(on ? 0.85 : 0, ctx.currentTime, 0.05);
}
/* setMuted() used to live here. It read `state.music` to decide what to
   restore, but setMusicEnabled writes that same field, so muting erased
   the value unmuting needed and audio never came back. Nothing called it;
   applyHostAudio in main.js re-derives both buses from the saved settings
   instead, which cannot latch. */
export function audioReady() { return !!ctx && ctx.state === 'running'; }

/** the live AudioContext, for tooling that needs to tap the output */
export const audioContext = () => ctx;
/** insert a node between the whole mix and the speakers (used by tools) */
export function tapOutput(node) {
  if (!ctx || !master) return false;
  try { master.disconnect(); master.connect(node); node.connect(ctx.destination); return true; }
  catch (_) { return false; }
}

const t0 = () => ctx.currentTime;

/** the only values the Web Audio spec accepts for OscillatorNode.type */
const OSC_TYPES = new Set(['sine', 'square', 'sawtooth', 'triangle']);

/* ------------------------------------------------------------
   primitives
   ------------------------------------------------------------ */
function env(node, when, a, d, peak = 1) {
  const g = node.gain;
  g.setValueAtTime(0.0001, when);
  g.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + a);
  g.exponentialRampToValueAtTime(0.0001, when + a + d);
}

function tone({ wave = 'square', f0 = 440, f1 = f0, dur = 0.2, vol = 0.3, when = 0, bend = 'exp', detune = 0, dest = null }) {
  if (!ctx || !state.sfx) return;
  const t = (when || t0());
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  // OscillatorType is a strict enum: anything else throws a console warning
  // and silently falls back to a sine, quietly wrecking the patch.
  o.type = OSC_TYPES.has(wave) ? wave : 'square';
  o.detune.value = detune;
  o.frequency.setValueAtTime(Math.max(20, f0), t);
  if (f1 !== f0) {
    if (bend === 'lin') o.frequency.linearRampToValueAtTime(Math.max(20, f1), t + dur);
    else o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  }
  env(g, t, Math.min(0.02, dur * 0.2), dur, vol);
  o.connect(g); g.connect(dest || sfxBus);
  o.start(t); o.stop(t + dur + 0.06);
  return { o, g };
}

function noise({ dur = 0.2, vol = 0.3, when = 0, type = 'lowpass', f0 = 2000, f1 = 200, q = 1, dest = null }) {
  if (!ctx || !state.sfx) return;
  const t = when || t0();
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = type; bp.Q.value = q;
  bp.frequency.setValueAtTime(f0, t);
  bp.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
  const g = ctx.createGain();
  env(g, t, 0.008, dur, vol);
  s.connect(bp); bp.connect(g); g.connect(dest || sfxBus);
  s.start(t); s.stop(t + dur + 0.05);
}

function warble(o, amount, rate, when, dur) {
  if (!amount) return;
  const lfo = ctx.createOscillator();
  const lg = ctx.createGain();
  lfo.frequency.value = rate;
  lg.gain.value = amount;
  lfo.connect(lg); lg.connect(o.frequency);
  lfo.start(when); lfo.stop(when + dur + 0.05);
}

/* ------------------------------------------------------------
   the sound board
   ------------------------------------------------------------ */
export const sfx = {
  ui() { tone({ wave: 'square', f0: 660, f1: 880, dur: 0.06, vol: 0.16 }); },
  back() { tone({ wave: 'square', f0: 520, f1: 320, dur: 0.08, vol: 0.14 }); },
  hover() { tone({ wave: 'triangle', f0: 900, f1: 1100, dur: 0.04, vol: 0.07 }); },
  error() { tone({ wave: 'sawtooth', f0: 200, f1: 90, dur: 0.22, vol: 0.22 }); },

  /** exaggerated pop */
  pickup() {
    if (!ctx) return;
    const t = t0();
    tone({ wave: 'sine', f0: 300, f1: 1400, dur: 0.12, vol: 0.4, when: t });
    tone({ wave: 'square', f0: 900, f1: 1800, dur: 0.09, vol: 0.16, when: t + 0.02 });
    noise({ dur: 0.06, vol: 0.18, when: t, f0: 4000, f1: 900, type: 'bandpass', q: 2 });
  },

  /** loud comedic steal */
  steal() {
    if (!ctx) return;
    const t = t0();
    tone({ wave: 'sawtooth', f0: 180, f1: 1200, dur: 0.18, vol: 0.34, when: t });
    tone({ wave: 'square', f0: 1400, f1: 300, dur: 0.26, vol: 0.26, when: t + 0.08 });
    const s = tone({ wave: 'square', f0: 400, f1: 400, dur: 0.4, vol: 0.2, when: t + 0.1 });
    if (s) warble(s.o, 180, 11, t + 0.1, 0.4);
    noise({ dur: 0.3, vol: 0.2, when: t, f0: 5000, f1: 400, type: 'bandpass', q: 1.2 });
  },

  /** cartoon impact */
  hit(power = 1) {
    if (!ctx) return;
    const t = t0();
    tone({ wave: 'triangle', f0: 320 * power, f1: 46, dur: 0.18, vol: 0.42 * power, when: t });
    noise({ dur: 0.14, vol: 0.35 * power, when: t, f0: 2600, f1: 120, q: 0.7 });
    tone({ wave: 'square', f0: 1500, f1: 220, dur: 0.09, vol: 0.16, when: t });
  },

  bonk() {
    if (!ctx) return;
    const t = t0();
    tone({ wave: 'sine', f0: 900, f1: 120, dur: 0.24, vol: 0.4, when: t });
    tone({ wave: 'sine', f0: 1350, f1: 180, dur: 0.2, vol: 0.2, when: t + 0.01 });
    noise({ dur: 0.09, vol: 0.3, when: t, f0: 3200, f1: 300 });
  },

  dash() {
    if (!ctx) return;
    noise({ dur: 0.2, vol: 0.22, when: t0(), f0: 700, f1: 4200, type: 'bandpass', q: 1.4 });
    tone({ wave: 'sine', f0: 200, f1: 700, dur: 0.14, vol: 0.16 });
  },

  bounce() { tone({ wave: 'sine', f0: 160, f1: 900, dur: 0.16, vol: 0.3, bend: 'exp' }); },
  boost() { tone({ wave: 'sawtooth', f0: 300, f1: 1500, dur: 0.22, vol: 0.18 }); },
  freeze() {
    if (!ctx) return;
    const t = t0();
    for (let i = 0; i < 5; i++) tone({ wave: 'sine', f0: 2400 - i * 260, f1: 900, dur: 0.3, vol: 0.1, when: t + i * 0.035 });
    noise({ dur: 0.5, vol: 0.12, when: t, f0: 6000, f1: 3000, type: 'highpass' });
  },
  teleport() {
    if (!ctx) return;
    const t = t0();
    const s = tone({ wave: 'sine', f0: 220, f1: 2400, dur: 0.3, vol: 0.24, when: t });
    if (s) warble(s.o, 400, 30, t, 0.3);
  },
  golden() {
    if (!ctx) return;
    const t = t0();
    [0, 4, 7, 12].forEach((st, i) =>
      tone({ wave: 'triangle', f0: 523.25 * Math.pow(2, st / 12), dur: 0.5, vol: 0.16, when: t + i * 0.055 }));
  },
  frenzy() {
    if (!ctx) return;
    const t = t0();
    for (let i = 0; i < 7; i++) tone({ wave: 'square', f0: 300 + i * 190, f1: 200 + i * 120, dur: 0.12, vol: 0.1, when: t + i * 0.04 });
  },
  megaKnock() {
    if (!ctx) return;
    const t = t0();
    tone({ wave: 'sine', f0: 160, f1: 30, dur: 0.6, vol: 0.5, when: t });
    noise({ dur: 0.5, vol: 0.4, when: t, f0: 3000, f1: 60, q: 0.6 });
  },

  countdown(n) {
    if (!ctx) return;
    const f = n === 0 ? 1320 : 660;
    tone({ wave: 'square', f0: f, f1: f, dur: n === 0 ? 0.34 : 0.12, vol: 0.3 });
    if (n === 0) tone({ wave: 'square', f0: f * 1.5, dur: 0.4, vol: 0.2, when: t0() + 0.05 });
  },

  tick() { tone({ wave: 'square', f0: 1500, dur: 0.04, vol: 0.12 }); },

  score() { tone({ wave: 'triangle', f0: 1200, f1: 1800, dur: 0.05, vol: 0.06 }); },

  victory() {
    if (!ctx) return;
    const t = t0();
    const mel = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5];
    mel.forEach((f, i) => {
      tone({ wave: 'square', f0: f, dur: 0.26, vol: 0.24, when: t + i * 0.11 });
      tone({ wave: 'triangle', f0: f / 2, dur: 0.3, vol: 0.14, when: t + i * 0.11 });
    });
    noise({ dur: 0.9, vol: 0.1, when: t, f0: 8000, f1: 2000, type: 'highpass' });
  },

  defeat() {
    if (!ctx) return;
    const t = t0();
    const mel = [392, 349.23, 311.13, 261.63];
    mel.forEach((f, i) => {
      const s = tone({ wave: 'sawtooth', f0: f, f1: f * 0.94, dur: 0.34, vol: 0.2, when: t + i * 0.16 });
      if (s) warble(s.o, 6, 5, t + i * 0.16, 0.34);
    });
    tone({ wave: 'sine', f0: 200, f1: 60, dur: 0.7, vol: 0.2, when: t + 0.6 });
  },

  levelup() {
    if (!ctx) return;
    const t = t0();
    [0, 5, 9, 12, 16].forEach((st, i) =>
      tone({ wave: 'square', f0: 440 * Math.pow(2, st / 12), dur: 0.22, vol: 0.2, when: t + i * 0.07 }));
  },

  unlock() {
    if (!ctx) return;
    const t = t0();
    [0, 7, 12].forEach((st, i) =>
      tone({ wave: 'triangle', f0: 660 * Math.pow(2, st / 12), dur: 0.3, vol: 0.22, when: t + i * 0.09 }));
    noise({ dur: 0.4, vol: 0.09, when: t, f0: 9000, f1: 3000, type: 'highpass' });
  },

  coin() {
    if (!ctx) return;
    const t = t0();
    tone({ wave: 'square', f0: 988, dur: 0.06, vol: 0.16, when: t });
    tone({ wave: 'square', f0: 1319, dur: 0.16, vol: 0.16, when: t + 0.06 });
  },

  matched() {
    if (!ctx) return;
    const t = t0();
    tone({ wave: 'square', f0: 523, dur: 0.1, vol: 0.24, when: t });
    tone({ wave: 'square', f0: 784, dur: 0.1, vol: 0.24, when: t + 0.1 });
    tone({ wave: 'square', f0: 1046, dur: 0.24, vol: 0.26, when: t + 0.2 });
  },
};

/**
 * Each brainrot has its own voice, built from its `sfx` patch.
 * @param {object} patch see data/brainrots.js
 */
export function playBrainrotSfx(patch, vol = 1) {
  if (!ctx || !patch || !state.sfx) return;
  const t = t0();
  const { wave = 'square', f0 = 300, f1 = 600, dur = 0.25, warble: w = 0, noise: n = 0 } = patch;

  if (patch.chord) {
    patch.chord.forEach((m, i) =>
      tone({ wave, f0: f0 * m, f1: f1 * m * 0.5 + f0 * m * 0.5, dur, vol: 0.2 * vol, when: t + i * 0.05 }));
  } else if (patch.beeps) {
    for (let i = 0; i < patch.beeps; i++)
      tone({ wave, f0, dur: 0.09, vol: 0.24 * vol, when: t + i * 0.13 });
  } else {
    const s = tone({ wave, f0, f1, dur, vol: 0.3 * vol, when: t });
    if (s && w) warble(s.o, w, 9 + w * 0.4, t, dur);
  }
  if (patch.sub) tone({ wave: 'sine', f0: f0 * 0.5, f1: f1 * 0.5, dur: dur * 1.2, vol: 0.26 * vol, when: t });
  if (n) noise({ dur: dur * 0.8, vol: 0.26 * n * vol, when: t, f0: 3500, f1: 400, type: patch.gurgle ? 'bandpass' : 'lowpass', q: patch.gurgle ? 3 : 1 });
  if (patch.gurgle) {
    const s2 = tone({ wave: 'sine', f0: f1, f1: f0, dur: dur * 0.9, vol: 0.14 * vol, when: t + 0.04 });
    if (s2) warble(s2.o, 90, 17, t + 0.04, dur);
  }
}

/* ------------------------------------------------------------
   MUSIC - scheduled 16-step loop, layers by intensity
   ------------------------------------------------------------ */
const SCALE = [0, 3, 5, 7, 10];          // minor pentatonic, always "fine"
const ROOT = 55;                          // A1
let step = 0, nextNoteTime = 0, timer = 0, bar = 0;
let musicRng = new RNG(7);
let melodyPattern = [];

function regenMelody() {
  melodyPattern = [];
  for (let i = 0; i < 16; i++) {
    melodyPattern.push(musicRng.chance(0.62) ? musicRng.pick(SCALE) + (musicRng.chance(0.35) ? 12 : 0) : null);
  }
}

function scheduleStep(t) {
  const i = state.intensity;
  const beat = step % 4;

  // --- kick
  if (step % 4 === 0 || (i > 0.5 && step % 8 === 6)) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.2);
  }
  // --- snare / clap
  if (step % 8 === 4) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.34, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    s.connect(f); f.connect(g); g.connect(musicBus); s.start(t); s.stop(t + 0.16);
  }
  // --- hats (denser when intense)
  if (i > 0.15 || step % 2 === 0) {
    const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
    const g = ctx.createGain();
    const v = 0.09 + i * 0.07;
    g.gain.setValueAtTime(beat === 0 ? v * 1.4 : v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    s.connect(f); f.connect(g); g.connect(musicBus); s.start(t); s.stop(t + 0.06);
  }
  // --- bass
  if (step % 2 === 0) {
    const deg = SCALE[(Math.floor(step / 4) + bar) % SCALE.length];
    const f0 = ROOT * Math.pow(2, deg / 12);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = i > 0.5 ? 'sawtooth' : 'square';
    o.frequency.setValueAtTime(f0, t);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(400 + i * 1400, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(lp); lp.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.26);
  }
  // --- lead arp (only once things heat up)
  const note = melodyPattern[step];
  if (note !== null && note !== undefined && i > 0.06) {
    const f0 = ROOT * 4 * Math.pow(2, note / 12);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(f0, t);
    const v = 0.06 + i * 0.10;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.18);
  }
  // --- siren stab in the last stretch
  if (i > 0.85 && step === 0) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(300, t + 0.5);
    g.gain.setValueAtTime(0.09, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.6);
  }
}

/* ------------------------------------------------------------
   MENU / LOADING THEME

   A deliberately stupid oompah. The bass never quite settles in
   tune, every melody note swoops onto its pitch instead of
   arriving politely, and a rotating cast of gags (slide whistle,
   rubber duck, sad trombone, a small burp) keeps the loop from
   ever becoming polite background music.
   ------------------------------------------------------------ */
const MENU_ROOT = 65.41;                       // C2
const MENU_MEL = [0, 3, 5, 7, 10, 12, 15];     // same pentatonic family as the match
let gagIdx = 0;

/** a note that slides onto pitch rather than arriving on it */
function slideNote(t, from, to, dur, vol, wave) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = wave || 'square';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(25, to), t + dur * 0.55);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2600;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(lp); lp.connect(g); g.connect(musicBus);
  o.start(t); o.stop(t + dur + 0.05);
}

/** one of four one-shot jokes, fired every fourth bar */
function menuGag(t, which) {
  if (which === 0) {                              // slide whistle, upward
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(700, t);
    o.frequency.exponentialRampToValueAtTime(2300, t + 0.42);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g); g.connect(musicBus); o.start(t); o.stop(t + 0.55);
    return;
  }
  if (which === 1) {                              // rubber duck squeak
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(300, t + 0.18);
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 26; lg.gain.value = 60;
    lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + 0.26); lfo.start(t); lfo.stop(t + 0.26);
    return;
  }
  if (which === 2) {                              // sad trombone, three falls
    for (let k = 0; k < 3; k++) {
      slideNote(t + k * 0.19, 196 - k * 18, 150 - k * 18, 0.2, 0.17, 'sawtooth');
    }
    return;
  }
  const src = ctx.createBufferSource();           // a small burp
  src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.Q.value = 6;
  f.frequency.setValueAtTime(900, t);
  f.frequency.exponentialRampToValueAtTime(180, t + 0.28);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.2, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  src.connect(f); f.connect(g); g.connect(musicBus);
  src.start(t); src.stop(t + 0.32);
}

function menuStep(t) {
  const beat = step % 4;

  // oompah bass: root on the beat, fifth on the "and", drifting out of tune
  if (step % 2 === 0) {
    const onBeat = beat === 0 || beat === 2;
    const deg = [0, 0, 5, 7][Math.floor(step / 4) % 4];
    const f = MENU_ROOT * Math.pow(2, (deg + (onBeat ? 0 : 7)) / 12);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = onBeat ? 'triangle' : 'square';
    o.frequency.setValueAtTime(f, t);
    o.detune.value = ((bar % 3) - 1) * 7;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(onBeat ? 0.34 : 0.2, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (onBeat ? 0.22 : 0.14));
    o.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + 0.3);
  }

  // a soft thump under the downbeat, so the loop has a floor
  if (step === 0 || step === 8) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.13);
    g.gain.setValueAtTime(0.34, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g); g.connect(musicBus);
    o.start(t); o.stop(t + 0.22);
  }

  // brushed hat on the off-beats
  if (step % 4 === 2 || step % 8 === 7) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.075, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(f); f.connect(g); g.connect(musicBus);
    src.start(t); src.stop(t + 0.07);
  }

  // the tune, forever sliding onto the note from the wrong side
  const note = melodyPattern[step];
  if (note !== null && note !== undefined) {
    const f = MENU_ROOT * 4 * Math.pow(2, note / 12);
    const from = musicRng.chance(0.4) ? f * 0.72 : f * 1.22;
    slideNote(t, from, f, 0.24, 0.14, 'square');
  }

  // blorp
  if (step === 6 || (bar % 2 === 1 && step === 14)) {
    slideNote(t, 380, 130, 0.18, 0.12, 'sine');
  }

  // and every fourth bar, a joke
  if (step === 12 && bar % 4 === 3) menuGag(t + 0.1, gagIdx++ % 4);
}

function regenMenuMelody() {
  melodyPattern = [];
  for (let i = 0; i < 16; i++) {
    // sparse and lopsided, so the gags have room to land
    const play = (i % 4 === 0 && musicRng.chance(0.85)) || musicRng.chance(0.22);
    melodyPattern.push(play ? musicRng.pick(MENU_MEL) : null);
  }
}

function scheduler() {
  if (!ctx || !state.playing) return;
  const menu = state.mode === 'menu';
  const bpm = menu ? 104 : 118 + state.intensity * 46;
  const stepDur = 60 / bpm / 4;
  while (nextNoteTime < ctx.currentTime + 0.16) {
    const at = Math.max(nextNoteTime, ctx.currentTime + 0.01);
    if (menu) {
      // a little swing so the oompah limps rather than marches
      menuStep(at + (step % 2 === 1 ? stepDur * 0.16 : 0));
    } else {
      scheduleStep(at);
    }
    nextNoteTime += stepDur;
    step = (step + 1) % 16;
    if (step === 0) {
      bar++;
      if (menu) { if (bar % 2 === 0) regenMenuMelody(); }
      else if (bar % 4 === 0) regenMelody();
    }
  }
}

function beginLoop(mode, seed, gain) {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  musicGen++;
  state.mode = mode;
  musicRng = new RNG(seed || 7);
  if (mode === 'menu') regenMenuMelody(); else regenMelody();
  step = 0; bar = 0;
  nextNoteTime = ctx.currentTime + 0.08;
  state.playing = true;
  clearInterval(timer);
  timer = setInterval(scheduler, 25);
  musicBus.gain.cancelScheduledValues(ctx.currentTime);
  musicBus.gain.setTargetAtTime(state.music ? gain : 0, ctx.currentTime, 0.25);
}

/**
 * Loading screen + main menu. Browsers refuse to make noise before the first
 * gesture, so when the context is still locked this arms itself and starts
 * the instant the player touches anything.
 */
export function startMenuMusic() {
  if (!ctx) return;
  wantMenu = true;
  if (ctx.state === 'suspended') { ctx.resume(); return; }  // resume() calls back
  if (state.playing && state.mode === 'menu') return;       // already running
  beginLoop('menu', 4242, 0.3);
}

export function startMusic(seed = 7) {
  wantMenu = false;
  beginLoop('match', seed, 0.34);
}

export function stopMusic(fade = 0.4) {
  wantMenu = false;
  if (!ctx) return;
  const gen = ++musicGen;
  musicBus.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
  setTimeout(() => {
    // Something may have started a new loop during the fade (leaving a match
    // goes straight back to the menu theme). Only tear down if nothing did.
    if (gen !== musicGen) return;
    state.playing = false;
    state.mode = null;
    clearInterval(timer);
    timer = 0;
  }, fade * 1000);
}

/** 0 = menu chill, 1 = final ten seconds */
export function setIntensity(v) { state.intensity = clamp01(v); }

export function duckMusic(amount = 0.4, time = 0.35) {
  if (!ctx || !state.music) return;
  const g = musicBus.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setTargetAtTime(baseGain() * (1 - amount), ctx.currentTime, 0.02);
  g.setTargetAtTime(baseGain(), ctx.currentTime + time, 0.15);
}

export const audioState = state;
