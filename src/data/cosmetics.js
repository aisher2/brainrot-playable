/* ============================================================
   cosmetics.js - player customisation catalogue.

   Everything here is cosmetic only. No item changes speed,
   damage, dash, score or hitbox. Rarity is bragging rights.
   ============================================================ */

/* ---------- SKINS: body palette + silhouette variant ---------- */
export const SKINS = [
  { id:'blob',    name:'Classic Blob',   rarity:'common',    body:'#ff3d8b', accent:'#ffd8e8', shape:'blob',  unlock:{ type:'default' } },
  { id:'mint',    name:'Mint Condition', rarity:'common',    body:'#4dffc3', accent:'#e6fff7', shape:'blob',  unlock:{ type:'default' } },
  { id:'tangerine',name:'Tangerine Menace',rarity:'common',  body:'#ff8a1f', accent:'#ffe0bd', shape:'blob',  unlock:{ type:'coins', cost:80 } },
  { id:'blueberry',name:'Blueberry Guy', rarity:'common',    body:'#4a6cff', accent:'#d6dfff', shape:'blob',  unlock:{ type:'coins', cost:80 } },
  { id:'tall',    name:'Longboi',        rarity:'uncommon',  body:'#8be04a', accent:'#eaffd4', shape:'tall',  unlock:{ type:'level', lvl:3 } },
  { id:'chonk',   name:'Absolute Unit',  rarity:'uncommon',  body:'#b06bff', accent:'#f0e0ff', shape:'chonk', unlock:{ type:'level', lvl:5 } },
  { id:'brick',   name:'Brickhead',      rarity:'uncommon',  body:'#d94f3d', accent:'#ffd4cd', shape:'box',   unlock:{ type:'coins', cost:220 } },
  { id:'ghost',   name:'Wifi Ghost',     rarity:'rare',      body:'#dff3ff', accent:'#8fd8ff', shape:'blob',  ghost:true, unlock:{ type:'level', lvl:8 } },
  { id:'slime',   name:'Sentient Slime', rarity:'rare',      body:'#3fe06a', accent:'#c8ffd8', shape:'chonk', wobble:1.6, unlock:{ type:'coins', cost:450 } },
  { id:'chrome',  name:'Chrome Menace',  rarity:'epic',      body:'#c9d6e2', accent:'#ffffff', shape:'tall',  metal:0.9, unlock:{ type:'level', lvl:12 } },
  { id:'lava',    name:'Magma Boy',      rarity:'epic',      body:'#ff5a1f', accent:'#ffe08a', shape:'blob',  emissive:0.35, unlock:{ type:'ach', id:'hoarder' } },
  { id:'void',    name:'Void Walker',    rarity:'legendary', body:'#2a1152', accent:'#c89bff', shape:'tall',  emissive:0.25, unlock:{ type:'ach', id:'champion' } },
  { id:'gold',    name:'Solid Gold Guy', rarity:'legendary', body:'#ffd23f', accent:'#fff3b0', shape:'chonk', metal:0.95, unlock:{ type:'coins', cost:1500 } },
  { id:'omegafan',name:'Omega Believer', rarity:'mythic',    body:'#ff3d8b', accent:'#25d3ff', shape:'blob',  emissive:0.4, rainbow:true, unlock:{ type:'ach', id:'omega' } },
];

/* ---------- HATS ---------- */
export const HATS = [
  { id:'none',    name:'Bare Head',      rarity:'common',    unlock:{ type:'default' }, parts:[] },
  { id:'cap',     name:'Backwards Cap',  rarity:'common',    unlock:{ type:'default' },
    parts:[ ['cyl',[0,0.06,0],[0.36,0.12,0.36],'#ff3d8b'], ['box',[0,0.02,-0.34],[0.30,0.05,0.20],'#e02f76'] ] },
  { id:'cone',    name:'Party Cone',     rarity:'common',    unlock:{ type:'coins', cost:60 },
    parts:[ ['cone',[0,0.20,0],[0.24,0.36,0.24],'#4dffc3'], ['sphere',[0,0.42,0],[0.09,0.09,0.09],'#ffd23f'] ] },
  { id:'bucket',  name:'Panic Bucket',   rarity:'uncommon',  unlock:{ type:'coins', cost:150 },
    parts:[ ['cyl',[0,0.14,0],[0.34,0.24,0.34],'#7fd4ff'], ['torus',[0,0.30,0],[0.35,0.04,0.35],'#4aa8d8'] ] },
  { id:'horns',   name:'Chaos Horns',    rarity:'uncommon',  unlock:{ type:'level', lvl:4 },
    parts:[ ['cone',[0.20,0.16,0],[0.09,0.24,0.09],'#ff5b5b',{rot:[0,0,-0.5]}], ['cone',[-0.20,0.16,0],[0.09,0.24,0.09],'#ff5b5b',{rot:[0,0,0.5]}] ] },
  { id:'halo',    name:'Fake Halo',      rarity:'rare',      unlock:{ type:'level', lvl:7 },
    parts:[ ['torus',[0,0.40,0],[0.24,0.035,0.24],'#ffe88a',{emissive:0.7}] ] },
  { id:'propeller',name:'Propeller Beanie',rarity:'rare',    unlock:{ type:'coins', cost:400 },
    parts:[ ['sphere',[0,0.10,0],[0.30,0.18,0.30],'#4dff9b'], ['cyl',[0,0.26,0],[0.03,0.10,0.03],'#333'],
            ['box',[0.14,0.34,0],[0.16,0.02,0.05],'#ff3d8b',{spin:'prop'}], ['box',[-0.14,0.34,0],[0.16,0.02,0.05],'#25d3ff',{spin:'prop'}] ] },
  { id:'crown',   name:'Brainrot Crown', rarity:'epic',      unlock:{ type:'ach', id:'streak5' },
    parts:[ ['cyl',[0,0.16,0],[0.28,0.12,0.28],'#ffd23f',{metal:0.8}], ['cone',[0,0.30,0],[0.06,0.12,0.06],'#ffd23f',{metal:0.8}],
            ['cone',[0.17,0.28,0.03],[0.05,0.10,0.05],'#ffd23f',{metal:0.8}], ['cone',[-0.17,0.28,0.03],[0.05,0.10,0.05],'#ffd23f',{metal:0.8}] ] },
  { id:'antenna', name:'Signal Antenna', rarity:'epic',      unlock:{ type:'coins', cost:900 },
    parts:[ ['cyl',[0,0.26,0],[0.025,0.26,0.025],'#c9d6e2'], ['sphere',[0,0.52,0],[0.08,0.08,0.08],'#ff3d8b',{emissive:0.8,pulse:true}] ] },
  { id:'galaxyhat',name:'Pocket Galaxy', rarity:'legendary', unlock:{ type:'ach', id:'collector' },
    parts:[ ['sphere',[0,0.30,0],[0.20,0.20,0.20],'#2a1152',{emissive:0.4}], ['torus',[0,0.30,0],[0.34,0.025,0.34],'#c89bff',{rot:[0.5,0,0.2],emissive:0.6}] ] },
];

/* ---------- FACES (expression presets) ---------- */
export const FACES = [
  { id:'happy',  name:'Happy',      rarity:'common',   unlock:{ type:'default' },  eye:'round',  mouth:'grin'   },
  { id:'derp',   name:'Derp',       rarity:'common',   unlock:{ type:'default' },  eye:'derp',   mouth:'derp'   },
  { id:'sigma',  name:'Unbothered', rarity:'common',   unlock:{ type:'coins', cost:50 }, eye:'half', mouth:'smirk' },
  { id:'shock',  name:'Shooketh',   rarity:'uncommon', unlock:{ type:'coins', cost:120 }, eye:'wide', mouth:'o'   },
  { id:'angy',   name:'Angy',       rarity:'uncommon', unlock:{ type:'level', lvl:3 }, eye:'angry', mouth:'fang' },
  { id:'dizzy',  name:'Dizzy',      rarity:'rare',     unlock:{ type:'ach', id:'bonked' }, eye:'spiral', mouth:'derp' },
  { id:'laser',  name:'Laser Eyes', rarity:'epic',     unlock:{ type:'level', lvl:10 }, eye:'laser', mouth:'smirk' },
  { id:'stars',  name:'Star Struck',rarity:'legendary',unlock:{ type:'ach', id:'perfect' }, eye:'star', mouth:'grin' },
];

/* ---------- TRAILS ---------- */
export const TRAILS = [
  { id:'none',   name:'No Trail',      rarity:'common',    unlock:{ type:'default' }, color:null },
  { id:'dust',   name:'Dust Puffs',    rarity:'common',    unlock:{ type:'default' }, color:'#d9cdbf', style:'puff' },
  { id:'bubbles',name:'Bubbles',       rarity:'common',    unlock:{ type:'coins', cost:70 },  color:'#8fd8ff', style:'bubble' },
  { id:'fire',   name:'Hot Streak',    rarity:'uncommon',  unlock:{ type:'level', lvl:4 },    color:'#ff7a1f', style:'fire' },
  { id:'sparkle',name:'Sparkles',      rarity:'uncommon',  unlock:{ type:'coins', cost:180 }, color:'#ffe88a', style:'spark' },
  { id:'toxic',  name:'Toxic Ooze',    rarity:'rare',      unlock:{ type:'coins', cost:380 }, color:'#7cff5c', style:'goo' },
  { id:'rainbow',name:'Rainbow Road',  rarity:'epic',      unlock:{ type:'ach', id:'win10' },  color:'rainbow', style:'ribbon' },
  { id:'void',   name:'Void Rift',     rarity:'legendary', unlock:{ type:'ach', id:'champion' }, color:'#a45cff', style:'rift' },
];

/* ---------- EMOTES (taunt button) ---------- */
export const EMOTES = [
  { id:'spin',   name:'Spin',        rarity:'common',   unlock:{ type:'default' },  icon:'🌀', anim:'spin'   },
  { id:'dance',  name:'Wiggle',      rarity:'common',   unlock:{ type:'default' },  icon:'🕺', anim:'wiggle' },
  { id:'point',  name:'Point & Laugh',rarity:'common',  unlock:{ type:'coins', cost:60 },  icon:'😂', anim:'point' },
  { id:'flex',   name:'Flex',        rarity:'uncommon', unlock:{ type:'level', lvl:2 },    icon:'💪', anim:'flex' },
  { id:'sleep',  name:'Bored',       rarity:'uncommon', unlock:{ type:'coins', cost:160 }, icon:'😴', anim:'sleep' },
  { id:'backflip',name:'Backflip',   rarity:'rare',     unlock:{ type:'ach', id:'steal10' }, icon:'🤸', anim:'flip' },
  { id:'explode',name:'Self Destruct',rarity:'epic',    unlock:{ type:'level', lvl:14 },   icon:'💥', anim:'explode' },
];

/* ---------- VICTORY ANIMATIONS ---------- */
export const VICTORIES = [
  { id:'jump',    name:'Happy Hops',    rarity:'common',   unlock:{ type:'default' },  anim:'jump' },
  { id:'spinwin', name:'Victory Spin',  rarity:'common',   unlock:{ type:'default' },  anim:'spin' },
  { id:'flexwin', name:'Muscle Pose',   rarity:'uncommon', unlock:{ type:'level', lvl:6 },  anim:'flex' },
  { id:'confetti',name:'Confetti Storm',rarity:'rare',     unlock:{ type:'coins', cost:500 }, anim:'confetti' },
  { id:'launch',  name:'Rocket Exit',   rarity:'epic',     unlock:{ type:'ach', id:'win10' }, anim:'launch' },
  { id:'godray',  name:'Ascension',     rarity:'legendary',unlock:{ type:'ach', id:'omega' }, anim:'ascend' },
];

/* ---------- NAMEPLATES ---------- */
export const PLATES = [
  { id:'plain',   name:'Plain',        rarity:'common',    unlock:{ type:'default' }, bg:'#00000066', fg:'#ffffff' },
  { id:'pink',    name:'Bubblegum',    rarity:'common',    unlock:{ type:'default' }, bg:'#ff3d8b',  fg:'#ffffff' },
  { id:'cyan',    name:'Coolant',      rarity:'common',    unlock:{ type:'coins', cost:40 }, bg:'#25d3ff', fg:'#08202b' },
  { id:'toxic',   name:'Hazard',       rarity:'uncommon',  unlock:{ type:'level', lvl:3 },   bg:'#7cff5c', fg:'#10240a' },
  { id:'gold',    name:'Certified',    rarity:'rare',      unlock:{ type:'ach', id:'win10' }, bg:'#ffd23f', fg:'#2b1c00' },
  { id:'omega',   name:'Omega Tier',   rarity:'mythic',    unlock:{ type:'ach', id:'omega' }, bg:'#0d0016', fg:'#ff3d8b', glow:true },
];

/* ---------- slot registry, used by the customise UI ---------- */
export const SLOTS = [
  { key:'skin',    label:'SKIN',     list:SKINS,     def:'blob'  },
  { key:'hat',     label:'HAT',      list:HATS,      def:'none'  },
  { key:'face',    label:'FACE',     list:FACES,     def:'happy' },
  { key:'trail',   label:'TRAIL',    list:TRAILS,    def:'dust'  },
  { key:'emote',   label:'EMOTE',    list:EMOTES,    def:'spin'  },
  { key:'victory', label:'VICTORY',  list:VICTORIES, def:'jump'  },
  { key:'plate',   name:'plate', label:'NAMEPLATE', list:PLATES, def:'plain' },
];

export const SLOT_BY_KEY = Object.fromEntries(SLOTS.map((s) => [s.key, s]));

export function findItem(slotKey, id) {
  const s = SLOT_BY_KEY[slotKey];
  if (!s) return null;
  return s.list.find((i) => i.id === id) || s.list.find((i) => i.id === s.def);
}

export function defaultLoadout() {
  const o = {};
  for (const s of SLOTS) o[s.key] = s.def;
  return o;
}

/** items unlocked with no action required */
export function defaultUnlocks() {
  const out = [];
  for (const s of SLOTS)
    for (const it of s.list)
      if (it.unlock?.type === 'default') out.push(s.key + ':' + it.id);
  return out;
}

export function unlockText(item) {
  const u = item.unlock || {};
  switch (u.type) {
    case 'coins': return u.cost + ' 🧠';
    case 'level': return 'LEVEL ' + u.lvl;
    case 'ach':   return 'ACHIEVEMENT';
    default:      return '';
  }
}
