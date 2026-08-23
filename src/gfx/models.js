/* ============================================================
   models.js - turns data recipes into baked GPU meshes.

   Brainrots and players are each ONE mesh / one draw call.
   Animation is whole-body squash, stretch, lean and spin, which
   is both the cheapest option and the most cartoon-correct one.
   ============================================================ */

import { MeshData, bakeParts, addPart } from './mesh.js';
import { Mesh } from './gl.js';
import { hex, shade, mixc } from '../core/util.js';
import { BRAINROT_BY_ID } from '../data/brainrots.js';
import { findItem } from '../data/cosmetics.js';

const P = (shape, pos, scale, color, extra) => ({
  shape, pos, scale: typeof scale === 'number' ? [scale, scale, scale] : scale, color, ...(extra || {}),
});

const EYE_WHITE = '#ffffff';
const EYE_DARK = '#1a1024';

/* ------------------------------------------------------------
   FACES - shared by brainrots and players so the whole cast
   reads as one family.
   ------------------------------------------------------------ */
export function faceParts(face = {}, frontZ = 0.34) {
  const {
    y = 0.08, spread = 0.2, size = 0.11, mouth = 'grin', mouthY = -0.16,
    bugEyes = false, shades = false, glowEyes = false, eye = 'round',
  } = face;
  const out = [];
  const z = frontZ;

  if (shades) {
    out.push(P('box', [0, y, z + 0.02], [spread + size * 1.5, size * 0.85, 0.05], '#141018', { round: 0.2 }));
    out.push(P('box', [0, y + 0.01, z + 0.06], [spread + size * 1.4, size * 0.6, 0.02], '#3a3550'));
    return out.concat(mouthParts(mouth, mouthY, z, size));
  }

  const ez = bugEyes ? z + size * 0.7 : z;
  const ey = bugEyes ? y + size * 0.6 : y;
  for (const sx of [-1, 1]) {
    const x = sx * spread;
    if (bugEyes) out.push(P('cyl', [x, ey - size * 0.7, ez - size * 0.4], [size * 0.4, size * 0.6, size * 0.4], '#4cc23a'));

    if (eye === 'angry') {
      out.push(P('sphere', [x, ey, ez], [size, size, size * 0.7], EYE_WHITE));
      out.push(P('sphere', [x, ey - size * 0.15, ez + size * 0.55], [size * 0.5, size * 0.5, size * 0.35], EYE_DARK));
      out.push(P('box', [x, ey + size * 0.85, ez + size * 0.3], [size * 1.1, size * 0.3, size * 0.2], EYE_DARK,
        { rot: [0, 0, sx * -0.55] }));
    } else if (eye === 'half') {
      out.push(P('sphere', [x, ey, ez], [size, size * 0.62, size * 0.7], EYE_WHITE));
      out.push(P('sphere', [x, ey - size * 0.1, ez + size * 0.5], [size * 0.45, size * 0.38, size * 0.3], EYE_DARK));
    } else if (eye === 'wide') {
      out.push(P('sphere', [x, ey, ez], [size * 1.25, size * 1.25, size * 0.8], EYE_WHITE));
      out.push(P('sphere', [x, ey, ez + size * 0.7], [size * 0.34, size * 0.34, size * 0.3], EYE_DARK));
    } else if (eye === 'derp') {
      const off = sx > 0 ? size * 0.28 : -size * 0.2;
      out.push(P('sphere', [x, ey + (sx > 0 ? 0.02 : -0.02), ez], [size * 1.1, size, size * 0.7], EYE_WHITE));
      out.push(P('sphere', [x + off, ey + off * 0.5, ez + size * 0.6], [size * 0.42, size * 0.42, size * 0.3], EYE_DARK));
    } else if (eye === 'spiral') {
      out.push(P('sphere', [x, ey, ez], [size, size, size * 0.7], EYE_WHITE));
      out.push(P('torus', [x, ey, ez + size * 0.5], [size * 0.62, size * 0.14, size * 0.62], EYE_DARK, { rot: [Math.PI / 2, 0, 0] }));
      out.push(P('torus', [x, ey, ez + size * 0.55], [size * 0.3, size * 0.12, size * 0.3], EYE_DARK, { rot: [Math.PI / 2, 0, 0] }));
    } else if (eye === 'laser') {
      out.push(P('sphere', [x, ey, ez], [size, size, size * 0.7], '#ff3b3b', { emissive: 0.85 }));
      out.push(P('cone', [x, ey, ez + size * 1.5], [size * 0.5, size * 1.4, size * 0.5],
        '#ff6a4d', { rot: [Math.PI / 2, 0, 0], emissive: 0.9, alpha: 0.55 }));
    } else if (eye === 'star') {
      out.push(P('sphere', [x, ey, ez], [size * 1.1, size * 1.1, size * 0.7], '#ffe88a', { emissive: 0.7 }));
      out.push(P('box', [x, ey, ez + size * 0.5], [size * 1.25, size * 0.24, size * 0.2], '#fff6c2', { emissive: 0.9 }));
      out.push(P('box', [x, ey, ez + size * 0.5], [size * 0.24, size * 1.25, size * 0.2], '#fff6c2', { emissive: 0.9 }));
    } else {
      // round (default)
      out.push(P('sphere', [x, ey, ez], [size, size * 1.05, size * 0.72], EYE_WHITE));
      out.push(P('sphere', [x + sx * size * 0.12, ey + size * 0.05, ez + size * 0.55],
        [size * 0.45, size * 0.45, size * 0.32], glowEyes ? '#7cf3ff' : EYE_DARK, { emissive: glowEyes ? 0.9 : 0 }));
    }
  }
  return out.concat(mouthParts(mouth, mouthY, z, size));
}

function mouthParts(kind, my, z, size) {
  const out = [];
  const s = size;
  switch (kind) {
    case 'grin':
      out.push(P('box', [0, my, z + 0.01], [s * 1.7, s * 0.5, 0.05], EYE_DARK, { round: 0.6 }));
      out.push(P('box', [0, my + s * 0.32, z + 0.04], [s * 1.35, s * 0.16, 0.03], '#ffffff'));
      break;
    case 'smirk':
      out.push(P('box', [s * 0.35, my, z + 0.01], [s * 1.0, s * 0.24, 0.05], EYE_DARK, { round: 0.6, rot: [0, 0, 0.28] }));
      break;
    case 'o':
      out.push(P('sphere', [0, my, z + 0.01], [s * 0.62, s * 0.72, 0.07], EYE_DARK));
      break;
    case 'derp':
      out.push(P('box', [-s * 0.25, my, z + 0.01], [s * 0.65, s * 0.2, 0.05], EYE_DARK, { round: 0.6, rot: [0, 0, 0.35] }));
      out.push(P('box', [s * 0.4, my - s * 0.18, z + 0.01], [s * 0.5, s * 0.2, 0.05], EYE_DARK, { round: 0.6, rot: [0, 0, -0.3] }));
      break;
    case 'fang':
      out.push(P('box', [0, my, z + 0.01], [s * 1.5, s * 0.6, 0.05], EYE_DARK, { round: 0.5 }));
      out.push(P('cone', [-s * 0.7, my - s * 0.3, z + 0.05], [s * 0.28, s * 0.5, s * 0.2], '#ffffff', { rot: [0, 0, Math.PI] }));
      out.push(P('cone', [s * 0.7, my - s * 0.3, z + 0.05], [s * 0.28, s * 0.5, s * 0.2], '#ffffff', { rot: [0, 0, Math.PI] }));
      break;
    case 'beak':
      out.push(P('cone', [0, my, z + s * 0.9], [s * 0.9, s * 1.1, s * 0.7], '#ff9f1f', { rot: [Math.PI / 2, 0, 0] }));
      break;
    default: break;
  }
  return out;
}

/* ------------------------------------------------------------
   BRAINROTS
   ------------------------------------------------------------ */
/* Meshes belong to a GL context, so every cache is keyed by context.
   The collection/customise screens use a second, offscreen renderer. */
const ctxCaches = new WeakMap();
function cacheFor(gl, name) {
  let m = ctxCaches.get(gl);
  if (!m) { m = {}; ctxCaches.set(gl, m); }
  if (!m[name]) m[name] = new Map();
  return m[name];
}

function frontZOf(def) {
  let z = 0.3;
  for (const p of def.parts) z = Math.max(z, (p.pos[2] || 0) + p.scale[2] * 0.78);
  return Math.min(Math.max(z, 0.24), 0.56);
}

export function brainrotMeshData(def, opts = {}) {
  const md = new MeshData();
  const tint = opts.tint || null;    // [r,g,b] multiplier, used by decoys / golden
  for (const part of def.parts) {
    const base = hex(part.color);
    addPart(md, part, null, tint ? mixc(base, tint, opts.tintAmount == null ? 0.85 : opts.tintAmount) : base);
  }
  if (!opts.noFace) {
    for (const part of faceParts(def.face, frontZOf(def))) {
      const base = hex(part.color);
      addPart(md, part, null, tint && opts.tintFace ? mixc(base, tint, 0.6) : base);
    }
  }
  return md;
}

export function getBrainrotMesh(gl, id, variant = '') {
  const cache = cacheFor(gl, 'brainrot');
  const key = id + '|' + variant;
  let m = cache.get(key);
  if (m) return m;
  const def = BRAINROT_BY_ID[id] || BRAINROT_BY_ID.banana;
  let opts = {};
  if (variant === 'golden') opts = { tint: hex('#ffd23f'), tintAmount: 0.78, tintFace: false };
  if (variant === 'decoy') opts = { tint: hex('#8a8aa8'), tintAmount: 0.72, tintFace: true };
  m = new Mesh(gl, brainrotMeshData(def, opts));
  cache.set(key, m);
  return m;
}

/* ------------------------------------------------------------
   PLAYERS
   ------------------------------------------------------------ */
const SHAPES = {
  blob:  { body: ['sphere', [0, 0, 0], [0.62, 0.56, 0.58]], headY: 0.5,  armY: 0.02, armX: 0.60, footX: 0.26, footY: -0.55, faceY: 0.10, faceZ: 0.44, hatY: 0.52 },
  tall:  { body: ['capsule', [0, 0.06, 0], [0.48, 0.76, 0.48]], headY: 0.62, armY: 0.14, armX: 0.50, footX: 0.22, footY: -0.72, faceY: 0.28, faceZ: 0.38, hatY: 0.76 },
  chonk: { body: ['sphere', [0, -0.02, 0], [0.78, 0.60, 0.72]], headY: 0.5, armY: 0.0,  armX: 0.76, footX: 0.34, footY: -0.56, faceY: 0.10, faceZ: 0.56, hatY: 0.56 },
  box:   { body: ['box', [0, 0, 0], [0.58, 0.58, 0.54]], headY: 0.52, armY: 0.06, armX: 0.60, footX: 0.28, footY: -0.60, faceY: 0.12, faceZ: 0.56, hatY: 0.58 },
};

export function playerMeshData(loadout, opts = {}) {
  const skin = findItem('skin', loadout.skin) || { body: '#ff3d8b', accent: '#ffd8e8', shape: 'blob' };
  const faceDef = findItem('face', loadout.face) || { eye: 'round', mouth: 'grin' };
  const hat = findItem('hat', loadout.hat) || { parts: [] };
  const S = SHAPES[skin.shape] || SHAPES.blob;

  const body = hex(opts.bodyColor || skin.body);
  const accent = hex(opts.accentColor || skin.accent);
  const dark = shade(body, 0.72);
  const flags = {};
  if (skin.metal) flags.metal = skin.metal;
  if (skin.emissive) flags.emissive = skin.emissive;
  if (skin.ghost) flags.alpha = 0.68;

  const parts = [];
  const [bShape, bPos, bScale] = S.body;
  parts.push(P(bShape, bPos, bScale, opts.bodyColor || skin.body, { round: bShape === 'box' ? 0.4 : 0, ...flags }));

  // belly patch keeps the front readable from the isometric camera
  parts.push(P('sphere', [0, S.faceY - 0.24, S.faceZ * 0.66], [bScale[0] * 0.56, bScale[1] * 0.42, bScale[2] * 0.5],
    opts.accentColor || skin.accent, { ...flags, alpha: flags.alpha }));

  // arms
  for (const sx of [-1, 1]) {
    parts.push(P('capsule', [sx * S.armX, S.armY, 0.02], [0.15, 0.30, 0.15], opts.bodyColor || skin.body,
      { rot: [0, 0, sx * -0.42], ...flags }));
    parts.push(P('sphere', [sx * (S.armX + 0.10), S.armY - 0.26, 0.04], [0.16, 0.15, 0.16],
      opts.accentColor || skin.accent, flags));
  }
  // feet
  for (const sx of [-1, 1]) {
    parts.push(P('sphere', [sx * S.footX, S.footY, 0.10], [0.21, 0.14, 0.27], shade(body, 0.78).map(clampc),
      flags));
  }

  const md = new MeshData();
  for (const part of parts) addPart(md, part);

  // face
  const fp = faceParts({
    y: S.faceY, spread: 0.20, size: 0.115, mouth: faceDef.mouth || 'grin',
    eye: faceDef.eye || 'round', mouthY: S.faceY - 0.24,
  }, S.faceZ);
  for (const part of fp) addPart(md, part);

  // hat
  for (const h of (hat.parts || [])) {
    const [shape, pos, scale, color, extra] = h;
    addPart(md, P(shape, [pos[0], pos[1] + S.hatY, pos[2]], scale, color, extra));
  }

  md.userAccent = accent;
  md.userBody = body;
  md.userDark = dark;
  md.shape = skin.shape;
  return md;
}
const clampc = (v) => Math.max(0, Math.min(1, v));

export function getPlayerMesh(gl, loadout, opts = {}) {
  const cache = cacheFor(gl, 'player');
  const key = JSON.stringify(loadout) + '|' + (opts.bodyColor || '') + (opts.accentColor || '');
  let m = cache.get(key);
  if (m) return m;
  const md = playerMeshData(loadout, opts);
  m = new Mesh(gl, md);
  m.accent = md.userAccent;
  m.body = md.userBody;
  m.shape = md.shape;
  cache.set(key, m);
  return m;
}

/** free a context's meshes - called when quality changes and geometry must be rebuilt */
export function disposeModelCaches(gl) {
  const m = ctxCaches.get(gl);
  if (!m) return;
  for (const name in m) {
    for (const mesh of m[name].values()) mesh.dispose();
    m[name].clear();
  }
  ctxCaches.delete(gl);
}

/* ------------------------------------------------------------
   Shared utility meshes
   ------------------------------------------------------------ */
function shared(gl, key, build) {
  const cache = cacheFor(gl, 'shared');
  let m = cache.get(key);
  if (!m) { m = build(); cache.set(key, m); }
  return m;
}

export function getShadowMesh(gl) {
  return shared(gl, 'shadow', () => {
    const md = new MeshData();
    addPart(md, P('disc', [0, 0, 0], [1, 1, 1], '#000000'));
    return new Mesh(gl, md);
  });
}

/** the chevron used for off-screen objective hints */
export function getArrowMesh(gl) {
  return shared(gl, 'arrow', () => {
    const md = new MeshData();
    addPart(md, P('cone', [0, 0, 0], [0.5, 0.7, 0.5], '#ffd23f', { rot: [Math.PI / 2, 0, 0], emissive: 0.6 }));
    return new Mesh(gl, md);
  });
}

export function getRingMesh(gl) {
  return shared(gl, 'ring', () => {
    const md = new MeshData();
    addPart(md, P('torus', [0, 0, 0], [1, 0.06, 1], '#ffffff', { emissive: 0.8 }));
    return new Mesh(gl, md);
  });
}

/* Ability orbs. The emblem inside each ring is a 3D read of the same icon on
   the HUD button - a boot for YEET KICK, a peel for BANANA, a crown for the
   MAGNET - so you can tell what an orb grants before you commit to walking
   to it. Colours are baked per part, so an orb is still one draw call. */
const ORB_RING = ['#ff5b5b', '#ffe14d', '#c07bff'];

const ORB_EMBLEM = [
  // 0 - YEET KICK: a booted leg, toe pointing forward
  () => [
    P('capsule', [-0.04, 0.24, 0], [0.18, 0.28, 0.18], '#ffd9b0'),
    P('box', [0.08, -0.26, 0], [0.24, 0.17, 0.2], '#c92f2f', { round: 0.06 }),
    P('box', [0.3, -0.35, 0], [0.19, 0.09, 0.19], '#ff6b6b', { round: 0.06 }),
  ],
  // 1 - BANANA: three segments swung into a crescent, with a stem
  () => [
    P('capsule', [-0.3, 0.06, 0], [0.13, 0.21, 0.13], '#ffe14d', { rot: [0, 0, 0.95] }),
    P('capsule', [0, -0.19, 0], [0.13, 0.23, 0.13], '#ffe14d', { rot: [0, 0, Math.PI / 2] }),
    P('capsule', [0.3, 0.06, 0], [0.13, 0.21, 0.13], '#ffe14d', { rot: [0, 0, -0.95] }),
    P('sphere', [-0.42, 0.26, 0], [0.1, 0.1, 0.1], '#6b4d12'),
    P('sphere', [0.42, 0.26, 0], [0.09, 0.09, 0.09], '#8a6a20'),
  ],
  // 2 - BRAINROT MAGNET: a crown, band plus five points
  () => {
    const parts = [P('cyl', [0, -0.22, 0], [0.4, 0.14, 0.4], '#c98f00')];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      parts.push(P('cone', [Math.cos(a) * 0.32, 0.1, Math.sin(a) * 0.32],
        [0.13, 0.26, 0.13], '#ffe14d'));
      parts.push(P('sphere', [Math.cos(a) * 0.32, 0.36, Math.sin(a) * 0.32],
        [0.07, 0.07, 0.07], '#fff3ad', { emissive: 0.5 }));
    }
    return parts;
  },
];

/**
 * One orb mesh per ability. Shell is a spinning ring in the ability's colour;
 * the emblem inside says which ability it is.
 */
export function getOrbMesh(gl, kind = 0) {
  const k = Math.max(0, Math.min(ORB_EMBLEM.length - 1, kind | 0));
  return shared(gl, 'orb' + k, () => {
    const md = new MeshData();
    const col = ORB_RING[k];
    addPart(md, P('torus', [0, 0, 0], [0.82, 0.09, 0.82], col, { emissive: 0.95 }));
    addPart(md, P('cone', [0, 0.8, 0], [0.2, 0.26, 0.2], col, { emissive: 0.85 }));
    addPart(md, P('cone', [0, -0.8, 0], [0.2, 0.26, 0.2], col,
      { emissive: 0.85, rot: [Math.PI, 0, 0] }));
    for (const part of ORB_EMBLEM[k]()) addPart(md, part);
    return new Mesh(gl, md);
  });
}

export function getBeamMesh(gl) {
  return shared(gl, 'beam', () => {
    const md = new MeshData();
    addPart(md, P('cyl', [0, 1, 0], [1, 1, 1], '#ffffff', { emissive: 0.9 }));
    return new Mesh(gl, md);
  });
}
