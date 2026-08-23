/* ============================================================
   particles.js - one pooled CPU particle system, rebuilt into a
   single dynamic vertex buffer each frame (1 draw call total).

   Two shapes:
     - billboards, which always face the camera
     - ground quads, flat on the floor (shockwave rings, scorch)
   ============================================================ */

import { clamp01 } from '../core/util.js';

const GRAV = -26;

export class Particles {
  constructor(max = 900) {
    this.max = max;
    this.n = 0;
    // struct-of-arrays keeps the update loop allocation free
    this.x = new Float32Array(max); this.y = new Float32Array(max); this.z = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max); this.grow = new Float32Array(max);
    this.r = new Float32Array(max); this.g = new Float32Array(max); this.b = new Float32Array(max);
    this.r2 = new Float32Array(max); this.g2 = new Float32Array(max); this.b2 = new Float32Array(max);
    this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.spin = new Float32Array(max); this.rot = new Float32Array(max);
    this.flat = new Uint8Array(max);   // 1 = lie flat on the ground
    this.glow = new Float32Array(max);
    this.fade = new Uint8Array(max);   // 0 = linear alpha, 1 = pop-in then out
    this.budget = 1;                   // scaled down on weak devices
  }

  setBudget(b) { this.budget = clamp01(b); }

  clear() { this.n = 0; }

  _slot() {
    if (this.n < this.max) return this.n++;
    // recycle the oldest-looking particle rather than dropping the effect
    let worst = 0, wl = Infinity;
    for (let i = 0; i < this.max; i += 7) if (this.life[i] < wl) { wl = this.life[i]; worst = i; }
    return worst;
  }

  emit(o) {
    const i = this._slot();
    this.x[i] = o.x; this.y[i] = o.y; this.z[i] = o.z;
    this.vx[i] = o.vx || 0; this.vy[i] = o.vy || 0; this.vz[i] = o.vz || 0;
    this.life[i] = this.maxLife[i] = o.life || 0.6;
    this.size[i] = o.size || 0.2;
    this.grow[i] = o.grow || 0;
    const c = o.color || [1, 1, 1];
    this.r[i] = c[0]; this.g[i] = c[1]; this.b[i] = c[2];
    const c2 = o.color2 || c;
    this.r2[i] = c2[0]; this.g2[i] = c2[1]; this.b2[i] = c2[2];
    this.drag[i] = o.drag == null ? 2.4 : o.drag;
    this.grav[i] = o.grav == null ? 1 : o.grav;
    this.spin[i] = o.spin || 0;
    this.rot[i] = o.rot || 0;
    this.flat[i] = o.flat ? 1 : 0;
    this.glow[i] = o.glow || 0;
    this.fade[i] = o.fade || 0;
    return i;
  }

  update(dt) {
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      let l = this.life[i] - dt;
      if (l <= 0) {
        // compact: move the last live particle into this slot
        const j = this.n - 1;
        if (i !== j) this._copy(j, i);
        this.n--; i--;
        continue;
      }
      this.life[i] = l;
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d;
      this.vy[i] = this.vy[i] * d + GRAV * this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
      this.size[i] = Math.max(0.001, this.size[i] + this.grow[i] * dt);
      this.rot[i] += this.spin[i] * dt;
      if (this.y[i] < 0.02 && this.grav[i] > 0) {   // cheap floor bounce
        this.y[i] = 0.02;
        this.vy[i] = Math.abs(this.vy[i]) * 0.28;
        this.vx[i] *= 0.7; this.vz[i] *= 0.7;
      }
      alive++;
    }
    return alive;
  }

  _copy(from, to) {
    const F = ['x','y','z','vx','vy','vz','life','maxLife','size','grow','r','g','b','r2','g2','b2','drag','grav','spin','rot','flat','glow','fade'];
    for (const k of F) this[k][to] = this[k][from];
  }

  /**
   * Rebuild the vertex buffer.
   * @param dyn DynamicMesh
   * @param camRight/camUp screen-aligned basis vectors from the camera
   */
  build(dyn, camRight, camUp) {
    dyn.reset();
    const rx = camRight[0], ry = camRight[1], rz = camRight[2];
    const ux = camUp[0], uy = camUp[1], uz = camUp[2];
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.maxLife[i];             // 1 -> 0
      let a = this.fade[i] ? Math.sin(Math.PI * (1 - t)) : t;
      a = clamp01(a);
      if (a < 0.02) continue;
      const s = this.size[i];
      const k = 1 - t;
      const cr = this.r[i] + (this.r2[i] - this.r[i]) * k;
      const cg = this.g[i] + (this.g2[i] - this.g[i]) * k;
      const cb = this.b[i] + (this.b2[i] - this.b[i]) * k;
      const col = [cr, cg, cb];
      const x = this.x[i], y = this.y[i], z = this.z[i];
      const c = Math.cos(this.rot[i]), sn = Math.sin(this.rot[i]);

      let ax, ay, az, bx, by, bz;
      if (this.flat[i]) {
        ax = c * s; ay = 0; az = -sn * s;
        bx = sn * s; by = 0; bz = c * s;
      } else {
        ax = (rx * c + ux * sn) * s; ay = (ry * c + uy * sn) * s; az = (rz * c + uz * sn) * s;
        bx = (-rx * sn + ux * c) * s; by = (-ry * sn + uy * c) * s; bz = (-rz * sn + uz * c) * s;
      }
      dyn.quad(
        [x - ax - bx, y - ay - by, z - az - bz],
        [x + ax - bx, y + ay - by, z + az - bz],
        [x + ax + bx, y + ay + by, z + az + bz],
        [x - ax + bx, y - ay + by, z - az + bz],
        col, a, this.glow[i],
      );
    }
    dyn.commit();
    return dyn;
  }

  /* --------------------------------------------------------
     presets
     -------------------------------------------------------- */
  burst(x, y, z, color, count = 14, power = 7, opts = {}) {
    count = Math.max(2, Math.round(count * this.budget));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * 0.9 + 0.15;
      const sp = power * (0.5 + Math.random() * 0.7);
      this.emit({
        x, y, z,
        vx: Math.cos(a) * sp * (1 - e * 0.4),
        vy: sp * e * 1.15,
        vz: Math.sin(a) * sp * (1 - e * 0.4),
        life: (opts.life || 0.55) * (0.7 + Math.random() * 0.7),
        size: (opts.size || 0.19) * (0.6 + Math.random() * 0.9),
        grow: opts.grow || -0.12,
        color, color2: opts.color2 || color,
        spin: (Math.random() - 0.5) * 12,
        rot: Math.random() * 6.28,
        drag: opts.drag == null ? 2.2 : opts.drag,
        grav: opts.grav == null ? 1 : opts.grav,
        glow: opts.glow || 0,
      });
    }
  }

  puff(x, y, z, color, count = 5) {
    count = Math.max(1, Math.round(count * this.budget));
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.emit({
        x: x + Math.cos(a) * 0.2, y: y + Math.random() * 0.15, z: z + Math.sin(a) * 0.2,
        vx: Math.cos(a) * 1.6, vy: 0.9 + Math.random(), vz: Math.sin(a) * 1.6,
        life: 0.4 + Math.random() * 0.3, size: 0.16 + Math.random() * 0.14, grow: 0.5,
        color, drag: 3.6, grav: 0.08, spin: (Math.random() - 0.5) * 4, rot: Math.random() * 6.28,
        fade: 1,
      });
    }
  }

  /** a scatter of sparks kicked outward along the floor */
  groundSpray(x, y, z, color, count = 10, speed = 9) {
    count = Math.max(2, Math.round(count * this.budget));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      this.emit({
        x, y: y + 0.12, z,
        vx: Math.cos(a) * speed, vy: 1.2 + Math.random() * 1.4, vz: Math.sin(a) * speed,
        life: 0.32 + Math.random() * 0.18, size: 0.12 + Math.random() * 0.08, grow: -0.16,
        color, drag: 3.2, grav: 0.5, glow: 0.5, fade: 1, rot: a,
      });
    }
  }

  confetti(x, y, z, count = 30) {
    count = Math.max(4, Math.round(count * this.budget));
    const cols = [[1, 0.24, 0.55], [0.15, 0.83, 1], [1, 0.82, 0.25], [0.3, 1, 0.61], [0.75, 0.48, 1]];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 4 + Math.random() * 9;
      this.emit({
        x, y: y + Math.random(), z,
        vx: Math.cos(a) * sp, vy: 8 + Math.random() * 8, vz: Math.sin(a) * sp,
        life: 1.6 + Math.random() * 1.4, size: 0.13 + Math.random() * 0.1,
        color: cols[i % cols.length], drag: 1.1, grav: 0.55,
        spin: (Math.random() - 0.5) * 22, rot: Math.random() * 6.28,
      });
    }
  }

  /** dust/spark left behind a running player */
  trail(x, y, z, style, color, vx = 0, vz = 0) {
    if (Math.random() > this.budget) return;
    switch (style) {
      case 'fire':
        this.emit({ x, y: y + 0.15, z, vx: -vx * 0.15, vy: 1.6, vz: -vz * 0.15, life: 0.34, size: 0.24, grow: -0.35,
          color, color2: [0.35, 0.05, 0.02], drag: 2.4, grav: -0.12, glow: 0.6, fade: 1 });
        break;
      case 'spark':
        this.emit({ x: x + (Math.random() - 0.5) * 0.5, y: y + 0.4 + Math.random() * 0.5, z: z + (Math.random() - 0.5) * 0.5,
          vy: 0.8, life: 0.42, size: 0.1, grow: -0.1, color, drag: 1.6, grav: 0.05, glow: 0.8, spin: 6, fade: 1 });
        break;
      case 'bubble':
        this.emit({ x: x + (Math.random() - 0.5) * 0.4, y: y + 0.2, z: z + (Math.random() - 0.5) * 0.4,
          vy: 1.9, life: 0.7, size: 0.11 + Math.random() * 0.09, grow: 0.06, color, drag: 1.2, grav: -0.2, fade: 1 });
        break;
      case 'goo':
        this.emit({ x, y: y + 0.08, z, vy: 0.3, life: 0.75, size: 0.2, grow: -0.16,
          color, drag: 5, grav: 0.25, glow: 0.3, fade: 1 });
        break;
      case 'ribbon':
        this.emit({ x, y: y + 0.5, z, vy: 0.2, life: 0.55, size: 0.26, grow: -0.28,
          color, color2: [1, 1, 1], drag: 4, grav: -0.05, glow: 0.5, fade: 1 });
        break;
      case 'rift':
        this.emit({ x, y: y + 0.4, z, vy: 0.1, life: 0.6, size: 0.3, grow: -0.42,
          color, color2: [0.05, 0, 0.12], drag: 4, grav: 0, glow: 0.55, spin: 3, fade: 1 });
        break;
      default: // puff
        this.emit({ x, y: y + 0.05, z, vx: -vx * 0.1, vy: 0.5, vz: -vz * 0.1, life: 0.36, size: 0.17, grow: 0.42,
          color, drag: 4, grav: 0.02, fade: 1 });
    }
  }

  /** speed lines that streak past the camera during SPEED events */
  speedStreak(x, y, z, dirX, dirZ, color) {
    this.emit({
      x, y, z, vx: -dirX * 16, vy: 0, vz: -dirZ * 16,
      life: 0.2, size: 0.5, grow: -1.4, color, drag: 0.4, grav: 0, glow: 0.7,
      rot: Math.atan2(dirZ, dirX), fade: 1,
    });
  }
}
