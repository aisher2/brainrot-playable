/* ============================================================
   input.js - one unified input state from keyboard, mouse,
   gamepad and touch. The sim only ever sees {x, z, dash, taunt}.

   Buttons are *latched*: a press sets a flag that survives until
   the next fixed tick reads it, so a 4ms tap is never dropped.
   ============================================================ */

import { clamp } from './util.js';

const KEY_MAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Space: 'dash', ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyQ: 'a0',            // yeet kick
  KeyE: 'a1',            // banana slip
  KeyR: 'a2',            // ultimate
  KeyF: 'taunt', KeyT: 'taunt',
};

/** every button is latched, so a 4ms tap is never lost between ticks */
const LATCHED = ['dash', 'taunt', 'a0', 'a1', 'a2'];

export class Input {
  constructor(els = {}) {
    this.els = els;
    this.keys = Object.create(null);
    this.latch = Object.create(null);      // dash | taunt | a0 | a1 | a2
    this.stick = { active: false, id: -1, cx: 0, cy: 0, x: 0, y: 0, r: 56 };
    this.touchMode = false;
    this.enabled = false;
    this.lastAxis = { x: 0, z: 0 };
    // swipe-to-look: any drag that does not start on a control
    this.look = { id: -1, lastX: 0, dx: 0 };
    this._bind();
  }

  /* ------------- binding ------------- */
  _bind() {
    const kd = (e) => {
      const a = KEY_MAP[e.code];
      if (!a) return;
      if (e.repeat) { e.preventDefault(); return; }
      this.keys[a] = true;
      if (LATCHED.includes(a)) this.latch[a] = true;
      if (this.enabled) e.preventDefault();
    };
    const ku = (e) => {
      const a = KEY_MAP[e.code];
      if (!a) return;
      this.keys[a] = false;
      if (this.enabled) e.preventDefault();
    };
    addEventListener('keydown', kd, { passive: false });
    addEventListener('keyup', ku, { passive: false });
    addEventListener('blur', () => {
      this.keys = Object.create(null);
      this.latch = Object.create(null);
      this.stick.active = false; this.stick.id = -1; this._nub(0, 0);
    });

    // mouse: click anywhere in the play area = ability / taunt
    addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.touchMode) return;
      if (e.pointerType !== 'mouse') return;
      if (e.target && e.target.closest && e.target.closest('button,input,.sheet,.panel')) return;
      this.latch.taunt = true;
    });

    // first touch anywhere flips us into touch mode
    addEventListener('touchstart', () => this.setTouchMode(true), { passive: true, once: true });
    if (matchMedia('(pointer:coarse)').matches) this.setTouchMode(true);

    this._bindLook();
    this._bindStick();
    this._bindButton(this.els.dashBtn, 'dash');
    this._bindButton(this.els.a0Btn, 'a0');
    this._bindButton(this.els.a1Btn, 'a1');
    this._bindButton(this.els.a2Btn, 'a2');
    this._bindButton(this.els.abilityBtn, 'taunt');
  }

  /**
   * Ability buttons must never steal the movement finger. Each button owns
   * only its own pointer id and does not capture, so holding the stick with
   * one thumb and tapping abilities with the other works as you would expect.
   */
  _bindButton(el, action) {
    if (!el) return;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      if (this.stick.active && e.pointerId === this.stick.id) return;   // not the stick finger
      e.preventDefault();
      e.stopPropagation();
      this.latch[action] = true;
      el.classList.add('pressed');
    });
    const up = (e) => { e.stopPropagation(); el.classList.remove('pressed'); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  /**
   * Drag anywhere that is not a control to swing the camera. It deliberately
   * ignores the pointer already driving the stick, so looking around never
   * interrupts running.
   */
  _bindLook() {
    const isControl = (t) => !!(t && t.closest && t.closest('.stick,.abtn,.tbtn,.stealbtn,button,input'));
    addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.look.id !== -1) return;
      if (this.stick.active && e.pointerId === this.stick.id) return;
      if (isControl(e.target)) return;
      this.look.id = e.pointerId;
      this.look.lastX = e.clientX;
    }, { passive: true });
    addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.look.id) return;
      this.look.dx += e.clientX - this.look.lastX;
      this.look.lastX = e.clientX;
    }, { passive: true });
    const end = (e) => { if (e.pointerId === this.look.id) this.look.id = -1; };
    addEventListener('pointerup', end, { passive: true });
    addEventListener('pointercancel', end, { passive: true });
  }

  /** pixels dragged horizontally since the last call */
  readLook() {
    const d = this.look.dx;
    this.look.dx = 0;
    return d;
  }

  _bindStick() {
    const el = this.els.stickEl;
    if (!el) return;
    const s = this.stick;

    const start = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      s.active = true; s.id = e.pointerId;
      s.cx = r.left + r.width / 2; s.cy = r.top + r.height / 2;
      s.r = r.width * 0.42;
      el.setPointerCapture?.(e.pointerId);
      move(e);
    };
    const move = (e) => {
      if (!s.active || e.pointerId !== s.id) return;
      e.preventDefault();
      let dx = e.clientX - s.cx, dy = e.clientY - s.cy;
      const len = Math.hypot(dx, dy);
      if (len > s.r) { dx = (dx / len) * s.r; dy = (dy / len) * s.r; }
      s.x = dx / s.r; s.y = dy / s.r;
      this._nub(dx, dy);
    };
    const end = (e) => {
      if (e.pointerId !== s.id && s.id !== -1) return;
      s.active = false; s.id = -1; s.x = 0; s.y = 0;
      this._nub(0, 0);
    };

    el.addEventListener('pointerdown', start);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  _nub(dx, dy) {
    const n = this.els.nubEl;
    if (n) n.style.transform = `translate(${dx}px,${dy}px)`;
  }

  /* ------------- state ------------- */
  setTouchMode(on) {
    if (this.touchMode === on) return;
    this.touchMode = on;
    if (this.els.touchLayer) this.els.touchLayer.hidden = !on;
  }

  /** Enable during a match, disable in menus so keys don't get eaten. */
  setEnabled(on) {
    this.enabled = on;
    if (this.els.touchLayer) this.els.touchLayer.hidden = !(on && this.touchMode);
    if (!on) { this.keys = Object.create(null); this.latch = Object.create(null); }
  }

  _gamepadAxis() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const g of pads) {
      if (!g || !g.connected) continue;
      const dz = 0.22;
      let x = Math.abs(g.axes[0]) > dz ? g.axes[0] : 0;
      let y = Math.abs(g.axes[1]) > dz ? g.axes[1] : 0;
      if (g.buttons[12]?.pressed) y = -1;
      if (g.buttons[13]?.pressed) y = 1;
      if (g.buttons[14]?.pressed) x = -1;
      if (g.buttons[15]?.pressed) x = 1;
      if (g.buttons[0]?.pressed || g.buttons[7]?.pressed) this.latch.dash = true;
      if (g.buttons[2]?.pressed) this.latch.a0 = true;
      if (g.buttons[3]?.pressed) this.latch.a1 = true;
      if (g.buttons[5]?.pressed || g.buttons[1]?.pressed) this.latch.a2 = true;
      if (x || y) return { x, y };
    }
    return null;
  }

  /**
   * Read and clear. Call exactly once per fixed simulation tick.
   * @returns {{x,z,dash,taunt,a0,a1,a2}}
   */
  read() {
    let x = 0, z = 0;
    if (this.keys.left) x -= 1;
    if (this.keys.right) x += 1;
    if (this.keys.up) z -= 1;
    if (this.keys.down) z += 1;

    if (this.stick.active && (this.stick.x || this.stick.y)) {
      x = this.stick.x; z = this.stick.y;
    } else if (!x && !z) {
      const gp = this._gamepadAxis();
      if (gp) { x = gp.x; z = gp.y; }
    }

    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    x = clamp(x, -1, 1); z = clamp(z, -1, 1);
    this.lastAxis = { x, z };

    const out = {
      x, z,
      dash: !!this.latch.dash, taunt: !!this.latch.taunt,
      a0: !!this.latch.a0, a1: !!this.latch.a1, a2: !!this.latch.a2,
    };
    this.latch = Object.create(null);
    return out;
  }

  /** live axis for UI (no latch consumption) */
  peek() { return this.lastAxis; }
}
