/* ============================================================
   mesh.js - procedural primitives + a mesh accumulator.

   Every model in the game (characters, brainrots, arena) is baked
   from these primitives into ONE interleaved buffer, so a whole
   character costs a single draw call.

   Convention: all primitives are "unit" - radius / half-extent 1 -
   so a part's `scale` is literally its half-size in world units.
   ============================================================ */

import { hex } from '../core/util.js';
import * as m4 from './m4.js';

/** global detail multiplier, lowered on weak devices */
export let DETAIL = 1;
export function setDetail(d) { DETAIL = d; }
const seg = (n) => Math.max(4, Math.round(n * DETAIL));

/* ------------------------------------------------------------
   Geometry builders -> { p:Float array, n:Float array, i:Int array }
   ------------------------------------------------------------ */
const cache = new Map();
function cached(key, fn) {
  let g = cache.get(key);
  if (!g) { g = fn(); cache.set(key, g); }
  return g;
}
export function clearGeoCache() { cache.clear(); }

export function sphereGeo(su = 14, sv = 10) {
  return cached(`sph${su}_${sv}_${DETAIL}`, () => {
    const U = seg(su), V = seg(sv);
    const p = [], n = [], i = [];
    for (let v = 0; v <= V; v++) {
      const phi = (v / V) * Math.PI;
      const sp = Math.sin(phi), cp = Math.cos(phi);
      for (let u = 0; u <= U; u++) {
        const th = (u / U) * Math.PI * 2;
        const x = sp * Math.cos(th), y = cp, z = sp * Math.sin(th);
        p.push(x, y, z); n.push(x, y, z);
      }
    }
    for (let v = 0; v < V; v++) for (let u = 0; u < U; u++) {
      const a = v * (U + 1) + u, b = a + U + 1;
      i.push(a, b, a + 1, b, b + 1, a + 1);
    }
    return { p, n, i };
  });
}

/** rounded box: subdivided cube blended toward a sphere by `round` (0..1) */
export function boxGeo(round = 0) {
  const r = Math.round(round * 10) / 10;
  return cached(`box${r}_${DETAIL}`, () => {
    const N = r > 0 ? seg(5) : 1;
    const p = [], n = [], i = [];
    const faces = [
      [[1,0,0],[0,1,0],[0,0,1]],  [[-1,0,0],[0,1,0],[0,0,-1]],
      [[0,1,0],[0,0,1],[1,0,0]],  [[0,-1,0],[0,0,-1],[1,0,0]],
      [[0,0,1],[0,1,0],[-1,0,0]], [[0,0,-1],[0,1,0],[1,0,0]],
    ];
    for (const [nrm, up, right] of faces) {
      const base = p.length / 3;
      for (let a = 0; a <= N; a++) for (let b = 0; b <= N; b++) {
        const ua = (a / N) * 2 - 1, ub = (b / N) * 2 - 1;
        let x = nrm[0] + up[0] * ua + right[0] * ub;
        let y = nrm[1] + up[1] * ua + right[1] * ub;
        let z = nrm[2] + up[2] * ua + right[2] * ub;
        let nx = nrm[0], ny = nrm[1], nz = nrm[2];
        if (r > 0) {
          const l = Math.hypot(x, y, z) || 1;
          const sx = x / l, sy = y / l, sz = z / l;
          x += (sx - x) * r; y += (sy - y) * r; z += (sz - z) * r;
          nx += (sx - nx) * r; ny += (sy - ny) * r; nz += (sz - nz) * r;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; ny /= nl; nz /= nl;
        }
        p.push(x, y, z); n.push(nx, ny, nz);
      }
      for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
        const q = base + a * (N + 1) + b;
        i.push(q, q + N + 1, q + 1, q + N + 1, q + N + 2, q + 1);
      }
    }
    return { p, n, i };
  });
}

/** cylinder: radius 1, half-height 1 */
export function cylGeo(su = 14) {
  return cached(`cyl${su}_${DETAIL}`, () => {
    const U = seg(su);
    const p = [], n = [], i = [];
    for (let u = 0; u <= U; u++) {
      const th = (u / U) * Math.PI * 2, cx = Math.cos(th), cz = Math.sin(th);
      p.push(cx, 1, cz); n.push(cx, 0, cz);
      p.push(cx, -1, cz); n.push(cx, 0, cz);
    }
    for (let u = 0; u < U; u++) {
      const a = u * 2;
      i.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    for (const y of [1, -1]) {
      const c = p.length / 3;
      p.push(0, y, 0); n.push(0, y, 0);
      for (let u = 0; u <= U; u++) {
        const th = (u / U) * Math.PI * 2;
        p.push(Math.cos(th), y, Math.sin(th)); n.push(0, y, 0);
      }
      for (let u = 0; u < U; u++) {
        if (y > 0) i.push(c, c + 1 + u, c + 2 + u);
        else i.push(c, c + 2 + u, c + 1 + u);
      }
    }
    return { p, n, i };
  });
}

/** cone: base radius 1 at y=-1, apex at y=+1 */
export function coneGeo(su = 14) {
  return cached(`cone${su}_${DETAIL}`, () => {
    const U = seg(su);
    const p = [], n = [], i = [];
    for (let u = 0; u < U; u++) {
      const t0 = (u / U) * Math.PI * 2, t1 = ((u + 1) / U) * Math.PI * 2, tm = (t0 + t1) / 2;
      const nx = Math.cos(tm) * 0.89, ny = 0.45, nz = Math.sin(tm) * 0.89;
      const b = p.length / 3;
      p.push(0, 1, 0, Math.cos(t0), -1, Math.sin(t0), Math.cos(t1), -1, Math.sin(t1));
      n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      i.push(b, b + 1, b + 2);
    }
    const c = p.length / 3;
    p.push(0, -1, 0); n.push(0, -1, 0);
    for (let u = 0; u <= U; u++) {
      const th = (u / U) * Math.PI * 2;
      p.push(Math.cos(th), -1, Math.sin(th)); n.push(0, -1, 0);
    }
    for (let u = 0; u < U; u++) i.push(c, c + 2 + u, c + 1 + u);
    return { p, n, i };
  });
}

/** capsule: radius 1, cylinder half-height h (total half-height h+1) */
export function capsuleGeo(h, su = 12, sv = 6) {
  const hk = Math.round(h * 20) / 20;
  return cached(`cap${hk}_${su}_${sv}_${DETAIL}`, () => {
    const U = seg(su), V = seg(sv);
    const p = [], n = [], i = [];
    const rows = [];
    for (let v = 0; v <= V; v++) {            // top hemisphere
      const phi = (v / V) * (Math.PI / 2);
      rows.push({ y: hk + Math.cos(phi), r: Math.sin(phi), ny: Math.cos(phi) });
    }
    for (let v = 0; v <= V; v++) {            // bottom hemisphere
      const phi = (Math.PI / 2) + (v / V) * (Math.PI / 2);
      rows.push({ y: -hk + Math.cos(phi), r: Math.sin(phi), ny: Math.cos(phi) });
    }
    for (const row of rows) {
      for (let u = 0; u <= U; u++) {
        const th = (u / U) * Math.PI * 2, cx = Math.cos(th), cz = Math.sin(th);
        p.push(cx * row.r, row.y, cz * row.r);
        n.push(cx * row.r, row.ny, cz * row.r);
      }
    }
    for (let v = 0; v < rows.length - 1; v++) for (let u = 0; u < U; u++) {
      const a = v * (U + 1) + u, b = a + U + 1;
      i.push(a, b, a + 1, b, b + 1, a + 1);
    }
    return { p, n, i };
  });
}

/** torus: major radius 1 in XZ, tube radius `t`, optional partial `arc` (0..1) */
export function torusGeo(t, arc = 1, su = 18, sv = 8) {
  const tk = Math.round(t * 50) / 50, ak = Math.round(arc * 20) / 20;
  return cached(`tor${tk}_${ak}_${DETAIL}`, () => {
    const U = Math.max(6, Math.round(seg(su) * ak)), V = seg(sv);
    const p = [], n = [], i = [];
    for (let u = 0; u <= U; u++) {
      const th = (u / U) * Math.PI * 2 * ak, ct = Math.cos(th), st = Math.sin(th);
      for (let v = 0; v <= V; v++) {
        const ph = (v / V) * Math.PI * 2, cp = Math.cos(ph), sp = Math.sin(ph);
        p.push((1 + tk * cp) * ct, tk * sp, (1 + tk * cp) * st);
        n.push(cp * ct, sp, cp * st);
      }
    }
    for (let u = 0; u < U; u++) for (let v = 0; v < V; v++) {
      const a = u * (V + 1) + v, b = a + V + 1;
      i.push(a, b, a + 1, b, b + 1, a + 1);
    }
    return { p, n, i };
  });
}

/** pizza-slice sector: apex at z=-0.55, arc tip at z=+0.6, half-thickness 1 */
export function wedgeGeo(halfAngle = 0.56) {
  return cached(`wed${halfAngle}_${DETAIL}`, () => {
    const U = seg(8), R = 1.15, AZ = -0.55;
    const p = [], n = [], i = [];
    const rim = [];
    for (let u = 0; u <= U; u++) {
      const a = -halfAngle + (u / U) * halfAngle * 2;
      rim.push([Math.sin(a) * R, AZ + Math.cos(a) * R]);
    }
    for (const y of [1, -1]) {                 // top + bottom caps
      const c = p.length / 3;
      p.push(0, y, AZ); n.push(0, y, 0);
      for (const [x, z] of rim) { p.push(x, y, z); n.push(0, y, 0); }
      for (let u = 0; u < U; u++) {
        if (y > 0) i.push(c, c + 1 + u, c + 2 + u); else i.push(c, c + 2 + u, c + 1 + u);
      }
    }
    for (let u = 0; u < U; u++) {              // curved crust
      const [x0, z0] = rim[u], [x1, z1] = rim[u + 1];
      const b = p.length / 3;
      const nx = (x0 + x1) / 2, nz = (z0 + z1) / 2 - AZ, nl = Math.hypot(nx, nz) || 1;
      p.push(x0, 1, z0, x1, 1, z1, x1, -1, z1, x0, -1, z0);
      for (let k = 0; k < 4; k++) n.push(nx / nl, 0, nz / nl);
      i.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    for (const [sx, dir] of [[0, 1], [U, -1]]) {   // the two flat cut faces
      const [x, z] = rim[sx];
      const b = p.length / 3;
      const nx = dir * Math.cos(halfAngle), nz = -dir * Math.sin(halfAngle);
      p.push(0, 1, AZ, x, 1, z, x, -1, z, 0, -1, AZ);
      for (let k = 0; k < 4; k++) n.push(nx, 0, nz);
      if (dir > 0) i.push(b, b + 1, b + 2, b, b + 2, b + 3);
      else i.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    return { p, n, i };
  });
}

/** flat disc in the XZ plane, radius 1 - blob shadows, decals */
export function discGeo(su = 16) {
  return cached(`disc${su}_${DETAIL}`, () => {
    const U = seg(su);
    const p = [0, 0, 0], n = [0, 1, 0], i = [];
    for (let u = 0; u <= U; u++) {
      const th = (u / U) * Math.PI * 2;
      p.push(Math.cos(th), 0, Math.sin(th)); n.push(0, 1, 0);
    }
    for (let u = 0; u < U; u++) i.push(0, u + 1, u + 2);
    return { p, n, i };
  });
}

/** axis-aligned quad in XZ, half-extent 1 */
export function quadGeo() {
  return cached('quad', () => ({
    p: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1],
    n: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    i: [0, 2, 1, 0, 3, 2],
  }));
}

/* ------------------------------------------------------------
   MeshData - accumulates transformed primitives
   ------------------------------------------------------------ */
export class MeshData {
  constructor() {
    this.pos = []; this.nrm = []; this.col = []; this.flg = []; this.idx = [];
    this.bounds = { minY: Infinity, maxY: -Infinity, r: 0 };
  }

  /**
   * @param geo  primitive from a *Geo() builder
   * @param mat  m4 transform
   * @param color [r,g,b] 0..1
   * @param flags {emissive, metal, alpha, bend}
   */
  add(geo, mat, color, flags = {}) {
    const base = this.pos.length / 3;
    const em = flags.emissive || 0, mt = flags.metal || 0, al = flags.alpha == null ? 1 : flags.alpha;
    const bend = flags.bend || 0;
    const P = geo.p, N = geo.n;
    for (let k = 0; k < P.length; k += 3) {
      let x = P[k], y = P[k + 1], z = P[k + 2];
      if (bend) x += bend * y * y;
      const wx = mat[0]*x + mat[4]*y + mat[8]*z  + mat[12];
      const wy = mat[1]*x + mat[5]*y + mat[9]*z  + mat[13];
      const wz = mat[2]*x + mat[6]*y + mat[10]*z + mat[14];
      this.pos.push(wx, wy, wz);
      let nx = N[k], ny = N[k + 1], nz = N[k + 2];
      const tx = mat[0]*nx + mat[4]*ny + mat[8]*nz;
      const ty = mat[1]*nx + mat[5]*ny + mat[9]*nz;
      const tz = mat[2]*nx + mat[6]*ny + mat[10]*nz;
      const l = Math.hypot(tx, ty, tz) || 1;
      this.nrm.push(tx / l, ty / l, tz / l);
      this.col.push(color[0], color[1], color[2]);
      this.flg.push(em, mt, al);
      if (wy < this.bounds.minY) this.bounds.minY = wy;
      if (wy > this.bounds.maxY) this.bounds.maxY = wy;
      const rr = Math.hypot(wx, wz);
      if (rr > this.bounds.r) this.bounds.r = rr;
    }
    /* Winding fix.
       The primitive generators grew organically and some emit CW
       triangles while others emit CCW. Rather than hand-auditing every
       loop, every triangle is checked against its own vertex normals here -
       which are always outward - and flipped when they disagree. This
       runs once per bake and guarantees back-face culling and the
       inverted-hull outlines behave. */
    const I = geo.i;
    const P2 = this.pos, N2 = this.nrm;
    for (let k = 0; k < I.length; k += 3) {
      let i0 = base + I[k], i1 = base + I[k + 1], i2 = base + I[k + 2];
      const a0 = i0 * 3, a1 = i1 * 3, a2 = i2 * 3;
      const e1x = P2[a1] - P2[a0], e1y = P2[a1 + 1] - P2[a0 + 1], e1z = P2[a1 + 2] - P2[a0 + 2];
      const e2x = P2[a2] - P2[a0], e2y = P2[a2 + 1] - P2[a0 + 1], e2z = P2[a2 + 2] - P2[a0 + 2];
      const gx = e1y * e2z - e1z * e2y;
      const gy = e1z * e2x - e1x * e2z;
      const gz = e1x * e2y - e1y * e2x;
      const nx = N2[a0] + N2[a1] + N2[a2];
      const ny = N2[a0 + 1] + N2[a1 + 1] + N2[a2 + 1];
      const nz = N2[a0 + 2] + N2[a1 + 2] + N2[a2 + 2];
      if (gx * nx + gy * ny + gz * nz < 0) { const t = i1; i1 = i2; i2 = t; }
      this.idx.push(i0, i1, i2);
    }
    return this;
  }

  /** append another MeshData (already in world space) */
  merge(other) {
    const base = this.pos.length / 3;
    for (let k = 0; k < other.pos.length; k++) this.pos.push(other.pos[k]);
    for (let k = 0; k < other.nrm.length; k++) this.nrm.push(other.nrm[k]);
    for (let k = 0; k < other.col.length; k++) this.col.push(other.col[k]);
    for (let k = 0; k < other.flg.length; k++) this.flg.push(other.flg[k]);
    for (let k = 0; k < other.idx.length; k++) this.idx.push(base + other.idx[k]);
    this.bounds.minY = Math.min(this.bounds.minY, other.bounds.minY);
    this.bounds.maxY = Math.max(this.bounds.maxY, other.bounds.maxY);
    this.bounds.r = Math.max(this.bounds.r, other.bounds.r);
    return this;
  }

  get vertexCount() { return this.pos.length / 3; }
  get triCount() { return this.idx.length / 3; }
}

const TMP = m4.create();

/**
 * Bake one recipe part (see data/brainrots.js) into `md`.
 * Handles the per-shape scale conventions.
 */
export function addPart(md, part, extraMat = null, colorOverride = null) {
  const [px, py, pz] = part.pos;
  const [sx, sy, sz] = part.scale;
  const rot = part.rot || [0, 0, 0];
  const color = colorOverride || (typeof part.color === 'string' ? hex(part.color) : part.color);
  const flags = { emissive: part.emissive, metal: part.metal, alpha: part.alpha, bend: part.bend };

  let geo, gsx = sx, gsy = sy, gsz = sz;
  switch (part.shape) {
    case 'sphere': geo = sphereGeo(); break;
    case 'box':    geo = boxGeo(part.round || 0); break;
    case 'cyl':    geo = cylGeo(); break;
    case 'cone':   geo = coneGeo(); break;
    case 'disc':   geo = discGeo(); break;
    case 'quad':   geo = quadGeo(); break;
    case 'wedge':  geo = wedgeGeo(part.halfAngle || 0.56); break;
    case 'torus': {
      const major = (sx + sz) / 2;
      geo = torusGeo(Math.max(0.02, sy / Math.max(0.001, major)), part.arc || 1);
      gsy = major;
      break;
    }
    case 'capsule': {
      const r = (sx + sz) / 2;
      const h = Math.max(0, (sy - r) / Math.max(0.001, r));
      geo = capsuleGeo(h);
      gsy = r;
      break;
    }
    default: geo = sphereGeo();
  }

  m4.compose(px, py, pz, rot[0], rot[1], rot[2], gsx, gsy, gsz, TMP);
  if (extraMat) m4.multiply(extraMat, TMP, TMP);
  md.add(geo, TMP, color, flags);
  return md;
}

/** Bake a whole list of parts into a fresh MeshData. */
export function bakeParts(parts, extraMat = null) {
  const md = new MeshData();
  for (const p of parts) addPart(md, p, extraMat);
  return md;
}
