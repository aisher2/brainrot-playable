/* ============================================================
   util.js - math, deterministic RNG, tiny event bus.
   Zero dependencies. Everything the sim uses must be
   deterministic (no Math.random inside game/sim.js).
   ============================================================ */

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const sign = Math.sign;

/** frame-rate independent exponential smoothing */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** shortest signed angle from a to b */
export function angDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
export const angLerp = (a, b, t) => a + angDelta(a, b) * t;
export const angDamp = (a, b, lambda, dt) => a + angDelta(a, b) * (1 - Math.exp(-lambda * dt));

export const dist2 = (ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az;
  return dx * dx + dz * dz;
};
export const dist = (ax, az, bx, bz) => Math.sqrt(dist2(ax, az, bx, bz));

export function normalize2(x, z) {
  const l = Math.hypot(x, z);
  return l > 1e-6 ? [x / l, z / l] : [0, 0];
}

/* ---------- easing ---------- */
export const easeOutBack = (t) => { const c = 1.9; return 1 + c * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutElastic = (t) => t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * 2.1) + 1;
export const bounce01 = (t) => Math.sin(t * Math.PI);

/* ============================================================
   Deterministic RNG - mulberry32.
   The sim seeds one of these from the match seed so host and
   client produce identical chaos.
   ============================================================ */
export class RNG {
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  /** [0,1) */
  next() {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
  angle() { return this.next() * TAU; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  clone() { const r = new RNG(1); r.s = this.s; return r; }
}

/** stable 32-bit string hash - used for seeds and colour picking */
export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* ============================================================
   Tiny event bus
   ============================================================ */
export class Emitter {
  constructor() { this._m = new Map(); }
  on(k, fn) {
    if (!this._m.has(k)) this._m.set(k, new Set());
    this._m.get(k).add(fn);
    return () => this.off(k, fn);
  }
  once(k, fn) {
    const un = this.on(k, (...a) => { un(); fn(...a); });
    return un;
  }
  off(k, fn) { this._m.get(k)?.delete(fn); }
  emit(k, ...a) {
    const s = this._m.get(k);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(...a); } catch (e) { console.error('[emitter]', k, e); }
    }
  }
  clear() { this._m.clear(); }
}

/* ============================================================
   Colour helpers - all colours in the engine are [r,g,b] 0..1
   ============================================================ */
export function hex(h) {
  if (typeof h !== 'string') return h;
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function cssHex(c) {
  const f = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}
export function shade(c, m) { return [clamp01(c[0] * m), clamp01(c[1] * m), clamp01(c[2] * m)]; }
export function mixc(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
export function hsl(h, s, l) {
  h = ((h % 1) + 1) % 1;
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/* ---------- misc ---------- */
export const now = () => performance.now() / 1000;
export function fmtTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
export function pad2(n) { return String(n).padStart(2, '0'); }

/** deep-ish clone of plain sim state (fast path: arrays + objects of numbers) */
export function cloneState(o) {
  if (Array.isArray(o)) return o.map(cloneState);
  if (o && typeof o === 'object') {
    const r = {};
    for (const k in o) r[k] = cloneState(o[k]);
    return r;
  }
  return o;
}
