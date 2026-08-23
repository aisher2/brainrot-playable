/* ============================================================
   maps.js - the arena layouts.

   Every map is 180-degree symmetric. The two spawns sit at
   (0, +11) and (0, -11), so anything that favours one half of
   the arena favours one player. Keep that symmetry when adding
   to this list, and leave a ~2 unit bubble around both spawns
   clear of pillars.

   Pure data. arena.js copies the chosen entry into its live
   tables; which entry you get is derived from the match seed so
   both clients load the same arena without exchanging a byte.
   ============================================================ */

export const BASE_DIMS = {
  HALF: 20, WALL_H: 2.6,
  DAIS_R: 5.2, DAIS_H: 0.9,
  RAMP_END: 9.6, RAMP_HW: 2.7,
  ORB_R: 12.5, ORB_H: 1.45, ORB_PR: 2.35, ORB_W: 0.33, MOVERS: 2,
  PILLAR_R: 1.05, PILLAR_H: 2.7,
  PAD_R: 1.75, ZONE_R: 2.7,
};

export const BASE_COLORS = {
  tileA: '#5c3491', tileB: '#6b3fa4', tileEdge: '#7f4fbe',
  dais: '#f2c14e', daisSide: '#b8842a', daisRim: '#ffe08a',
  ramp: '#8a5ac2', rampEdge: '#a878e0',
  wall: '#3a1a5c', wallTop: '#ff3d8b', wallTop2: '#25d3ff',
  pillar: '#4a2a75', pillarTop: '#25d3ff',
  pad: '#4dff9b', padRim: '#0f7a45',
  zone: '#25d3ff',
  step: '#6f42a8', stepTop: '#8a5ac2',
  mover: '#ff8a1f', moverTop: '#ffc46b',
};

/** one block mirrored into all four quadrants, so symmetry is automatic */
const quad = (x, z, w, d, h) => [
  { x, z, w, d, h }, { x: -x, z, w, d, h }, { x, z: -z, w, d, h }, { x: -x, z: -z, w, d, h },
];
/** a pillar and its 180-degree twin */
const pair = (x, z, extra) => [{ x, z, ...extra }, { x: -x, z: -z, ...extra }];

export const MAPS = [
  {
    id: 'dais',
    name: 'NEON DAIS',
    blurb: 'the classic. ramps on every side.',
    dims: {},
    ramps: [0, Math.PI / 2, Math.PI, -Math.PI / 2],
    pillars: [
      ...pair(7.8, 7.8), ...pair(-7.8, 7.8),
      ...pair(15.5, 0, { r: 0.8, h: 2.2 }), ...pair(0, 15.5, { r: 0.8, h: 2.2 }),
    ],
    pads: [{ x: 10.6, z: 10.6 }, { x: -10.6, z: 10.6 }, { x: 10.6, z: -10.6 }, { x: -10.6, z: -10.6 }],
    zones: [{ x: 0, z: 16.2 }, { x: 0, z: -16.2 }, { x: 16.2, z: 0 }, { x: -16.2, z: 0 }],
    steps: [...quad(14.5, 7.5, 2.4, 2.4, 0.55), ...quad(7.5, 14.5, 2.4, 2.4, 0.55)],
    colors: {},
  },

  {
    id: 'spire',
    name: 'THE SPIRE',
    blurb: 'tall pedestal, ramps only on one axis.',
    // Tight and vertical. With ramps only east-west, the quick way up is a
    // bounce pad or a dash, which keeps the middle contested.
    dims: {
      HALF: 17.5, WALL_H: 2.9, DAIS_R: 3.8, DAIS_H: 1.75, RAMP_END: 8.8, RAMP_HW: 2.3,
      ORB_R: 10.6, ORB_H: 2.0, ORB_PR: 2.1, ORB_W: 0.44, MOVERS: 2, PILLAR_H: 3.1,
    },
    ramps: [0, Math.PI],
    pillars: [
      ...pair(6.4, 6.0), ...pair(-6.4, 6.0),
      ...pair(13.4, 4.6, { r: 0.85, h: 2.4 }), ...pair(-13.4, 4.6, { r: 0.85, h: 2.4 }),
    ],
    pads: [{ x: 5.6, z: 0 }, { x: -5.6, z: 0 }, { x: 0, z: 13.6 }, { x: 0, z: -13.6 }],
    zones: [{ x: 14.2, z: 0 }, { x: -14.2, z: 0 }],
    steps: [...quad(10.4, 10.4, 2.0, 2.0, 0.7)],
    colors: {
      tileA: '#2c3f6b', tileB: '#35497a', dais: '#7ef0ff', daisSide: '#1c6a86', daisRim: '#c9f7ff',
      ramp: '#3f5c96', rampEdge: '#6f92d8', wall: '#16233f', wallTop: '#7ef0ff', wallTop2: '#a06bff',
      pillar: '#27385e', pillarTop: '#7ef0ff', step: '#33497a', stepTop: '#4a67a5',
    },
  },

  {
    id: 'bowl',
    name: 'BUMPER BOWL',
    blurb: 'no platforms, barely any cover, eight pads.',
    dims: {
      HALF: 15.5, WALL_H: 2.4, DAIS_R: 4.6, DAIS_H: 0.4, RAMP_END: 8.2, RAMP_HW: 3.0,
      MOVERS: 0, PAD_R: 1.9, ZONE_R: 2.4, PILLAR_H: 2.3,
    },
    ramps: [0, Math.PI / 2, Math.PI, -Math.PI / 2],
    pillars: [...pair(8.2, 0, { r: 1.15 })],
    pads: [
      { x: 7.0, z: 7.0 }, { x: -7.0, z: 7.0 }, { x: 7.0, z: -7.0 }, { x: -7.0, z: -7.0 },
      ...pair(12.4, 3.4), ...pair(-12.4, 3.4),
    ],
    zones: [{ x: 0, z: 12.6 }, { x: 0, z: -12.6 }, { x: 12.6, z: 0 }, { x: -12.6, z: 0 }],
    steps: [],
    colors: {
      tileA: '#6b2f4a', tileB: '#7d3757', dais: '#ffb03f', daisSide: '#a85f14', daisRim: '#ffd98a',
      ramp: '#9c4468', rampEdge: '#d06e93', wall: '#4a1730', wallTop: '#ffb03f', wallTop2: '#4dff9b',
      pillar: '#5e2440', pillarTop: '#ffb03f', pad: '#ffe14d', padRim: '#8a6a00',
    },
  },

  {
    id: 'yard',
    name: 'THE LONG YARD',
    blurb: 'wide and open, four slow platforms.',
    // Ramps sit on the diagonals so both spawn lanes run straight at the dais.
    dims: {
      HALF: 24, WALL_H: 3.0, DAIS_R: 6.4, DAIS_H: 1.15, RAMP_END: 11.4, RAMP_HW: 2.9,
      ORB_R: 17, ORB_H: 1.6, ORB_PR: 2.6, ORB_W: 0.22, MOVERS: 4, PILLAR_H: 2.9,
    },
    ramps: [Math.PI / 4, 3 * Math.PI / 4, -3 * Math.PI / 4, -Math.PI / 4],
    pillars: [
      ...pair(9.5, 3.2), ...pair(-9.5, 3.2),
      ...pair(19.5, 8.5, { r: 0.9, h: 2.5 }), ...pair(-19.5, 8.5, { r: 0.9, h: 2.5 }),
      ...pair(0, 19.5, { r: 0.95, h: 2.6 }),
    ],
    pads: [{ x: 14.5, z: 14.5 }, { x: -14.5, z: 14.5 }, { x: 14.5, z: -14.5 }, { x: -14.5, z: -14.5 }],
    zones: [{ x: 20.5, z: 0 }, { x: -20.5, z: 0 }],
    steps: [...quad(15.5, 4.0, 3.2, 1.6, 0.6), ...quad(5.0, 16.5, 1.6, 3.2, 0.6)],
    colors: {
      tileA: '#2f5c3a', tileB: '#376b45', dais: '#ffe14d', daisSide: '#a8880f', daisRim: '#fff3ad',
      ramp: '#3f7a52', rampEdge: '#63b07c', wall: '#1b3a25', wallTop: '#ffe14d', wallTop2: '#ff6bd6',
      pillar: '#28513a', pillarTop: '#9dffc4', step: '#38684a', stepTop: '#4d8a63',
      mover: '#ff6bd6', moverTop: '#ffb3e8',
    },
  },

  {
    id: 'carousel',
    name: 'CAROUSEL',
    blurb: 'six ramps and four fast platforms.',
    dims: {
      HALF: 19, WALL_H: 2.7, DAIS_R: 4.4, DAIS_H: 1.0, RAMP_END: 9.2, RAMP_HW: 2.1,
      ORB_R: 13, ORB_H: 1.5, ORB_PR: 2.2, ORB_W: 0.62, MOVERS: 4, PILLAR_R: 0.95, PILLAR_H: 2.8,
    },
    ramps: [0, Math.PI / 3, 2 * Math.PI / 3, Math.PI, -2 * Math.PI / 3, -Math.PI / 3],
    pillars: [
      ...pair(11.2, 0), ...pair(5.6, 9.7), ...pair(-5.6, 9.7),
      ...pair(16.4, 4.4, { r: 0.8, h: 2.3 }), ...pair(-16.4, 4.4, { r: 0.8, h: 2.3 }),
    ],
    pads: [...pair(8.4, 4.9), ...pair(-8.4, 4.9)],
    zones: [{ x: 0, z: 15.4 }, { x: 0, z: -15.4 }, { x: 15.4, z: 0 }, { x: -15.4, z: 0 }],
    steps: [...quad(12.6, 12.6, 2.2, 2.2, 0.5)],
    colors: {
      tileA: '#4a2f6b', tileB: '#5a3a80', dais: '#ff8a3d', daisSide: '#a34d0f', daisRim: '#ffc79a',
      ramp: '#7a4aa8', rampEdge: '#a578d8', wall: '#2a1445', wallTop: '#ff8a3d', wallTop2: '#3dffd0',
      pillar: '#3e2566', pillarTop: '#3dffd0', step: '#5c3a88', stepTop: '#7a52ad',
      mover: '#3dffd0', moverTop: '#b0fff0',
    },
  },
];

/**
 * Which arena a match plays on, derived from the match seed. Both clients run
 * this on the same seed and get the same answer, so the map never needs to be
 * sent over the wire. Mixed separately from the brainrot pick so the two do
 * not correlate.
 */
export function mapForSeed(seed) {
  let h = (seed >>> 0) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  h = (h ^ (h >>> 16)) >>> 0;
  return h % MAPS.length;
}
