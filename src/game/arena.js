/* ============================================================
   arena.js - the playfield.

   One compact, readable box: a raised golden dais in the middle
   (where the Brainrot spawns), four ramps up to it, four cover
   pillars, bounce pads, speed rings and two orbiting platforms.

   Everything here is PURE and deterministic - the simulation and
   the renderer both read from these same functions, so host and
   client always agree about the floor.
   ============================================================ */

import { MeshData, addPart, getDetail } from '../gfx/mesh.js';
import { Mesh } from '../gfx/gl.js';
import { TAU, clamp } from '../core/util.js';
import { MAPS, BASE_DIMS, BASE_COLORS, mapForSeed } from './maps.js';

export { MAPS, mapForSeed };

/* ---------- the live map ----------
   These containers keep their identity for the life of the page. The bundler
   rewrites `import { A }` into a destructured copy, so reassigning an export
   would work in dev and silently break in dist/ - mutate in place instead.
   Both the simulation and the renderer read these, so host and client always
   agree about the floor. -------------------------------------------------- */
export const A = { ...BASE_DIMS };
export const RAMP_ANGLES = [];
export const PILLARS = [];
export const BOUNCE_PADS = [];
export const SPEED_ZONES = [];
export const STEPS = [];

let currentIndex = -1;

export function currentMap() { return MAPS[currentIndex] || MAPS[0]; }
export function currentMapIndex() { return Math.max(0, currentIndex); }

/**
 * Swap the live arena. Must run before the sim steps and before the arena
 * mesh is rebuilt, and must be given the same index on both clients.
 * Returns the map definition, or null when it was already active.
 */
export function setArena(index) {
  const i = (((index | 0) % MAPS.length) + MAPS.length) % MAPS.length;
  if (i === currentIndex) return null;
  const m = MAPS[i];
  currentIndex = i;

  for (const k of Object.keys(A)) delete A[k];
  Object.assign(A, BASE_DIMS, m.dims);

  const fill = (arr, src) => { arr.length = 0; for (const v of src) arr.push(v); };
  fill(RAMP_ANGLES, m.ramps);
  fill(PILLARS, m.pillars);
  fill(BOUNCE_PADS, m.pads);
  fill(SPEED_ZONES, m.zones);
  fill(STEPS, m.steps);

  for (const k of Object.keys(C)) delete C[k];
  Object.assign(C, BASE_COLORS, m.colors);
  return m;
}

/* ---------- queries (deterministic, allocation-free) ---------- */

/** Static walkable height at a point, ignoring moving platforms. */
export function staticHeight(x, z) {
  const r = Math.hypot(x, z);
  if (r <= A.DAIS_R) return A.DAIS_H;
  if (r < A.RAMP_END) {
    for (let i = 0; i < RAMP_ANGLES.length; i++) {
      const a = RAMP_ANGLES[i], ca = Math.cos(a), sa = Math.sin(a);
      const lx = x * ca + z * sa;
      const lz = -x * sa + z * ca;
      if (lx > A.DAIS_R - 0.35 && lx < A.RAMP_END && Math.abs(lz) < A.RAMP_HW) {
        const t = (lx - A.DAIS_R) / (A.RAMP_END - A.DAIS_R);
        return A.DAIS_H * (1 - clamp(t, 0, 1));
      }
    }
  }
  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    if (Math.abs(x - s.x) < s.w && Math.abs(z - s.z) < s.d) return s.h;
  }
  return 0;
}

/** Orbiting platform centre at simulation time `t`. */
export function moverPos(i, t, out = { x: 0, z: 0, vx: 0, vz: 0 }) {
  const a = t * A.ORB_W + (i * TAU) / Math.max(1, A.MOVERS);
  out.x = Math.cos(a) * A.ORB_R;
  out.z = Math.sin(a) * A.ORB_R;
  out.vx = -Math.sin(a) * A.ORB_R * A.ORB_W;
  out.vz = Math.cos(a) * A.ORB_R * A.ORB_W;
  return out;
}
export const moverCount = () => A.MOVERS;

const _mp = { x: 0, z: 0, vx: 0, vz: 0 };

/**
 * Walkable height under an entity, taking orbiting platforms into
 * account (you only land on one if you are at or above its top).
 * Returns { h, vx, vz, mover }
 */
export function groundInfo(x, z, y, t, out = { h: 0, vx: 0, vz: 0, mover: -1 }) {
  out.h = staticHeight(x, z);
  out.vx = 0; out.vz = 0; out.mover = -1;
  for (let i = 0; i < A.MOVERS; i++) {
    moverPos(i, t, _mp);
    const dx = x - _mp.x, dz = z - _mp.z;
    if (dx * dx + dz * dz < A.ORB_PR * A.ORB_PR) {
      if (y >= A.ORB_H - 0.35 && A.ORB_H > out.h) {
        out.h = A.ORB_H; out.vx = _mp.vx; out.vz = _mp.vz; out.mover = i;
      }
    }
  }
  return out;
}

/** Resolve solid collisions (pillars + walls). Mutates {x,z}. */
export function resolveSolids(e, radius) {
  for (let i = 0; i < PILLARS.length; i++) {
    const p = PILLARS[i];
    const pr = (p.r || A.PILLAR_R) + radius;
    const dx = e.x - p.x, dz = e.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < pr * pr && d2 > 1e-8) {
      const d = Math.sqrt(d2), push = (pr - d) / d;
      e.x += dx * push; e.z += dz * push;
      const vn = (e.vx * dx + e.vz * dz) / d2;
      if (vn < 0) { e.vx -= dx * vn; e.vz -= dz * vn; }
    }
  }
  const lim = A.HALF - radius;
  if (e.x > lim) { e.x = lim; if (e.vx > 0) e.vx *= -0.32; }
  if (e.x < -lim) { e.x = -lim; if (e.vx < 0) e.vx *= -0.32; }
  if (e.z > lim) { e.z = lim; if (e.vz > 0) e.vz *= -0.32; }
  if (e.z < -lim) { e.z = -lim; if (e.vz < 0) e.vz *= -0.32; }
}

export function onBouncePad(x, z) {
  for (let i = 0; i < BOUNCE_PADS.length; i++) {
    const p = BOUNCE_PADS[i];
    const dx = x - p.x, dz = z - p.z;
    if (dx * dx + dz * dz < A.PAD_R * A.PAD_R) return i;
  }
  return -1;
}

/** returns a tangential push vector or null */
export function speedZoneAt(x, z, out = { x: 0, z: 0 }) {
  for (let i = 0; i < SPEED_ZONES.length; i++) {
    const s = SPEED_ZONES[i];
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz < A.ZONE_R * A.ZONE_R) {
      const l = Math.hypot(s.x, s.z) || 1;
      out.x = -s.z / l; out.z = s.x / l;   // counter-clockwise tangent
      return out;
    }
  }
  return null;
}

/** A safe respawn / teleport target, deterministic from an RNG. */
export function randomSpot(rng, minR = 6, maxR = 17) {
  for (let tries = 0; tries < 24; tries++) {
    const a = rng.angle();
    const r = minR + rng.next() * (maxR - minR);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let ok = true;
    for (const p of PILLARS) {
      const pr = (p.r || A.PILLAR_R) + 1.6;
      if ((x - p.x) ** 2 + (z - p.z) ** 2 < pr * pr) { ok = false; break; }
    }
    if (ok) return { x, z };
  }
  return { x: 0, z: minR };
}

/* ============================================================
   MESH
   ============================================================ */
const P = (shape, pos, scale, color, extra) => ({
  shape, pos, scale: typeof scale === 'number' ? [scale, scale, scale] : scale, color, ...(extra || {}),
});

const C = { ...BASE_COLORS };

const meshCache = new Map();

/**
 * Build (or reuse) the mesh set for whichever map is currently loaded.
 * Keyed by map and detail level: a phone that drops detail mid-session gets
 * a fresh bake, everyone else pays for each arena once.
 */
export function buildArenaMesh(gl) {
  const key = currentMapIndex() + '|' + getDetail();
  const hit = meshCache.get(key);
  if (hit) return hit;
  const built = bakeArenaMesh(gl);
  meshCache.set(key, built);
  return built;
}

function bakeArenaMesh(gl) {
  const md = new MeshData();

  /* --- backdrop: an endless dark floor, so looking past the wall shows a
         world instead of a black void; and a base slab under the tiles so
         the seams read as grout rather than holes --- */
  addPart(md, P('disc', [0, -2.4, 0], [90, 1, 90], '#241040'));
  const rings = getDetail() < 0.75 ? 1 : 3;
  for (let k = 0; k < rings; k++) {
    const rr = A.HALF + 6 + k * 9;
    addPart(md, P('torus', [0, -2.3 + k * 0.02, 0], [rr, 0.9, rr], k % 2 ? '#2c1450' : '#331a5c'));
  }
  addPart(md, P('torus', [0, -2.3, 0], [A.HALF + 3.5, 0.6, A.HALF + 3.5], '#3a1a5c'));
  addPart(md, P('box', [0, -0.62, 0], [A.HALF + 0.4, 0.35, A.HALF + 0.4], '#2f1750'));

  /* --- floor: tile grid, cheap and gives a real sense of speed --- */
  // The floor grid is the bulk of this mesh. On a phone the checkerboard
  // reads fine at half the density and bakes in a fraction of the time.
  const TS = getDetail() < 0.75 ? 4.5 : 2.5;
  const N = Math.ceil(A.HALF / TS);
  for (let ix = -N; ix < N; ix++) {
    for (let iz = -N; iz < N; iz++) {
      const cx = ix * TS + TS / 2, cz = iz * TS + TS / 2;
      if (Math.hypot(cx, cz) < A.DAIS_R - 1.2) continue;    // hidden by the dais
      const alt = ((ix + iz) & 1) === 0;
      addPart(md, P('box', [cx, -0.25, cz], [TS / 2 - 0.045, 0.25, TS / 2 - 0.045],
        alt ? C.tileA : C.tileB, { round: 0.05 }));
    }
  }

  /* --- central dais --- */
  addPart(md, P('cyl', [0, A.DAIS_H / 2 - 0.02, 0], [A.DAIS_R, A.DAIS_H / 2, A.DAIS_R], C.daisSide));
  addPart(md, P('cyl', [0, A.DAIS_H - 0.03, 0], [A.DAIS_R - 0.12, 0.07, A.DAIS_R - 0.12], C.dais));
  addPart(md, P('torus', [0, A.DAIS_H - 0.02, 0], [A.DAIS_R, 0.11, A.DAIS_R], C.daisRim, { emissive: 0.25 }));
  addPart(md, P('cyl', [0, A.DAIS_H + 0.005, 0], [2.1, 0.02, 2.1], C.daisRim, { emissive: 0.35 }));
  addPart(md, P('torus', [0, A.DAIS_H + 0.02, 0], [3.2, 0.05, 3.2], '#ffffff', { emissive: 0.4 }));

  /* --- ramps --- */
  const rl = (A.RAMP_END - A.DAIS_R + 0.6) / 2;
  const tilt = Math.atan2(A.DAIS_H, A.RAMP_END - A.DAIS_R);
  for (const a of RAMP_ANGLES) {
    const mid = (A.DAIS_R + A.RAMP_END) / 2 - 0.2;
    const cx = Math.cos(a) * mid, cz = Math.sin(a) * mid;
    addPart(md, P('box', [cx, A.DAIS_H / 2 - 0.16, cz], [rl, 0.16, A.RAMP_HW],
      C.ramp, { rot: [0, -a, -tilt], round: 0.05 }));
    for (const s of [-1, 1]) {
      const ox = -Math.sin(a) * A.RAMP_HW * s, oz = Math.cos(a) * A.RAMP_HW * s;
      addPart(md, P('box', [cx + ox, A.DAIS_H / 2 - 0.05, cz + oz], [rl, 0.09, 0.12],
        C.rampEdge, { rot: [0, -a, -tilt], emissive: 0.2 }));
    }
  }

  /* --- perimeter walls --- */
  const H = A.HALF, WH = A.WALL_H;
  for (let s = 0; s < 4; s++) {
    const a = s * Math.PI / 2;
    const cx = Math.cos(a) * H, cz = Math.sin(a) * H;
    addPart(md, P('box', [cx, WH / 2 - 0.3, cz], [0.4, WH / 2, H + 0.4], C.wall, { rot: [0, -a, 0] }));
    addPart(md, P('box', [cx, WH - 0.28, cz], [0.5, 0.12, H + 0.4],
      s % 2 ? C.wallTop2 : C.wallTop, { rot: [0, -a, 0], emissive: 0.55 }));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    addPart(md, P('cyl', [sx * H, WH / 2 - 0.2, sz * H], [0.75, WH / 2 + 0.25, 0.75], C.wall));
    addPart(md, P('sphere', [sx * H, WH + 0.35, sz * H], [0.6, 0.6, 0.6], '#ffd23f', { emissive: 0.6 }));
  }

  /* --- pillars --- */
  for (const p of PILLARS) {
    const r = p.r || A.PILLAR_R, h = p.h || A.PILLAR_H;
    addPart(md, P('cyl', [p.x, h / 2, p.z], [r, h / 2, r], C.pillar));
    addPart(md, P('torus', [p.x, h, p.z], [r, 0.1, r], C.pillarTop, { emissive: 0.5 }));
    addPart(md, P('cyl', [p.x, h + 0.06, p.z], [r * 0.92, 0.06, r * 0.92], '#5f3892'));
  }

  /* --- steps --- */
  for (const s of STEPS) {
    addPart(md, P('box', [s.x, s.h / 2, s.z], [s.w, s.h / 2, s.d], C.step, { round: 0.08 }));
    addPart(md, P('box', [s.x, s.h - 0.02, s.z], [s.w - 0.1, 0.05, s.d - 0.1], C.stepTop, { emissive: 0.2 }));
  }

  /* --- bounce pads --- */
  for (const p of BOUNCE_PADS) {
    addPart(md, P('cyl', [p.x, 0.09, p.z], [A.PAD_R, 0.09, A.PAD_R], C.padRim));
    addPart(md, P('cyl', [p.x, 0.2, p.z], [A.PAD_R - 0.22, 0.09, A.PAD_R - 0.22], C.pad, { emissive: 0.5 }));
    addPart(md, P('cone', [p.x, 0.42, p.z], [0.5, 0.28, 0.5], '#ffffff', { emissive: 0.7 }));
  }

  /* --- speed zones --- */
  for (const s of SPEED_ZONES) {
    const l = Math.hypot(s.x, s.z) || 1;
    const yaw = Math.atan2(s.x / l, -s.z / l);
    addPart(md, P('cyl', [s.x, 0.045, s.z], [A.ZONE_R, 0.045, A.ZONE_R], '#123a52'));
    for (let k = -1; k <= 1; k++) {
      addPart(md, P('cone', [s.x - (s.z / l) * k * 1.1, 0.11, s.z + (s.x / l) * k * 1.1],
        [0.6, 0.5, 0.45], C.zone, { rot: [Math.PI / 2, yaw, 0], emissive: 0.6 }));
    }
  }

  const mesh = new Mesh(gl, md);

  /* --- one orbiting platform, drawn twice with its own transform --- */
  const pm = new MeshData();
  addPart(pm, P('cyl', [0, -0.14, 0], [A.ORB_PR, 0.16, A.ORB_PR], C.mover));
  addPart(pm, P('cyl', [0, 0.01, 0], [A.ORB_PR - 0.14, 0.05, A.ORB_PR - 0.14], C.moverTop, { emissive: 0.25 }));
  addPart(pm, P('torus', [0, 0.0, 0], [A.ORB_PR, 0.11, A.ORB_PR], '#ffe08a', { emissive: 0.45 }));
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4;
    addPart(pm, P('cyl', [Math.cos(a) * (A.ORB_PR - 0.3), -0.7, Math.sin(a) * (A.ORB_PR - 0.3)],
      [0.12, 0.6, 0.12], '#a35a12'));
  }
  const moverMesh = new Mesh(gl, pm);

  /* --- hazard disc, reused for every temporary danger zone --- */
  const hz = new MeshData();
  addPart(hz, P('cyl', [0, 0.03, 0], [1, 0.03, 1], '#ff2d55', { emissive: 0.5, alpha: 0.55 }));
  addPart(hz, P('torus', [0, 0.06, 0], [1, 0.05, 1], '#ffd23f', { emissive: 0.9, alpha: 0.9 }));
  const hazardMesh = new Mesh(gl, hz);

  return { mesh, moverMesh, hazardMesh, tris: md.triCount };
}

setArena(0);
