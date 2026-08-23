/* ============================================================
   brainrots.js - the collectible cast.

   Every character is 100% original and described as a *recipe*
   of primitive shapes, so the whole cast costs a few kB instead
   of a few MB of downloaded meshes. gfx/models.js turns a recipe
   into a baked mesh; core/audio.js turns `sfx` into a synthesized
   pickup sound. Nothing here is copied from an existing game.

   Authoring space: roughly a 1.4-unit cube centred on the origin.
   y = 0 is the middle of the creature.
   ============================================================ */

/** part helper: p(shape, [x,y,z], [sx,sy,sz]|s, color, extra) */
const p = (shape, pos, scale, color, extra) => ({
  shape,
  pos,
  scale: typeof scale === 'number' ? [scale, scale, scale] : scale,
  color,
  ...(extra || {}),
});

export const RARITY = {
  common:    { name: 'COMMON',    color: '#b9b9c9', weight: 100, coins: 15,  xp: 5  },
  uncommon:  { name: 'UNCOMMON',  color: '#4dff9b', weight: 55,  coins: 30,  xp: 10 },
  rare:      { name: 'RARE',      color: '#25d3ff', weight: 26,  coins: 60,  xp: 20 },
  epic:      { name: 'EPIC',      color: '#c07bff', weight: 11,  coins: 130, xp: 40 },
  legendary: { name: 'LEGENDARY', color: '#ffd23f', weight: 4,   coins: 300, xp: 90 },
  mythic:    { name: 'MYTHIC',    color: '#ff3d8b', weight: 1,   coins: 750, xp: 200 },
};
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/* ------------------------------------------------------------
   THE CAST
   idle:   bob | spin | wobble | jiggle | pulse | flap | shiver | swim
   pickup: squash | spinflip | pop | stretch | tumble
   face:   eye size/spread/height + a mouth shape
   sfx:    tiny synth patch (see core/audio.js -> playBrainrotSfx)
   ------------------------------------------------------------ */
export const BRAINROTS = [

  { id:'banana', name:'Bananinho Sigmatron', rarity:'common', idle:'wobble', pickup:'squash',
    blurb:'A banana that peels itself for the drip.',
    face:{ y:0.10, spread:0.20, size:0.115, mouth:'grin', mouthY:-0.13 },
    sfx:{ wave:'square', f0:180, f1:820, dur:0.26, warble:14, noise:0.05 },
    parts:[
      p('capsule',[0,0,0],[0.34,0.62,0.34],'#ffe14d',{ bend:0.42 }),
      p('cone',[0,0.60,0],[0.14,0.18,0.14],'#5c4a12'),
      p('capsule',[0.30,0.24,0.06],[0.09,0.34,0.09],'#ffd21f',{ rot:[0,0,-0.9] }),
      p('capsule',[-0.30,0.24,0.06],[0.09,0.34,0.09],'#ffd21f',{ rot:[0,0,0.9] }),
      p('cyl',[0.18,-0.52,0],[0.11,0.10,0.11],'#8b5a2b'),
      p('cyl',[-0.18,-0.52,0],[0.11,0.10,0.11],'#8b5a2b'),
    ]},

  { id:'chicken', name:'Clucky Bombastico', rarity:'common', idle:'flap', pickup:'pop',
    blurb:'Lays eggs of pure confusion. Cannot be reasoned with.',
    face:{ y:0.14, spread:0.19, size:0.10, mouth:'beak', mouthY:-0.02 },
    sfx:{ wave:'sawtooth', f0:620, f1:240, dur:0.3, warble:26, noise:0.12 },
    parts:[
      p('sphere',[0,-0.10,0],[0.44,0.40,0.42],'#fffbf0'),
      p('sphere',[0,0.28,0.02],[0.29,0.28,0.29],'#fffbf0'),
      p('box',[0,0.52,0.02],[0.08,0.12,0.16],'#ff4646',{ rot:[0.2,0,0] }),
      p('box',[0,0.46,-0.02],[0.06,0.10,0.13],'#ff4646',{ rot:[-0.3,0,0] }),
      p('sphere',[0.06,0.14,0.20],[0.09,0.07,0.05],'#ff4646'),
      p('capsule',[0.44,-0.08,0],[0.07,0.26,0.16],'#f2ebdc',{ rot:[0,0,-0.5] }),
      p('capsule',[-0.44,-0.08,0],[0.07,0.26,0.16],'#f2ebdc',{ rot:[0,0,0.5] }),
      p('cyl',[0.14,-0.50,0],[0.045,0.14,0.045],'#ffa41f'),
      p('cyl',[-0.14,-0.50,0],[0.045,0.14,0.045],'#ffa41f'),
    ]},

  { id:'toilet', name:'Flushmaster Porcelano', rarity:'uncommon', idle:'shiver', pickup:'spinflip',
    blurb:'Undefeated in the porcelain leagues. Smells like victory (allegedly).',
    face:{ y:0.06, spread:0.17, size:0.105, mouth:'derp', mouthY:-0.16 },
    sfx:{ wave:'sine', f0:900, f1:120, dur:0.44, warble:5, noise:0.35, gurgle:true },
    parts:[
      p('box',[0,-0.34,0],[0.30,0.28,0.30],'#ecf4f8'),
      p('cyl',[0,0.02,0.02],[0.36,0.16,0.30],'#f7fcff'),
      p('torus',[0,0.14,0.02],[0.36,0.09,0.31],'#ffffff'),
      p('box',[0,0.14,-0.34],[0.30,0.34,0.09],'#e3edf3'),
      p('box',[0.28,0.36,-0.30],[0.09,0.04,0.05],'#9fb6c4'),
      p('cyl',[0,0.06,0.03],[0.26,0.05,0.22],'#7fd4ff',{ emissive:0.25 }),
    ]},

  { id:'potato', name:'Spudrick Von Mash', rarity:'common', idle:'jiggle', pickup:'squash',
    blurb:'Eyes everywhere. Judging you. Constantly.',
    face:{ y:0.05, spread:0.22, size:0.13, mouth:'smirk', mouthY:-0.18 },
    sfx:{ wave:'triangle', f0:140, f1:300, dur:0.22, warble:8, noise:0.22 },
    parts:[
      p('sphere',[0,0,0],[0.50,0.40,0.42],'#c08a4e'),
      p('sphere',[0.24,0.16,0.20],[0.10,0.09,0.08],'#a9743d'),
      p('sphere',[-0.28,-0.14,0.12],[0.09,0.08,0.07],'#a9743d'),
      p('sphere',[0.10,-0.24,-0.16],[0.11,0.09,0.09],'#a9743d'),
      p('cyl',[0.16,-0.40,0],[0.06,0.09,0.06],'#7a5227'),
      p('cyl',[-0.16,-0.40,0],[0.06,0.09,0.06],'#7a5227'),
    ]},

  { id:'sigma', name:'Sigmaximus Jawlini', rarity:'rare', idle:'pulse', pickup:'stretch',
    blurb:'Wakes at 4am to grind. Does not know what the grind is.',
    face:{ y:0.10, spread:0.19, size:0.10, mouth:'smirk', mouthY:-0.20, shades:true },
    sfx:{ wave:'sawtooth', f0:70, f1:170, dur:0.5, warble:2, noise:0.02, sub:true },
    parts:[
      p('box',[0,0.02,0],[0.36,0.44,0.32],'#e8b48c',{ round:0.4 }),
      p('box',[0,-0.34,0],[0.40,0.16,0.34],'#d99f74',{ round:0.5 }),
      p('box',[0,0.42,-0.02],[0.38,0.14,0.34],'#2b1c14',{ round:0.4 }),
      p('box',[0,0.28,0.30],[0.34,0.09,0.06],'#2b1c14'),
      p('cyl',[0.40,0.02,0],[0.09,0.20,0.09],'#e8b48c',{ rot:[0,0,0.15] }),
      p('cyl',[-0.40,0.02,0],[0.09,0.20,0.09],'#e8b48c',{ rot:[0,0,-0.15] }),
    ]},

  { id:'fish', name:'Gilberto Fishtacular', rarity:'common', idle:'swim', pickup:'tumble',
    blurb:'Out of water since 2019 and thriving.',
    face:{ y:0.10, spread:0.24, size:0.13, mouth:'o', mouthY:-0.10 },
    sfx:{ wave:'sine', f0:400, f1:1100, dur:0.2, warble:30, noise:0.18, gurgle:true },
    parts:[
      p('sphere',[0,0,0.04],[0.46,0.34,0.30],'#3fb9e8'),
      p('cone',[0,0,-0.48],[0.22,0.30,0.20],'#2a93bd',{ rot:[0,0,Math.PI/2] }),
      p('box',[0,0.34,-0.06],[0.05,0.18,0.22],'#2a93bd',{ rot:[0.3,0,0] }),
      p('box',[0.36,-0.06,0],[0.16,0.04,0.16],'#7fd6f5',{ rot:[0,0,-0.4] }),
      p('box',[-0.36,-0.06,0],[0.16,0.04,0.16],'#7fd6f5',{ rot:[0,0,0.4] }),
      p('sphere',[0,-0.12,0.30],[0.22,0.14,0.12],'#ffe9b8'),
    ]},

  { id:'pizza', name:'Pepperoni Slabbington', rarity:'uncommon', idle:'spin', pickup:'spinflip',
    blurb:'A slice with a personality disorder and 400% cheese pull.',
    face:{ y:0.02, spread:0.18, size:0.11, mouth:'grin', mouthY:-0.20 },
    sfx:{ wave:'square', f0:300, f1:640, dur:0.24, warble:11, noise:0.2 },
    parts:[
      p('wedge',[0,0,0],[0.62,0.10,0.66],'#ffcc55'),
      p('wedge',[0,0.07,0],[0.56,0.06,0.60],'#ffe08a'),
      p('cyl',[0.13,0.13,0.06],[0.11,0.03,0.11],'#e0402f'),
      p('cyl',[-0.14,0.13,-0.10],[0.10,0.03,0.10],'#e0402f'),
      p('cyl',[0.02,0.13,-0.26],[0.09,0.03,0.09],'#e0402f'),
      p('box',[0,0.0,0.40],[0.60,0.14,0.10],'#d9974a',{ round:0.5 }),
    ]},

  { id:'rat', name:'Sewerio Squeakwald', rarity:'uncommon', idle:'shiver', pickup:'pop',
    blurb:'Owns three sewers and a small cheese empire.',
    face:{ y:0.06, spread:0.16, size:0.095, mouth:'fang', mouthY:-0.12 },
    sfx:{ wave:'square', f0:1200, f1:1900, dur:0.16, warble:40, noise:0.1 },
    parts:[
      p('sphere',[0,-0.06,-0.06],[0.36,0.30,0.42],'#8e8ea3'),
      p('sphere',[0,0.02,0.30],[0.24,0.22,0.26],'#9b9bb0'),
      p('cone',[0,0.0,0.52],[0.09,0.10,0.09],'#ffb6c8',{ rot:[Math.PI/2,0,0] }),
      p('cyl',[0.22,0.26,0.14],[0.14,0.03,0.14],'#ffb6c8',{ rot:[Math.PI/2,0,0.2] }),
      p('cyl',[-0.22,0.26,0.14],[0.14,0.03,0.14],'#ffb6c8',{ rot:[Math.PI/2,0,-0.2] }),
      p('capsule',[0,-0.16,-0.52],[0.045,0.26,0.045],'#ffb6c8',{ rot:[1.2,0,0] }),
    ]},

  { id:'frog', name:'Croakzilla Ribbitron', rarity:'uncommon', idle:'bob', pickup:'squash',
    blurb:'Ribbits in three octaves. Believes he is the main character.',
    face:{ y:0.22, spread:0.26, size:0.155, mouth:'grin', mouthY:-0.06, bugEyes:true },
    sfx:{ wave:'sawtooth', f0:130, f1:320, dur:0.3, warble:20, noise:0.14, gurgle:true },
    parts:[
      p('sphere',[0,-0.06,0],[0.46,0.34,0.42],'#5ed94a'),
      p('sphere',[0,-0.16,0.24],[0.34,0.20,0.24],'#c9f5a0'),
      p('capsule',[0.40,-0.28,0.10],[0.09,0.20,0.09],'#4cc23a',{ rot:[0,0,-1.1] }),
      p('capsule',[-0.40,-0.28,0.10],[0.09,0.20,0.09],'#4cc23a',{ rot:[0,0,1.1] }),
      p('sphere',[0.44,-0.38,0.24],[0.13,0.06,0.14],'#4cc23a'),
      p('sphere',[-0.44,-0.38,0.24],[0.13,0.06,0.14],'#4cc23a'),
    ]},

  { id:'gigachad', name:'Chadicus Maximus Pump', rarity:'epic', idle:'pulse', pickup:'stretch',
    blurb:'Bench presses the concept of Tuesday.',
    face:{ y:0.26, spread:0.16, size:0.085, mouth:'smirk', mouthY:-0.02 },
    sfx:{ wave:'sawtooth', f0:60, f1:210, dur:0.55, warble:3, noise:0.06, sub:true },
    parts:[
      p('box',[0,-0.10,0],[0.56,0.34,0.30],'#f0bd94',{ round:0.45 }),
      p('sphere',[0.30,0.06,0.08],[0.20,0.16,0.16],'#f7cba6'),
      p('sphere',[-0.30,0.06,0.08],[0.20,0.16,0.16],'#f7cba6'),
      p('box',[0,0.32,0],[0.24,0.14,0.22],'#e8ab80',{ round:0.4 }),
      p('box',[0,0.52,0],[0.26,0.28,0.26],'#f0bd94',{ round:0.42 }),
      p('box',[0,0.70,-0.02],[0.27,0.12,0.26],'#3a2a1c',{ round:0.4 }),
      p('capsule',[0.56,-0.16,0],[0.11,0.24,0.11],'#f0bd94',{ rot:[0,0,0.35] }),
      p('capsule',[-0.56,-0.16,0],[0.11,0.24,0.11],'#f0bd94',{ rot:[0,0,-0.35] }),
    ]},

  { id:'nuclear', name:'Fissionaldo Glowsplat', rarity:'epic', idle:'pulse', pickup:'pop',
    blurb:'Legally not allowed within 40m of a school. Or a banana.',
    face:{ y:0.06, spread:0.20, size:0.115, mouth:'fang', mouthY:-0.18 },
    sfx:{ wave:'square', f0:90, f1:1500, dur:0.42, warble:60, noise:0.4 },
    parts:[
      p('cyl',[0,-0.30,0],[0.34,0.14,0.34],'#3b4756'),
      p('cyl',[0,0.0,0],[0.40,0.26,0.40],'#f7e34a',{ emissive:0.35 }),
      p('torus',[0,0.06,0],[0.44,0.07,0.44],'#2b3440'),
      p('cyl',[0,0.30,0],[0.20,0.10,0.20],'#3b4756'),
      p('cone',[0,0.48,0],[0.16,0.18,0.16],'#7cff5c',{ emissive:0.6 }),
      p('box',[0.30,0.02,0.30],[0.06,0.20,0.06],'#7cff5c',{ emissive:0.5, rot:[0,0.8,0.3] }),
      p('box',[-0.30,0.02,0.30],[0.06,0.20,0.06],'#7cff5c',{ emissive:0.5, rot:[0,-0.8,-0.3] }),
    ]},

  { id:'golden', name:'Aurelio Goldenbrain', rarity:'legendary', idle:'spin', pickup:'spinflip',
    blurb:'Worth exactly 2x. Knows it. Insufferable about it.',
    face:{ y:0.06, spread:0.20, size:0.11, mouth:'grin', mouthY:-0.16 },
    sfx:{ wave:'sine', f0:660, f1:1980, dur:0.5, warble:0, noise:0, chord:[1,1.25,1.5,2] },
    parts:[
      p('sphere',[0,0.04,0],[0.44,0.40,0.42],'#ffd23f',{ metal:0.9 }),
      p('sphere',[0.18,0.24,0.16],[0.17,0.15,0.16],'#ffe888',{ metal:0.9 }),
      p('sphere',[-0.18,0.24,0.16],[0.17,0.15,0.16],'#ffe888',{ metal:0.9 }),
      p('sphere',[0,0.26,-0.20],[0.20,0.17,0.17],'#ffe888',{ metal:0.9 }),
      p('torus',[0,0.44,0],[0.26,0.05,0.26],'#fff3b0',{ emissive:0.5 }),
      p('cyl',[0,-0.38,0],[0.24,0.10,0.24],'#c98f00',{ metal:0.8 }),
    ]},

  { id:'galaxy', name:'Nebulon Cosmobrain', rarity:'legendary', idle:'spin', pickup:'stretch',
    blurb:'Contains at least four galaxies and one unpaid parking ticket.',
    face:{ y:0.06, spread:0.21, size:0.115, mouth:'o', mouthY:-0.18, glowEyes:true },
    sfx:{ wave:'sine', f0:220, f1:1400, dur:0.62, warble:6, noise:0.06, chord:[1,1.5,2.25] },
    parts:[
      p('sphere',[0,0,0],[0.44,0.44,0.44],'#2a1152',{ emissive:0.25 }),
      p('sphere',[0.20,0.18,0.22],[0.12,0.12,0.12],'#a45cff',{ emissive:0.7 }),
      p('sphere',[-0.24,-0.10,0.18],[0.08,0.08,0.08],'#5cc8ff',{ emissive:0.7 }),
      p('sphere',[0.10,-0.26,-0.22],[0.10,0.10,0.10],'#ff6fd8',{ emissive:0.7 }),
      p('torus',[0,0.02,0],[0.66,0.035,0.66],'#c89bff',{ rot:[0.45,0,0.25], emissive:0.4 }),
      p('torus',[0,0.02,0],[0.56,0.025,0.56],'#7fe3ff',{ rot:[-0.3,0.6,0.4], emissive:0.4 }),
    ]},

  { id:'king', name:'Regulus Brainicus Rex', rarity:'epic', idle:'bob', pickup:'stretch',
    blurb:'Rules a kingdom of exactly one (1) beanbag chair.',
    face:{ y:0.04, spread:0.20, size:0.11, mouth:'smirk', mouthY:-0.18 },
    sfx:{ wave:'square', f0:392, f1:784, dur:0.45, warble:0, noise:0, chord:[1,1.26,1.5] },
    parts:[
      p('sphere',[0,-0.02,0],[0.42,0.40,0.40],'#ff9ec4'),
      p('sphere',[0.17,0.16,0.18],[0.16,0.15,0.15],'#ffb9d6'),
      p('sphere',[-0.17,0.16,0.18],[0.16,0.15,0.15],'#ffb9d6'),
      p('cyl',[0,0.44,0],[0.30,0.14,0.30],'#ffd23f',{ metal:0.7 }),
      p('cone',[0,0.60,0],[0.07,0.14,0.07],'#ffd23f',{ metal:0.7 }),
      p('cone',[0.19,0.58,0.05],[0.06,0.11,0.06],'#ffd23f',{ metal:0.7 }),
      p('cone',[-0.19,0.58,0.05],[0.06,0.11,0.06],'#ffd23f',{ metal:0.7 }),
      p('sphere',[0,0.72,0],[0.06,0.06,0.06],'#ff3d8b',{ emissive:0.5 }),
    ]},

  { id:'sock', name:'Sockrates Footwarm', rarity:'common', idle:'wobble', pickup:'tumble',
    blurb:'The one that vanished in the dryer. It has seen things.',
    face:{ y:0.14, spread:0.16, size:0.10, mouth:'derp', mouthY:-0.04 },
    sfx:{ wave:'triangle', f0:220, f1:110, dur:0.28, warble:9, noise:0.3 },
    parts:[
      p('capsule',[0,0.10,0],[0.24,0.40,0.24],'#f4f1ff'),
      p('box',[0,-0.34,0.16],[0.24,0.16,0.40],'#f4f1ff',{ round:0.5 }),
      p('cyl',[0,0.44,0],[0.26,0.08,0.26],'#ff5b8f'),
      p('cyl',[0,0.30,0],[0.255,0.05,0.255],'#5cc8ff'),
    ]},

  { id:'blender', name:'Blenderino Smoothini', rarity:'uncommon', idle:'shiver', pickup:'spinflip',
    blurb:'Screams at 30,000 RPM. Contents unknowable.',
    face:{ y:0.10, spread:0.18, size:0.10, mouth:'o', mouthY:-0.12 },
    sfx:{ wave:'sawtooth', f0:110, f1:900, dur:0.4, warble:70, noise:0.45 },
    parts:[
      p('box',[0,-0.38,0],[0.30,0.16,0.30],'#37414f',{ round:0.35 }),
      p('cyl',[0,0.02,0],[0.30,0.38,0.30],'#bfe6ff',{ alpha:0.85 }),
      p('cyl',[0,-0.12,0],[0.27,0.18,0.27],'#8bd35c'),
      p('cyl',[0,0.42,0],[0.32,0.06,0.32],'#37414f'),
      p('box',[0.32,-0.30,0],[0.06,0.08,0.05],'#ff5b5b'),
      p('box',[0,-0.10,0],[0.22,0.02,0.06],'#d9e5ef',{ rot:[0,0.6,0] }),
    ]},

  { id:'cookie', name:'Captain Crumbsworth', rarity:'common', idle:'jiggle', pickup:'squash',
    blurb:'Missing one bite. Refuses to say who took it.',
    face:{ y:0.02, spread:0.19, size:0.11, mouth:'grin', mouthY:-0.20 },
    sfx:{ wave:'triangle', f0:520, f1:260, dur:0.2, warble:6, noise:0.35 },
    parts:[
      p('cyl',[0,0,0],[0.48,0.13,0.48],'#d99a52'),
      p('sphere',[0.18,0.10,0.16],[0.08,0.06,0.08],'#4a2c14'),
      p('sphere',[-0.20,0.10,-0.08],[0.07,0.05,0.07],'#4a2c14'),
      p('sphere',[0.04,0.10,-0.28],[0.075,0.055,0.075],'#4a2c14'),
      p('sphere',[0.44,0.02,0.24],[0.16,0.18,0.16],'#1a0a22'),
    ]},

  { id:'wifi', name:'Wifi Signalorio', rarity:'rare', idle:'pulse', pickup:'pop',
    blurb:'Two bars of pure menace. Buffers your soul.',
    face:{ y:-0.06, spread:0.17, size:0.10, mouth:'derp', mouthY:-0.26 },
    sfx:{ wave:'square', f0:1400, f1:400, dur:0.3, warble:0, noise:0.05, chord:[1,2,3] },
    parts:[
      p('box',[0,-0.24,0],[0.40,0.20,0.26],'#20252e',{ round:0.35 }),
      p('sphere',[0,-0.24,0.26],[0.05,0.05,0.03],'#4dff9b',{ emissive:0.8 }),
      p('sphere',[0.12,-0.24,0.26],[0.05,0.05,0.03],'#ffd23f',{ emissive:0.8 }),
      p('torus',[0,0.06,0],[0.20,0.035,0.20],'#5cc8ff',{ rot:[Math.PI/2,0,0], arc:0.5, emissive:0.6 }),
      p('torus',[0,0.06,0],[0.34,0.035,0.34],'#5cc8ff',{ rot:[Math.PI/2,0,0], arc:0.5, emissive:0.5 }),
      p('torus',[0,0.06,0],[0.48,0.035,0.48],'#5cc8ff',{ rot:[Math.PI/2,0,0], arc:0.5, emissive:0.4 }),
    ]},

  { id:'cactus', name:'Cactusio Prickelini', rarity:'uncommon', idle:'wobble', pickup:'stretch',
    blurb:'Hugs are strictly one-way.',
    face:{ y:0.08, spread:0.16, size:0.10, mouth:'smirk', mouthY:-0.12 },
    sfx:{ wave:'sawtooth', f0:300, f1:700, dur:0.22, warble:18, noise:0.3 },
    parts:[
      p('capsule',[0,0,0],[0.26,0.44,0.26],'#4fae54'),
      p('capsule',[0.30,0.08,0],[0.10,0.20,0.10],'#4fae54',{ rot:[0,0,-1.35] }),
      p('capsule',[0.36,0.26,0],[0.10,0.14,0.10],'#4fae54'),
      p('capsule',[-0.28,-0.06,0],[0.09,0.16,0.09],'#4fae54',{ rot:[0,0,1.35] }),
      p('capsule',[-0.33,0.08,0],[0.09,0.12,0.09],'#4fae54'),
      p('cyl',[0,-0.50,0],[0.30,0.12,0.30],'#c1663f'),
      p('sphere',[0,0.50,0],[0.11,0.09,0.11],'#ff5b8f'),
    ]},

  { id:'microwave', name:'Microwaverio Beepbeep', rarity:'rare', idle:'shiver', pickup:'pop',
    blurb:'Thirty seconds left, forever.',
    face:{ y:0.04, spread:0.20, size:0.11, mouth:'grin', mouthY:-0.16, insideBox:true },
    sfx:{ wave:'square', f0:880, f1:880, dur:0.42, warble:0, noise:0, beeps:3 },
    parts:[
      p('box',[0,0,0],[0.52,0.36,0.36],'#cfd8e3',{ round:0.2 }),
      p('box',[-0.06,0,0.36],[0.34,0.28,0.03],'#2b3440',{ alpha:0.75 }),
      p('box',[0.36,0.10,0.36],[0.12,0.10,0.02],'#ff5b5b',{ emissive:0.6 }),
      p('cyl',[0.36,-0.12,0.37],[0.06,0.02,0.06],'#8a97a6',{ rot:[Math.PI/2,0,0] }),
      p('box',[0,-0.40,0],[0.46,0.06,0.32],'#9fadbc'),
    ]},

  { id:'trash', name:'Trashcanto Lidmaster', rarity:'common', idle:'bob', pickup:'tumble',
    blurb:'One man’s garbage is this guy’s entire identity.',
    face:{ y:0.0, spread:0.19, size:0.11, mouth:'fang', mouthY:-0.18 },
    sfx:{ wave:'sawtooth', f0:160, f1:80, dur:0.32, warble:12, noise:0.55 },
    parts:[
      p('cyl',[0,-0.10,0],[0.38,0.42,0.38],'#5c8f6a'),
      p('torus',[0,0.20,0],[0.40,0.045,0.40],'#3f6b4c'),
      p('torus',[0,-0.20,0],[0.395,0.045,0.395],'#3f6b4c'),
      p('cyl',[0,0.36,0],[0.44,0.07,0.44],'#4a7a58',{ rot:[0.16,0,0.1] }),
      p('torus',[0,0.46,0],[0.12,0.03,0.12],'#3f6b4c',{ rot:[0.16,0,0.1] }),
      p('sphere',[0.16,0.44,0.20],[0.10,0.09,0.09],'#ffd23f'),
    ]},

  { id:'octopus', name:'Octopunch Tentaclini', rarity:'rare', idle:'swim', pickup:'squash',
    blurb:'Eight arms, zero impulse control.',
    face:{ y:0.12, spread:0.22, size:0.13, mouth:'o', mouthY:-0.08 },
    sfx:{ wave:'sine', f0:180, f1:560, dur:0.34, warble:22, noise:0.2, gurgle:true },
    parts:[
      p('sphere',[0,0.16,0],[0.42,0.40,0.42],'#c85ce0'),
      p('capsule',[0.30,-0.24,0.18],[0.075,0.20,0.075],'#b545cf',{ rot:[0.5,0,-0.6] }),
      p('capsule',[-0.30,-0.24,0.18],[0.075,0.20,0.075],'#b545cf',{ rot:[0.5,0,0.6] }),
      p('capsule',[0.34,-0.26,-0.14],[0.075,0.20,0.075],'#b545cf',{ rot:[-0.4,0,-0.7] }),
      p('capsule',[-0.34,-0.26,-0.14],[0.075,0.20,0.075],'#b545cf',{ rot:[-0.4,0,0.7] }),
      p('capsule',[0.10,-0.30,0.30],[0.07,0.18,0.07],'#b545cf',{ rot:[0.8,0,-0.2] }),
      p('capsule',[-0.10,-0.30,-0.30],[0.07,0.18,0.07],'#b545cf',{ rot:[-0.8,0,0.2] }),
    ]},

  { id:'volcano', name:'Volcanicus Lavabrain', rarity:'epic', idle:'pulse', pickup:'pop',
    blurb:'Anger issues, geologically speaking.',
    face:{ y:-0.08, spread:0.20, size:0.115, mouth:'fang', mouthY:-0.28 },
    sfx:{ wave:'sawtooth', f0:50, f1:260, dur:0.6, warble:9, noise:0.5, sub:true },
    parts:[
      p('cone',[0,-0.12,0],[0.52,0.46,0.52],'#4a3b3b'),
      p('cyl',[0,0.28,0],[0.20,0.06,0.20],'#ff6a2b',{ emissive:0.8 }),
      p('sphere',[0,0.40,0],[0.10,0.11,0.10],'#ffb02b',{ emissive:0.9 }),
      p('sphere',[0.16,0.34,0.10],[0.05,0.05,0.05],'#ff4d2b',{ emissive:0.9 }),
      p('box',[0.22,0.02,0.30],[0.05,0.22,0.05],'#ff6a2b',{ rot:[0.4,0,0.5], emissive:0.6 }),
      p('box',[-0.26,-0.06,0.24],[0.045,0.18,0.045],'#ff6a2b',{ rot:[0.3,0,-0.5], emissive:0.6 }),
    ]},

  { id:'duck', name:'Duckington Quackers', rarity:'uncommon', idle:'bob', pickup:'squash',
    blurb:'Rubber on the outside. Rubber all the way down.',
    face:{ y:0.20, spread:0.17, size:0.105, mouth:'beak', mouthY:0.02 },
    sfx:{ wave:'square', f0:520, f1:300, dur:0.24, warble:34, noise:0.08 },
    parts:[
      p('sphere',[0,-0.14,0],[0.44,0.32,0.40],'#ffd83f'),
      p('sphere',[0,0.22,0.06],[0.26,0.25,0.26],'#ffe15e'),
      p('cyl',[0,0.20,0.32],[0.13,0.05,0.10],'#ff8f2b',{ rot:[Math.PI/2,0,0] }),
      p('sphere',[0,-0.10,-0.36],[0.16,0.14,0.12],'#ffd83f',{ rot:[0.5,0,0] }),
      p('box',[0.36,-0.16,0],[0.14,0.05,0.16],'#ffc21f',{ rot:[0,0,-0.3] }),
      p('box',[-0.36,-0.16,0],[0.14,0.05,0.16],'#ffc21f',{ rot:[0,0,0.3] }),
    ]},

  { id:'mop', name:'Mopfredo Swiffly', rarity:'common', idle:'wobble', pickup:'tumble',
    blurb:'Cleans nothing. Vibes immaculately.',
    face:{ y:-0.06, spread:0.16, size:0.10, mouth:'derp', mouthY:-0.26 },
    sfx:{ wave:'triangle', f0:260, f1:520, dur:0.26, warble:16, noise:0.4 },
    parts:[
      p('cyl',[0,0.34,0],[0.06,0.32,0.06],'#9a6a3f'),
      p('sphere',[0,0.0,0],[0.34,0.20,0.30],'#e8e2d0'),
      p('capsule',[0.18,-0.26,0.10],[0.05,0.16,0.05],'#e8e2d0'),
      p('capsule',[-0.18,-0.26,0.10],[0.05,0.16,0.05],'#e8e2d0'),
      p('capsule',[0,-0.28,-0.14],[0.05,0.18,0.05],'#e8e2d0'),
      p('capsule',[0.02,-0.30,0.24],[0.05,0.17,0.05],'#dcd5c0'),
    ]},

  { id:'bolt', name:'Zapster Bolticus', rarity:'rare', idle:'shiver', pickup:'pop',
    blurb:'Runs at 240Hz. Has never blinked.',
    face:{ y:0.12, spread:0.18, size:0.105, mouth:'grin', mouthY:-0.08, glowEyes:true },
    sfx:{ wave:'square', f0:1600, f1:220, dur:0.2, warble:80, noise:0.25 },
    parts:[
      p('box',[0.08,0.26,0],[0.16,0.28,0.10],'#ffe14d',{ rot:[0,0,-0.35], emissive:0.5 }),
      p('box',[-0.06,-0.02,0],[0.24,0.14,0.10],'#ffd23f',{ rot:[0,0,-0.35], emissive:0.5 }),
      p('box',[-0.10,-0.28,0],[0.14,0.26,0.10],'#ffe14d',{ rot:[0,0,-0.35], emissive:0.5 }),
      p('sphere',[0,0,0],[0.30,0.30,0.16],'#fff6c2',{ emissive:0.35, alpha:0.4 }),
    ]},

  { id:'bread', name:'Sir Loafington Breadly', rarity:'common', idle:'jiggle', pickup:'squash',
    blurb:'Knighted for services to carbohydrates.',
    face:{ y:0.04, spread:0.20, size:0.115, mouth:'smirk', mouthY:-0.18 },
    sfx:{ wave:'triangle', f0:180, f1:340, dur:0.28, warble:7, noise:0.28 },
    parts:[
      p('box',[0,-0.06,0],[0.42,0.30,0.34],'#e0b073',{ round:0.35 }),
      p('sphere',[0,0.22,0],[0.42,0.20,0.34],'#f0c88f'),
      p('box',[0,0.30,0],[0.06,0.10,0.30],'#c98d4f',{ rot:[0,0,0.2] }),
      p('box',[0.16,0.28,0],[0.05,0.09,0.28],'#c98d4f',{ rot:[0,0,0.2] }),
      p('box',[-0.16,0.28,0],[0.05,0.09,0.28],'#c98d4f',{ rot:[0,0,0.2] }),
    ]},

  { id:'omega', name:'Eternal Brainrot Omega', rarity:'mythic', idle:'spin', pickup:'stretch',
    blurb:'The final brainrot. Speaks only in reaction images.',
    face:{ y:0.06, spread:0.22, size:0.12, mouth:'fang', mouthY:-0.18, glowEyes:true },
    sfx:{ wave:'sawtooth', f0:55, f1:1760, dur:0.8, warble:5, noise:0.15, chord:[1,1.5,2,3] },
    parts:[
      p('sphere',[0,0.02,0],[0.46,0.42,0.44],'#ff3d8b',{ emissive:0.3 }),
      p('sphere',[0.19,0.24,0.16],[0.17,0.15,0.16],'#ff6fb0',{ emissive:0.35 }),
      p('sphere',[-0.19,0.24,0.16],[0.17,0.15,0.16],'#ff6fb0',{ emissive:0.35 }),
      p('sphere',[0,0.26,-0.22],[0.19,0.16,0.16],'#ff6fb0',{ emissive:0.35 }),
      p('torus',[0,0.06,0],[0.70,0.03,0.70],'#ffd23f',{ rot:[0.5,0.2,0], emissive:0.6 }),
      p('torus',[0,0.06,0],[0.70,0.03,0.70],'#25d3ff',{ rot:[-0.5,-0.4,0.3], emissive:0.6 }),
      p('cone',[0.30,0.44,0],[0.07,0.18,0.07],'#ffd23f',{ rot:[0,0,-0.4], emissive:0.4 }),
      p('cone',[-0.30,0.44,0],[0.07,0.18,0.07],'#ffd23f',{ rot:[0,0,0.4], emissive:0.4 }),
    ]},
];

export const BRAINROT_BY_ID = Object.fromEntries(BRAINROTS.map((b) => [b.id, b]));

/** Weighted pick used for round rewards. `rng` is a util.RNG. */
export function rollBrainrot(rng, luck = 1) {
  const pool = BRAINROTS.map((b) => {
    const r = RARITY[b.rarity];
    // luck nudges the curve toward rarer entries without ever guaranteeing them
    const w = r.weight / Math.pow(luck, RARITY_ORDER.indexOf(b.rarity) * 0.5);
    return { b, w };
  });
  let total = 0;
  for (const e of pool) total += e.w;
  let t = rng.next() * total;
  for (const e of pool) { t -= e.w; if (t <= 0) return e.b; }
  return pool[0].b;
}

/** The brainrot used as the match objective, chosen deterministically from the seed. */
export function matchBrainrot(seed) {
  const idx = seed % BRAINROTS.length;
  return BRAINROTS[idx];
}
