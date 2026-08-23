/* ============================================================
   view.js - everything you can see.

   Reads the simulation (which knows nothing about rendering) and
   draws it: character animation, the brainrot's idle/pickup
   performances, particles, shadows, screen shake, floating
   nameplates and the light beam that keeps the objective readable
   from anywhere in the arena.
   ============================================================ */

import * as m4 from '../gfx/m4.js';
import { Renderer, Camera, DynamicMesh } from '../gfx/gl.js';
import { Particles } from '../gfx/particles.js';
import {
  getPlayerMesh, getBrainrotMesh, getShadowMesh, getRingMesh, getBeamMesh, getOrbMesh,
} from '../gfx/models.js';
import { buildArenaMesh, A, moverPos, staticHeight } from './arena.js';
import { CFG, EVENTS } from './sim.js';
import { BRAINROT_BY_ID, BRAINROTS as BRAINROTS_LIST } from '../data/brainrots.js';
import { findItem } from '../data/cosmetics.js';
import {
  hex, clamp, clamp01, lerp, damp, angDamp, easeOutBack, easeOutCubic, easeInCubic,
  easeOutElastic, bounce01, TAU,
} from '../core/util.js';

/** one colour per ability, matching the HUD buttons */
const ORB_COL = [hex('#ff5b5b'), hex('#ffe14d'), hex('#c07bff')];
const ORB_GLOW = [[0.30, 0.05, 0.05], [0.28, 0.24, 0.04], [0.20, 0.08, 0.30]];

const TEAM = [hex('#ff3d8b'), hex('#25d3ff')];
const TEAM_CSS = ['#ff3d8b', '#25d3ff'];
const GOLD = hex('#ffd23f');
const WHITE = [1, 1, 1];

/** per-entity visual smoothing so network corrections never pop */
class Track {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.init = false; }
  to(x, y, z, yaw, lambda, dt) {
    if (!this.init) { this.x = x; this.y = y; this.z = z; this.yaw = yaw; this.init = true; return this; }
    if (Math.abs(x - this.x) > 9 || Math.abs(z - this.z) > 9) {   // teleport: do not slide
      this.x = x; this.y = y; this.z = z;
    } else {
      this.x = damp(this.x, x, lambda, dt);
      this.y = damp(this.y, y, lambda * 1.5, dt);
      this.z = damp(this.z, z, lambda, dt);
    }
    this.yaw = angDamp(this.yaw, yaw, 13, dt);
    return this;
  }
}

export class GameView {
  constructor(canvas, hooks = {}) {
    this.renderer = new Renderer(canvas);
    this.cam = new Camera();
    this.particles = new Particles(1000);
    this.pmesh = new DynamicMesh(this.renderer.gl, 1600);
    this.hooks = hooks;                 // {onFx, onToast, onShake}
    this.time = 0;
    this.quality = 1;

    const built = buildArenaMesh(this.renderer.gl);
    this.arena = built.mesh;
    this.moverMesh = built.moverMesh;
    this.hazardMesh = built.hazardMesh;
    this.shadow = getShadowMesh(this.renderer.gl);
    this.ring = getRingMesh(this.renderer.gl);
    this.beam = getBeamMesh(this.renderer.gl);
    // one mesh per ability, so the emblem inside matches the HUD button
    this.orbMesh = [0, 1, 2].map((k) => getOrbMesh(this.renderer.gl, k));

    this.tracks = [new Track(), new Track()];
    this.brTrack = new Track();
    this.playerMesh = [null, null];
    this.loadouts = [null, null];
    this.brainrotDef = null;
    this.brMesh = null;
    this.brMeshGold = null;
    this.decoyMesh = null;

    this.shocks = [];              // expanding ring decals
    this.ultFx = null;             // magnet shockwave
    this.fxClock = [0, 0];         // per-player throttle for ability sparks
    this.slipSlam = [false, false];// has this pratfall hit the floor yet
    this.bananaMesh = null;
    this.pickupAnim = [0, 0];      // brainrot pickup performance timer
    this.brPickT = 0;
    this.lastOwner = -1;
    this.emote = [null, null];     // {id, t}
    this.victory = null;
    this.localIdx = 0;
    this.slowmo = 1;
    this.hitFlash = 0;
    this.camSens = 1;
    this.userYaw = 0;
    this.userYawHold = 0;

    this._m = m4.create();
    this._m2 = m4.create();
    this.plates = [];
    this._makePlates();
  }

  /* ------------------------------------------------------- setup */
  _makePlates() {
    const host = document.getElementById('s-hud');
    if (!host) return;
    for (let i = 0; i < 2; i++) {
      const el = document.createElement('div');
      el.className = 'nameplate';
      el.innerHTML = '<b></b>';
      el.style.cssText = 'position:absolute;transform:translate(-50%,-100%);pointer-events:none;' +
        'font:700 11px/1 var(--font);letter-spacing:.05em;padding:3px 9px;border-radius:99px;' +
        'white-space:nowrap;border:2px solid rgba(0,0,0,.55);opacity:0;transition:opacity .2s;z-index:2';
      host.appendChild(el);
      this.plates.push(el);
    }
  }

  setMatch({ localIdx, loadouts, names, brainrotId }) {
    this.localIdx = localIdx;
    const gl = this.renderer.gl;
    for (let i = 0; i < 2; i++) {
      this.loadouts[i] = loadouts[i];
      this.playerMesh[i] = getPlayerMesh(gl, loadouts[i]);
      this.tracks[i] = new Track();
      const plate = this.plates[i];
      if (plate) {
        const item = findItem('plate', loadouts[i].plate) || { bg: '#00000066', fg: '#fff' };
        plate.style.background = item.bg;
        plate.style.color = item.fg;
        plate.style.boxShadow = item.glow ? `0 0 14px ${item.fg}` : 'none';
        plate.style.borderColor = TEAM_CSS[i];
        plate.querySelector('b').textContent = (names[i] || 'PLAYER ' + (i + 1)).slice(0, 12);
      }
    }
    this.brainrotDef = BRAINROT_BY_ID[brainrotId] || BRAINROT_BY_ID.banana;
    this.brMesh = getBrainrotMesh(gl, this.brainrotDef.id);
    this.brMeshGold = getBrainrotMesh(gl, this.brainrotDef.id, 'golden');
    this.decoyMesh = getBrainrotMesh(gl, this.brainrotDef.id, 'decoy');
    this.brTrack = new Track();
    this.brPickT = 0;
    this.lastOwner = -1;
    this.userYaw = 0;
    this.userYawHold = 0;
    this.victory = null;
    this.slowmo = 1;
    this.shocks.length = 0;
    this.ultFx = null;
    this.particles.clear();
  }

  /**
   * Rebuild the arena for whatever map arena.js currently holds. Call after
   * setArena(), before the next frame. The old buffers are freed so hopping
   * between maps all session does not leak them.
   */
  rebuildArena() {
    // buildArenaMesh caches per map, so these meshes are shared - disposing
    // them here would free buffers another match still points at.
    const built = buildArenaMesh(this.renderer.gl);
    this.arena = built.mesh;
    this.moverMesh = built.moverMesh;
    this.hazardMesh = built.hazardMesh;
  }

  setQuality(q) {
    this.quality = q;
    this.renderer.setQuality(q);
    this.particles.setBudget(q >= 1 ? 1 : q >= 0.6 ? 0.6 : 0.32);
  }

  resize() { return this.renderer.resize(); }

  /** 0 disables swipe-to-look entirely */
  setCamSensitivity(v) { this.camSens = Math.max(0, Number(v) || 0); }

  showPlates(on) {
    for (const p of this.plates) if (p) p.style.opacity = on ? '1' : '0';
  }

  /** expanding ring on the floor - the readable version of a shockwave */
  shock(x, z, color, maxR = 3.2, life = 0.42, width = 0.09) {
    if (this.shocks.length > 14) this.shocks.shift();
    this.shocks.push({ x, y: staticHeight(x, z), z, col: color, maxR, life, t: 0, width });
  }

  _drawShocks(dt) {
    if (!this.shocks.length) return;
    const r = this.renderer;
    r.setBlend(true); r.setDepthWrite(false); r.setCull('none');
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      s.t += dt;
      const k = s.t / s.life;
      if (k >= 1) { this.shocks.splice(i, 1); continue; }
      const rad = 0.4 + easeOutCubic(k) * s.maxR;
      m4.compose(s.x, s.y + 0.07, s.z, 0, 0, 0, rad, s.width * (1 - k * 0.6) * 8, rad, this._m);
      r.draw(this.ring, this._m, { mode: 'unlit', tint: s.col, alpha: (1 - k) * 0.85 });
    }
    r.setCull('back'); r.setBlend(false); r.setDepthWrite(true);
  }

  /* ------------------------------------------------------- fx */
  handleFx(list, sim) {
    for (const f of list) {
      switch (f.t) {
        case 'pickup': {
          this.brPickT = 1;
          const c = TEAM[f.p];
          this.particles.burst(f.x, f.y, f.z, GOLD, 18, 8, { color2: c, glow: 0.5 });
          this.shock(f.x, f.z, c, f.steal ? 4.2 : 2.8, 0.5);
          this.cam.addShake(f.steal ? 0.5 : 0.22);
          break;
        }
        case 'drop':
          this.particles.burst(f.x, f.y, f.z, hex('#ffffff'), 12, 7, { life: 0.4 });
          break;
        case 'hit': {
          this.particles.burst(f.x, f.y, f.z, hex('#ffffff'), 20, 11, { color2: TEAM[f.v], glow: 0.4 });
          this.particles.groundSpray(f.x, staticHeight(f.x, f.z), f.z, hex('#fff2b0'), 10, 10);
          this.shock(f.x, f.z, hex('#fff2b0'), 3.6, 0.36, 0.13);
          this.cam.addShake(0.75);
          this.hitFlash = 1;
          break;
        }
        case 'dash': {
          const c = TEAM[f.p];
          for (let k = 0; k < 5; k++) {
            this.particles.speedStreak(f.x + (Math.random() - 0.5), f.y + 0.4 + Math.random() * 0.9,
              f.z + (Math.random() - 0.5), f.dx, f.dz, c);
          }
          this.shock(f.x, f.z, c, 1.8, 0.28, 0.07);
          break;
        }
        case 'bounce':
          this.particles.burst(f.x, f.y, f.z, hex('#4dff9b'), 12, 6, { grav: 0.4 });
          this.shock(f.x, f.z, hex('#4dff9b'), 2.6, 0.4);
          break;
        case 'tramp': {
          const hard = Math.min(1, Math.max(0, (f.power - 18.5) / 4));
          this.particles.burst(f.x, f.y, f.z, hex('#ffc46b'), 14 + hard * 14, 7 + hard * 6,
            { color2: hex('#fff3ad'), grav: 0.4 });
          this.shock(f.x, f.z, hex('#ff8a1f'), 3.0 + hard * 1.8, 0.42, 0.1);
          this.cam.addShake(0.25 + hard * 0.4);
          break;
        }
        case 'brBounce':
          this.particles.puff(f.x, f.y - 0.4, f.z, hex('#e8d9ff'), 4);
          break;
        case 'decoyPop':
        case 'decoyGrab':
          this.particles.burst(f.x, f.y, f.z, hex('#b0b0c8'), 12, 6, { life: 0.4 });
          break;
        case 'hazard':
          this.particles.puff(f.x, f.y + 0.2, f.z, hex('#ff2d55'), 3);
          break;
        case 'event':
          this.cam.addShake(0.55);
          if (f.id === 'MEGA') this.cam.addShake(1.2);
          break;
        case 'taunt':
          this.emote[f.p] = { id: this.loadouts[f.p]?.emote || 'spin', t: 1.1 };
          break;
        case 'kick': {
          const c = TEAM[f.p];
          const cx = Math.cos(f.face), cz = Math.sin(f.face);
          for (let k = 0; k < 7; k++) {
            this.particles.speedStreak(f.x + cx * (1 + k * 0.3), f.y + 0.5 + Math.random() * 0.6,
              f.z + cz * (1 + k * 0.3), cx, cz, c);
          }
          this.shock(f.x + cx * 1.6, f.z + cz * 1.6, c, 2.4, 0.3, 0.08);
          break;
        }
        case 'kickHit':
          this.particles.burst(f.x, f.y, f.z, hex('#fff2b0'), 24, 13, { color2: TEAM[f.v], glow: 0.5 });
          this.particles.groundSpray(f.x, staticHeight(f.x, f.z), f.z, hex('#ffffff'), 12, 12);
          this.shock(f.x, f.z, hex('#fff2b0'), 4.2, 0.4, 0.15);
          this.cam.addShake(0.95);
          break;
        case 'banana':
          this.particles.puff(f.x, f.y + 0.6, f.z, hex('#ffe14d'), 4);
          break;
        case 'slip':
          this.particles.burst(f.x, f.y + 0.4, f.z, hex('#ffe14d'), 18, 9, { color2: hex('#fff8b0') });
          this.shock(f.x, f.z, hex('#ffe14d'), 3, 0.4, 0.1);
          this.cam.addShake(0.6);
          break;
        case 'orbDrop':
          this.particles.puff(f.x, f.y, f.z, ORB_COL[f.kind], 6);
          this.shock(f.x, f.z, ORB_COL[f.kind], 2.2, 0.3, 0.07);
          break;
        case 'orbGrab':
          this.particles.burst(f.x, f.y, f.z, ORB_COL[f.kind], f.full ? 8 : 20, 8,
            { color2: hex('#ffffff'), glow: 0.7 });
          break;
        case 'orbGone':
          this.particles.puff(f.x, f.y, f.z, ORB_COL[f.kind], 4);
          break;
        case 'bananaGone':
          this.particles.puff(f.x, f.y, f.z, hex('#c8b040'), 3);
          break;
        case 'ult':
          this.ultFx = { x: f.x, z: f.z, t: 0, p: f.p };
          this.shock(f.x, f.z, GOLD, 9, 0.9, 0.2);
          this.cam.addShake(0.8);
          break;
        case 'ultRip':
          this.particles.burst(f.x, f.y, f.z, GOLD, 26, 11, { glow: 0.8 });
          this.cam.addShake(1.0);
          break;
        case 'end':
          this.cam.addShake(0.5);
          break;
        default: break;
      }
    }
  }

  playVictory(idx, animId) {
    this.victory = { idx, id: animId || 'jump', t: 0 };
  }

  /* ------------------------------------------------------- frame */
  render(sim, dt, opts = {}) {
    const r = this.renderer;
    this.time += dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 5);

    r.resize();
    const aspect = r.aspect;

    /* --- camera --- */
    const pts = [];
    for (let i = 0; i < 2; i++) pts.push([sim.players[i].x, sim.players[i].z]);
    if (sim.br.owner < 0) pts.push([sim.br.x, sim.br.z]);
    const me = sim.players[this.localIdx];
    // Tall screens see less arena per unit of distance, so tip the camera
    // further over and widen the lens rather than flying it into orbit.
    // Playables must be playable from 9:32 to 32:9. Very tall screens tip the
    // camera over and widen the lens; very wide ones stay low and cinematic.
    this.cam.pitch = damp(this.cam.pitch, aspect < 0.55 ? 1.15 : aspect < 1.0 ? 1.02 : aspect < 1.4 ? 0.9 : 0.78, 3, dt);
    this.cam.fov = damp(this.cam.fov, aspect < 0.5 ? 1.12 : aspect < 0.72 ? 1.04 : aspect < 1.1 ? 0.95 : 0.86, 3, dt);
    // keep the focus roughly inside the arena so the void never fills the frame
    const CLAMP = A.HALF - 3.5;
    if (opts.freeCam) this.cam.frame(pts, null, dt, aspect, CLAMP);
    else this.cam.frame(pts, [me.x, me.z], dt, aspect, CLAMP);
    // A swiped camera holds where you left it, then drifts back so you are
    // never stuck looking the wrong way in a fight.
    if (this.camSens > 0 && opts.lookDelta) {
      this.userYaw = clamp(this.userYaw + opts.lookDelta * 0.0042 * this.camSens, -1.15, 1.15);
      this.userYawHold = 1.1;
    }
    this.userYawHold = Math.max(0, this.userYawHold - dt);
    if (this.userYawHold <= 0) this.userYaw = damp(this.userYaw, 0, 1.6, dt);
    this.cam.yaw = damp(this.cam.yaw, this.userYaw, 9, dt);
    this.cam.update(dt, aspect);

    r.begin(this.cam);

    /* --- arena --- */
    m4.identity(this._m);
    r.draw(this.arena, this._m);

    for (let i = 0; i < A.MOVERS; i++) {
      const mp = moverPos(i, sim.t);
      m4.compose(mp.x, A.ORB_H, mp.z, 0, sim.t * 0.4, 0, 1, 1, 1, this._m);
      r.draw(this.moverMesh, this._m);
    }

    /* --- hazards --- */
    if (sim.hazards.length) {
      r.setBlend(true); r.setDepthWrite(false);
      for (const h of sim.hazards) {
        const warm = h.warm > 0;
        const pulse = 0.7 + Math.sin(this.time * (warm ? 22 : 7)) * 0.3;
        const fade = clamp01(h.life / 0.8);
        m4.compose(h.x, h.y + 0.02, h.z, 0, this.time * 0.5, 0, h.r, 1, h.r, this._m);
        r.draw(this.hazardMesh, this._m, { mode: 'unlit', alpha: pulse * fade * (warm ? 0.55 : 1), tint: warm ? [1, 0.8, 0.3] : WHITE });
      }
      r.setBlend(false); r.setDepthWrite(true);
    }

    /* --- shadows (cheap, keeps everything grounded) --- */
    r.setBlend(true); r.setDepthWrite(false);
    for (let i = 0; i < 2; i++) {
      const p = sim.players[i];
      this._shadow(p.x, p.z, p.y, sim.t, 1.1);
    }
    if (sim.br.owner < 0) this._shadow(sim.br.x, sim.br.z, sim.br.y, sim.t, 0.7);
    for (const d of sim.decoys) this._shadow(d.x, d.z, d.y, sim.t, 0.6);
    r.setBlend(false); r.setDepthWrite(true);

    /* --- team rings: whatever skins the two players picked, the ring
           under their feet always says which side of the HUD they are on --- */
    r.setBlend(true); r.setDepthWrite(false);
    for (let i = 0; i < 2; i++) {
      const p = sim.players[i];
      const tr = this.tracks[i];
      const gh = staticHeight(tr.x, tr.z);
      const holder = sim.br.owner === i;
      const s = holder ? 1.5 + Math.sin(this.time * 6) * 0.09 : 1.12;
      const spin = holder ? this.time * 1.6 : this.time * 0.4;
      const col = holder && sim.br.golden > 0 ? GOLD : TEAM[i];
      m4.compose(tr.x, Math.max(gh, tr.y) + 0.055, tr.z, 0, spin, 0, s, 1, s, this._m);
      r.draw(this.ring, this._m, { mode: 'unlit', tint: col, alpha: holder ? 0.9 : 0.4 });
      if (i === this.localIdx && !holder) {
        m4.compose(tr.x, Math.max(gh, tr.y) + 0.05, tr.z, 0, -this.time * 0.7, 0, 1.32, 1, 1.32, this._m);
        r.draw(this.ring, this._m, { mode: 'unlit', tint: [1, 1, 1], alpha: 0.22 });
      }
    }
    r.setBlend(false); r.setDepthWrite(true);

    /* --- players --- */
    for (let i = 0; i < 2; i++) this._drawPlayer(sim, i, dt);

    /* --- ability orbs --- */
    if (sim.orbs && sim.orbs.length) this._drawOrbs(sim, dt);

    /* --- bananas --- */
    if (sim.bananas.length) this._drawBananas(sim, dt);

    /* --- magnet pulse --- */
    if (this.ultFx) {
      this.ultFx.t += dt;
      const k = this.ultFx.t / 1.5;
      if (k >= 1) this.ultFx = null;
      else {
        r.setBlend(true); r.setDepthWrite(false); r.setCull('none');
        for (let ring = 0; ring < 3; ring++) {
          const rk = (k * 2 + ring * 0.33) % 1;
          const rad = 12 * (1 - rk) + 1;
          m4.compose(this.ultFx.x, staticHeight(this.ultFx.x, this.ultFx.z) + 0.3 + ring * 0.5,
            this.ultFx.z, 0, this.time * 2, 0, rad, 1, rad, this._m);
          r.draw(this.ring, this._m, { mode: 'unlit', tint: GOLD, alpha: (1 - rk) * 0.5 });
        }
        r.setCull('back'); r.setBlend(false); r.setDepthWrite(true);
      }
    }

    /* --- brainrot + decoys --- */
    this._drawBrainrot(sim, dt);
    for (const d of sim.decoys) this._drawDecoy(sim, d);

    /* --- objective beam --- */
    this._drawBeam(sim);

    /* --- shockwaves + particles --- */
    this._drawShocks(dt);
    this._emitTrails(sim, dt);
    this.particles.update(dt);
    const v = this.cam.view;
    this.particles.build(this.pmesh, [v[0], v[4], v[8]], [v[1], v[5], v[9]]);
    r.setBlend(true); r.setDepthWrite(false); r.setCull('none');
    m4.identity(this._m);
    r.draw(this.pmesh, this._m, { mode: 'unlit' });
    r.setCull('back'); r.setBlend(false); r.setDepthWrite(true);

    /* --- nameplates --- */
    this._updatePlates(sim);

    return r.stats;
  }

  _shadow(x, z, y, t, size) {
    const gh = staticHeight(x, z);
    const h = Math.max(0, y - gh);
    const s = size * clamp(1 - h * 0.07, 0.35, 1);
    const a = clamp(0.42 - h * 0.025, 0.06, 0.42);
    m4.compose(x, gh + 0.035, z, 0, 0, 0, s, 1, s, this._m2);
    this.renderer.draw(this.shadow, this._m2, { mode: 'unlit', tint: [0, 0, 0], alpha: a });
  }

  _drawOrbs(sim, dt) {
    const r = this.renderer;
    for (const o of sim.orbs) {
      const bob = Math.sin(this.time * 3 + o.x * 0.7 + o.z * 0.5) * 0.16;
      // the last couple of seconds blink, so a fade-out never feels arbitrary
      const dying = o.life < 2.2;
      if (dying && Math.sin(this.time * 22) < -0.1) continue;
      const pop = o.life > CFG.ORB_LIFE - 0.35
        ? 0.4 + 0.6 * ((CFG.ORB_LIFE - o.life) / 0.35) : 1;
      this._shadow(o.x, o.z, o.y + bob, this.time, 0.6);
      m4.compose(o.x, o.y + bob, o.z, 0, this.time * 1.6, 0, pop, pop, pop, this._m);
      const mesh = this.orbMesh[o.kind] || this.orbMesh[0];
      r.outline(mesh, this._m, 0.06, ORB_COL[o.kind]);
      r.draw(mesh, this._m, { add: ORB_GLOW[o.kind] });
      // a short shaft of light, so an orb is findable without hunting for it
      const gy = staticHeight(o.x, o.z);
      r.setBlend(true); r.setDepthWrite(false); r.setCull('none');
      const puls = 0.16 + Math.sin(this.time * 4 + o.x) * 0.05;
      m4.compose(o.x, gy, o.z, 0, this.time * 0.7, 0, 0.62, 3.0, 0.62, this._m2);
      r.draw(this.beam, this._m2, { mode: 'unlit', tint: ORB_COL[o.kind], alpha: puls });
      r.setCull('back'); r.setBlend(false); r.setDepthWrite(true);
      if (Math.random() < 0.10) {
        this.particles.trail(o.x + (Math.random() - 0.5) * 0.8, o.y + bob - 0.3,
          o.z + (Math.random() - 0.5) * 0.8, 'spark', ORB_COL[o.kind]);
      }
    }
  }

  /* ---------------- players ---------------- */
  _drawPlayer(sim, i, dt) {
    const r = this.renderer;
    const p = sim.players[i];
    const mesh = this.playerMesh[i];
    if (!mesh) return;

    const dirX = Math.cos(p.face), dirZ = Math.sin(p.face);
    const yaw = Math.atan2(dirX, dirZ);
    const tr = this.tracks[i].to(p.x, p.y, p.z, yaw, 22, dt);

    const sp = Math.hypot(p.vx, p.vz);
    const spN = clamp01(sp / CFG.SPEED);

    let sx = 1, sy = 1, sz = 1, rx = 0, rz = 0, ry = tr.yaw, oy = 0;

    // run cycle: bob + counter-squash
    const run = Math.sin(this.time * (9 + spN * 12)) * spN;
    oy += Math.abs(run) * 0.16;
    sy += run * 0.06;
    sx -= run * 0.03;
    rx += spN * 0.20;                       // lean into the run

    // idle breathing
    const idle = Math.sin(this.time * 2.2) * (1 - spN);
    sy += idle * 0.035; sx -= idle * 0.02;

    // airborne stretch
    if (!p.onGround) {
      const st = clamp(p.vy * 0.018, -0.22, 0.28);
      sy += st; sx -= st * 0.55; sz -= st * 0.55;
    }

    // dashing: stretch along travel, judder, skim off the floor
    if (p.dashT > 0) {
      const k = p.dashT / CFG.DASH_TIME;
      const s = Math.sin(k * Math.PI);
      sz += 0.62 * k; sx -= 0.26 * k; sy -= 0.16 * k;
      rx += 0.42 * k;
      rz += Math.sin(this.time * 30) * 0.06 * k;
      oy += s * 0.12;
    }

    // YEET KICK: coil back onto the standing leg, then whip the whole body
    // through the swing and wobble to a stop.
    if (p.anim === 5 && p.animT > 0) {
      const u = clamp01(1 - p.animT / 0.42);
      if (u < 0.34) {
        const k = u / 0.34;
        const e = Math.sin(k * Math.PI * 0.5);
        rx -= 0.52 * e;                       // lean away from the target
        sy -= 0.15 * e; sx += 0.12 * e; sz += 0.12 * e;
        oy -= 0.09 * e;
      } else {
        const k = (u - 0.34) / 0.66;
        const snap = Math.sin(Math.min(1, k * 2.2) * Math.PI);
        const settle = Math.sin(k * Math.PI * 4) * Math.exp(-k * 5) * 0.16;
        rx += snap * 1.12 + settle;
        sz += snap * 0.48; sx -= snap * 0.15; sy -= snap * 0.1;
        oy += snap * 0.16;
      }
    }

    // BANANA SLIP: the full pratfall - legs shoot out, body goes horizontal,
    // pancakes on the floor, lies there seeing stars, then scrambles up.
    if (p.slipT > 0) {
      const u = clamp01(1 - p.slipT / CFG.SLIP_TIME);
      const FLAT = -1.62;                     // ~90 degrees, onto the back
      const DOWN = -0.46;                     // drop the pivot to floor level
      let pitch = FLAT, lift = DOWN, wob = 0;

      if (u < 0.11) {                         // the whip: feet leave the ground
        const k = u / 0.11;
        pitch = FLAT * easeInCubic(k) * 0.72;
        lift = Math.sin(k * Math.PI) * 0.42;
        sy += (1 - k) * 0.20; sx -= (1 - k) * 0.09;
      } else if (u < 0.30) {                  // airborne and horizontal
        const k = (u - 0.11) / 0.19;
        pitch = FLAT * (0.72 + 0.28 * k);
        lift = 0.42 - 0.42 * k * k - 0.46 * k;
        ry += k * 0.5;
      } else if (u < 0.38) {                  // SLAM - pancake
        const k = (u - 0.30) / 0.08;
        const sq = Math.sin(k * Math.PI);
        sy -= sq * 0.34; sx += sq * 0.26; sz += sq * 0.20;
        // the body hits the floor a third of a second after the peel, so the
        // dust belongs here rather than on the 'slip' event
        if (!this.slipSlam[i]) {
          this.slipSlam[i] = true;
          const gy = staticHeight(tr.x, tr.z);
          this.particles.groundSpray(tr.x, gy, tr.z, hex('#e8dcff'), 16, 11);
          this.particles.puff(tr.x, gy + 0.25, tr.z, hex('#cbb8e8'), 7);
          this.shock(tr.x, tr.z, hex('#ffe14d'), 3.6, 0.34, 0.1);
          this.cam.addShake(0.7);
        }
      } else if (u < 0.74) {                  // dazed, rocking
        const k = (u - 0.38) / 0.36;
        lift = DOWN + Math.sin(k * Math.PI * 3) * 0.04;
        wob = Math.sin(k * Math.PI * 5) * 0.22 * (1 - k);
      } else {                                // scramble upright, overshoot
        const k = (u - 0.74) / 0.26;
        pitch = FLAT * (1 - easeOutBack(k));
        lift = DOWN * (1 - easeOutCubic(k));
        wob = Math.sin(k * Math.PI * 4) * 0.16 * (1 - k);
      }
      rx += pitch; rz += wob; oy += lift;

      // seeing stars while face-up
      this.fxClock[i] -= dt;
      if (u > 0.36 && u < 0.76 && this.fxClock[i] <= 0) {
        this.fxClock[i] = 0.09;
        const a = this.time * 8 + i * 2.1;
        this.particles.emit({
          x: tr.x + Math.cos(a) * 0.6, y: tr.y + 1.15, z: tr.z + Math.sin(a) * 0.6,
          vy: 0.5, life: 0.44, size: 0.15, color: hex('#ffe14d'), color2: hex('#fff8b0'),
          grav: 0, drag: 1.4, glow: 0.8, fade: 1, spin: 9, rot: a,
        });
      }
    }

    if (p.slipT <= 0 && this.slipSlam[i]) this.slipSlam[i] = false;

    // BRAINROT MAGNET: crouch to charge, then hover and spin up, pulsing
    if (p.ultT > 0) {
      const u = clamp01(1 - p.ultT / CFG.ULT_TIME);
      const rise = u < 0.16 ? Math.sin((u / 0.16) * Math.PI * 0.5) : 1;
      const crouch = u < 0.16 ? Math.sin((u / 0.16) * Math.PI) : 0;
      sy -= crouch * 0.24; sx += crouch * 0.17; sz += crouch * 0.17;
      oy += rise * (0.42 + Math.sin(this.time * 13) * 0.11);
      ry += (this.time * 6 + u * 9) * rise;
      const pulse = Math.sin(this.time * 18) * 0.05 * rise;
      sx += pulse; sz += pulse; sy -= pulse * 0.5;
      rx += Math.sin(this.time * 9) * 0.07 * rise;
    }

    // bonked: tumble
    if (p.stunT > 0) {
      const k = p.stunT / CFG.STUN;
      ry += k * 22 * (i === 0 ? 1 : -1);
      rx += Math.sin(this.time * 26) * 0.45 * k;
      sy -= 0.18 * k; sx += 0.12 * k;
    }

    // frozen: locked and pale
    const frozen = p.freezeT > 0;

    // emote
    const em = this.emote[i];
    if (em) {
      em.t -= dt;
      if (em.t <= 0) this.emote[i] = null;
      else {
        const k = 1 - em.t / 1.1;
        switch (em.id) {
          case 'spin': ry += k * TAU * 2; break;
          case 'wiggle': rz += Math.sin(k * TAU * 5) * 0.5; break;
          case 'point': rz += Math.sin(k * TAU * 3) * 0.28; sx += 0.1; break;
          case 'flex': sx += bounce01(k) * 0.28; sy += bounce01(k) * 0.1; break;
          case 'sleep': rz += k * 0.5; oy -= k * 0.2; break;
          case 'flip': rx += k * TAU; oy += bounce01(k) * 2.2; break;
          case 'explode': {
            const b = bounce01(k);
            sx += b * 0.7; sy += b * 0.7; sz += b * 0.7;
            if (k > 0.45 && k < 0.5) this.particles.burst(p.x, p.y + 0.6, p.z, TEAM[i], 22, 9);
            break;
          }
          default: ry += k * TAU;
        }
      }
    }

    // victory performance
    if (this.victory && this.victory.idx === i) {
      const vt = (this.victory.t += dt);
      switch (this.victory.id) {
        case 'spin': ry += vt * 7; oy += Math.abs(Math.sin(vt * 5)) * 0.6; break;
        case 'flex': sx += Math.sin(vt * 6) * 0.18 + 0.15; sy += 0.1; break;
        case 'confetti':
          oy += Math.abs(Math.sin(vt * 6)) * 1.1;
          if (Math.random() < 0.4) this.particles.confetti(p.x, p.y + 2.5, p.z, 8);
          break;
        case 'launch':
          oy += vt * vt * 3.2;
          this.particles.trail(p.x, p.y + oy, p.z, 'fire', hex('#ff8a1f'));
          break;
        case 'ascend':
          oy += vt * 1.4;
          if (Math.random() < 0.6) this.particles.trail(p.x, p.y + oy, p.z, 'spark', GOLD);
          break;
        default: oy += Math.abs(Math.sin(vt * 6)) * 1.3;
      }
    }

    const scaleUp = 1.0;
    m4.compose(tr.x, tr.y + oy + 0.94, tr.z, rx, ry, rz, sx * scaleUp, sy * scaleUp, sz * scaleUp, this._m);

    const holder = sim.br.owner === i;
    const tint = frozen ? [0.62, 0.86, 1.1] : WHITE;
    const add = holder
      ? [0.10 + Math.sin(this.time * 7) * 0.05, 0.08, 0.02]
      : (p.stunT > 0 ? [0.25, 0.05, 0.05] : null);

    const lineCol = p.ultT > 0 ? GOLD : (holder ? (sim.br.golden > 0 ? GOLD : TEAM[i]) : null);
    r.outline(mesh, this._m, holder ? 0.075 : 0.042, lineCol);
    r.draw(mesh, this._m, { tint, add });

    if (frozen) {
      r.setBlend(true); r.setDepthWrite(false);
      m4.compose(tr.x, tr.y + 0.94, tr.z, 0, this.time, 0, 1.25, 1.35, 1.25, this._m2);
      r.draw(mesh, this._m2, { mode: 'unlit', tint: [0.55, 0.85, 1], alpha: 0.35 });
      r.setBlend(false); r.setDepthWrite(true);
    }
  }

  /* ---------------- brainrot ---------------- */
  _brainrotAnim(def, t, out) {
    let ox = 0, oy = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1;
    switch (def.idle) {
      case 'bob':    oy = Math.sin(t * 3.4) * 0.14; rz = Math.sin(t * 1.7) * 0.08; break;
      case 'spin':   ry = t * 1.5; oy = Math.sin(t * 2.6) * 0.1; break;
      case 'wobble': rz = Math.sin(t * 4.2) * 0.28; oy = Math.abs(Math.sin(t * 4.2)) * 0.05; break;
      case 'jiggle': sy = 1 + Math.sin(t * 8) * 0.09; sx = 1 - Math.sin(t * 8) * 0.06; sz = sx; break;
      case 'pulse':  { const k = 1 + Math.sin(t * 5) * 0.11; sx = sy = sz = k; break; }
      case 'flap':   rx = Math.sin(t * 11) * 0.22; oy = Math.abs(Math.sin(t * 11)) * 0.12; break;
      case 'shiver': ox = Math.sin(t * 33) * 0.045; rz = Math.sin(t * 27) * 0.07; break;
      case 'swim':   ry = Math.sin(t * 2.1) * 0.5; rz = Math.sin(t * 3.3) * 0.16; oy = Math.sin(t * 2.7) * 0.1; break;
      default:       oy = Math.sin(t * 3) * 0.1;
    }
    out.ox = ox; out.oy = oy; out.rx = rx; out.ry = ry; out.rz = rz;
    out.sx = sx; out.sy = sy; out.sz = sz;
    return out;
  }

  _drawBrainrot(sim, dt) {
    const r = this.renderer;
    const br = sim.br;
    const def = this.brainrotDef;
    if (!def || !this.brMesh) return;

    const held = br.owner >= 0;
    let tx = br.x, ty = br.y, tz = br.z;
    if (held) {
      const tr = this.tracks[br.owner];
      tx = tr.x; ty = tr.y + CFG.BR_HOVER; tz = tr.z;
    }
    const t = this.brTrack.to(tx, ty, tz, 0, held ? 26 : 20, dt);

    const an = this._brainrotAnim(def, this.time, ANIM);
    let { ox, oy, rx, ry, rz, sx, sy, sz } = an;

    if (held) { oy += 0.16; ry += this.time * 1.2; }
    else if (!br.settled) { rx += br.spin * 4; rz += br.spin * 2.6; }

    // pickup performance
    if (this.brPickT > 0) {
      this.brPickT = Math.max(0, this.brPickT - dt * 1.9);
      const k = 1 - this.brPickT;          // 0 -> 1
      switch (def.pickup) {
        case 'squash': { const e = easeOutElastic(k); sy *= 0.55 + e * 0.45; sx *= 1.4 - e * 0.4; sz *= 1.4 - e * 0.4; break; }
        case 'spinflip': ry += (1 - easeOutCubic(k)) * TAU * 2; break;
        case 'pop': { const e = easeOutBack(clamp01(k * 1.4)); sx *= e; sy *= e; sz *= e; break; }
        case 'stretch': { const e = easeOutElastic(k); sy *= 1.6 - e * 0.6; sx *= 0.7 + e * 0.3; sz *= 0.7 + e * 0.3; break; }
        case 'tumble': { rx += (1 - easeOutCubic(k)) * TAU * 1.5; rz += (1 - easeOutCubic(k)) * TAU; break; }
        default: { const e = easeOutBack(clamp01(k * 1.4)); sx *= e; sy *= e; sz *= e; }
      }
      oy += (1 - k) * 0.5;
    }

    const golden = br.golden > 0;
    const scale = held ? 1.45 : 1.3;
    m4.compose(t.x + ox, t.y + oy, t.z, rx, ry, rz, sx * scale, sy * scale, sz * scale, this._m);

    const glow = golden ? 0.22 + Math.sin(this.time * 9) * 0.1 : 0.06 + Math.sin(this.time * 3) * 0.04;
    r.outline(this.brMesh, this._m, 0.055, golden ? hex('#7a5200') : null);
    r.draw(golden ? this.brMeshGold : this.brMesh, this._m, { add: [glow, glow * 0.85, glow * 0.2] });

    if (golden && Math.random() < 0.55) {
      this.particles.emit({
        x: t.x + (Math.random() - 0.5) * 1.4, y: t.y + (Math.random() - 0.5) * 1.2, z: t.z + (Math.random() - 0.5) * 1.4,
        vy: 1.2, life: 0.5, size: 0.13, grow: -0.16, color: GOLD, drag: 2, grav: -0.1, glow: 0.9, fade: 1,
      });
    }
  }

  _drawDecoy(sim, d) {
    const r = this.renderer;
    if (!this.decoyMesh) return;
    const an = this._brainrotAnim(this.brainrotDef, this.time + d.spin * 3, ANIM);
    const fade = clamp01(d.life / 0.6);
    m4.compose(d.x + an.ox, d.y + an.oy, d.z, an.rx + d.spin, an.ry, an.rz,
      an.sx * 1.1, an.sy * 1.1, an.sz * 1.1, this._m);
    r.outline(this.decoyMesh, this._m, 0.05);
    r.draw(this.decoyMesh, this._m, { tint: [0.9, 0.9, 1.0], add: [0.02, 0.02, 0.06] });
    if (fade < 1) { /* the pop is handled by particles */ }
  }

  /**
   * A light column marks the objective. It is loud while the brainrot is
   * loose (that is when you need to find it) and barely there while
   * someone is carrying it, because then the holder ring already says
   * everything and a fat column would block the fight.
   */
  /** thrown bananas, and the armed peels lying in wait */
  _drawBananas(sim, dt) {
    const r = this.renderer;
    if (!this.bananaMesh) this.bananaMesh = getBrainrotMesh(this.renderer.gl, 'banana');
    for (const b of sim.bananas) {
      const armed = b.armed;
      const spin = armed ? this.time * 1.2 : this.time * 9;
      const s = armed ? 0.42 : 0.34;
      const fade = Math.min(1, b.life / 1.2);
      const squash = armed ? 0.45 : 1;
      m4.compose(b.x, b.y + (armed ? 0.02 : 0), b.z,
        armed ? Math.PI / 2 : this.time * 7, spin, 0, s, s * squash, s, this._m);
      r.outline(this.bananaMesh, this._m, 0.05);
      r.draw(this.bananaMesh, this._m, { alpha: fade, add: armed ? [0.05, 0.04, 0] : null });
      if (armed && Math.random() < 0.06) {
        this.particles.emit({ x: b.x, y: b.y + 0.2, z: b.z, vy: 0.7, life: 0.5, size: 0.09,
          grow: -0.1, color: hex('#ffe14d'), drag: 2, grav: -0.1, glow: 0.6, fade: 1 });
      }
    }
  }

  _drawBeam(sim) {
    const r = this.renderer;
    const br = sim.br;
    const held = br.owner >= 0;
    let x = br.x, z = br.z, base = staticHeight(br.x, br.z);
    let col = GOLD;
    if (held) {
      const tr = this.tracks[br.owner];
      x = tr.x; z = tr.z; base = staticHeight(x, z);
      col = br.golden > 0 ? GOLD : TEAM[br.owner];
    }
    const pulse = (held ? 0.055 : 0.13) + Math.sin(this.time * 5) * (held ? 0.015 : 0.04);
    const rad = held ? 0.28 : 0.5;
    const h = held ? 3.2 : 6.5;
    r.setBlend(true); r.setDepthWrite(false); r.setCull('none');
    m4.compose(x, base, z, 0, this.time * 0.6, 0, rad, h, rad, this._m);
    r.draw(this.beam, this._m, { mode: 'unlit', tint: col, alpha: pulse });
    m4.compose(x, base, z, 0, -this.time * 0.4, 0, rad * 0.45, h * 1.15, rad * 0.45, this._m);
    r.draw(this.beam, this._m, { mode: 'unlit', tint: col, alpha: pulse * 1.6 });
    r.setCull('back'); r.setBlend(false); r.setDepthWrite(true);
  }

  /* ---------------- cosmetic trails ---------------- */
  _emitTrails(sim, dt) {
    for (let i = 0; i < 2; i++) {
      const p = sim.players[i];
      const lo = this.loadouts[i];
      if (!lo) continue;
      const item = findItem('trail', lo.trail);
      if (!item || !item.style) continue;
      const sp = Math.hypot(p.vx, p.vz);
      if (sp < 3.5 && p.onGround) continue;
      const rate = item.style === 'ribbon' || item.style === 'rift' ? 1 : clamp01(sp / CFG.SPEED);
      if (Math.random() > rate * 0.75) continue;
      let col;
      if (item.color === 'rainbow') {
        const h = (this.time * 0.4 + i * 0.4) % 1;
        col = hslc(h);
      } else col = hex(item.color || '#ffffff');
      this.particles.trail(p.x, p.y, p.z, item.style, col, p.vx, p.vz);
    }
    // speed-event streaks
    for (let i = 0; i < 2; i++) {
      const p = sim.players[i];
      if (p.speedT <= 0) continue;
      if (Math.random() < 0.7) {
        const l = Math.hypot(p.vx, p.vz) || 1;
        this.particles.speedStreak(p.x + (Math.random() - 0.5) * 1.2, p.y + 0.3 + Math.random() * 1.2,
          p.z + (Math.random() - 0.5) * 1.2, p.vx / l, p.vz / l, hex('#ffe14d'));
      }
    }
  }

  /* ---------------- nameplates ---------------- */
  _updatePlates(sim) {
    const r = this.renderer;
    for (let i = 0; i < 2; i++) {
      const el = this.plates[i];
      if (!el) continue;
      const tr = this.tracks[i];
      const pt = r.toScreen(tr.x, tr.y + 2.5, tr.z);
      if (!pt) { el.style.opacity = '0'; continue; }
      el.style.opacity = '1';
      el.style.left = pt[0].toFixed(1) + 'px';
      el.style.top = pt[1].toFixed(1) + 'px';
    }
  }


  /* ==========================================================
     MENU BACKDROP - a big idiot brainrot orbited by smaller ones
     ========================================================== */
  _initMenuScene() {
    const gl = this.renderer.gl;
    const pool = BRAINROTS_LIST;
    const pick = (i) => pool[(this._menuSeed + i * 7) % pool.length];
    this.menu = {
      hero: pick(0),
      heroMesh: getBrainrotMesh(gl, pick(0).id),
      orbit: [1, 2, 3, 4, 5].map((i) => ({
        def: pick(i),
        mesh: getBrainrotMesh(gl, pick(i).id),
        r: 6.4 + (i % 3) * 1.9,
        a: (i / 5) * TAU,
        w: 0.24 + (i % 4) * 0.07,
        y: -1.4 + (i % 4) * 1.5,
        s: 0.55 + (i % 3) * 0.14,
      })),
      t: 0,
    };
  }

  /** The main menu / sheet background. Cheap: ~7 draw calls. */
  renderMenuScene(dt) {
    const r = this.renderer;
    if (!this.menu) { this._menuSeed = (Math.random() * 997) | 0; this._initMenuScene(); }
    const m = this.menu;
    m.t += dt;
    this.time += dt;

    r.resize();
    // On a wide screen the menu buttons own the middle column, so slide the
    // hero into the empty right-hand third instead of hiding behind them.
    const wide = r.aspect > 1.25;
    // Wide: the hero sits in the empty right-hand third beside the buttons.
    // Tall: it rises from the bottom of the screen under them instead.
    const off = wide ? -5.8 : 0;
    const heroScale = wide ? 4.4 : 3.6;
    this.cam.target = [off, wide ? 0.6 : 3.9, 0];
    this.cam.dist = wide ? 15.5 : 13.5;
    this.cam.pitch = 0.2;
    this.cam.fov = wide ? 0.86 : 0.98;
    this.cam.yaw = Math.sin(m.t * 0.11) * 0.22;
    this.cam.shake = 0;
    this.cam.update(dt, r.aspect);
    r.begin(this.cam);

    // hero
    const an = this._brainrotAnim(m.hero, m.t, ANIM);
    m4.compose(an.ox, 0.4 + an.oy, 0, an.rx, an.ry + m.t * 0.4, an.rz,
      an.sx * heroScale, an.sy * heroScale, an.sz * heroScale, this._m);
    r.outline(m.heroMesh, this._m, 0.055);
    r.draw(m.heroMesh, this._m, { add: [0.04, 0.03, 0.06] });

    // little ones
    for (const o of m.orbit) {
      const a = o.a + m.t * o.w;
      const x = Math.cos(a) * o.r;
      const z = Math.sin(a) * o.r * 0.7 - 1.5;
      const y = o.y + Math.sin(m.t * 1.6 + o.a) * 0.6;
      const oan = this._brainrotAnim(o.def, m.t + o.a, ANIM);
      m4.compose(x + oan.ox, y + oan.oy, z, oan.rx, oan.ry + a, oan.rz,
        oan.sx * o.s, oan.sy * o.s, oan.sz * o.s, this._m2);
      r.outline(o.mesh, this._m2, 0.05);
      r.draw(o.mesh, this._m2);
    }

    /* Ambient confetti, spawned across what the camera can actually see.
       On a wide screen the camera slides left to make room for the hero, so
       spawning around the world origin would leave the left edge bare and
       waste everything that drifts up off the right. */
    const halfW = Math.tan(this.cam.fov / 2) * this.cam.dist * Math.max(0.4, r.aspect);
    if (Math.random() < 0.45) {
      this.particles.emit({
        x: this.cam.target[0] + (Math.random() - 0.5) * halfW * 2.2,
        y: -6,
        z: (Math.random() - 0.5) * 14 - 2,
        vy: 1.4 + Math.random(), life: 6, size: 0.14 + Math.random() * 0.12, grow: 0,
        color: Math.random() < 0.5 ? TEAM[0] : TEAM[1], drag: 0.05, grav: -0.04,
        glow: 0.5, spin: 1.2, fade: 1,
      });
    }
    this.particles.update(dt);
    const v = this.cam.view;
    this.particles.build(this.pmesh, [v[0], v[4], v[8]], [v[1], v[5], v[9]]);
    r.setBlend(true); r.setDepthWrite(false); r.setCull('none');
    m4.identity(this._m);
    r.draw(this.pmesh, this._m, { mode: 'unlit' });
    r.setCull('back'); r.setBlend(false); r.setDepthWrite(true);

    this.showPlates(false);
  }

  /* ---------------- misc ---------------- */
  worldToScreen(x, y, z) { return this.renderer.toScreen(x, y, z); }

  dispose() {
    for (const el of this.plates) el?.remove();
    this.plates.length = 0;
  }
}

const ANIM = { ox: 0, oy: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 };

function hslc(h) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = 0.9 * Math.min(0.6, 1 - 0.6);
    return 0.6 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export { TEAM_CSS, TEAM };
