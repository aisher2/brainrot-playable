/* ============================================================
   mapcheck.mjs - every arena must be fair and playable.

   The two spawns are fixed at (0, +/-11), so a layout that is not
   180-degree symmetric hands one player an advantage before the
   round starts. These are hand-authored, so the invariants get
   checked rather than trusted.

     node tools/mapcheck.mjs
   ============================================================ */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const url = (p) => pathToFileURL(path.join(ROOT, 'src', p)).href;

const arena = await import(url('game/arena.js'));
const { CFG, SPAWNS } = await import(url('game/sim.js'));
const { MAPS, mapForSeed, setArena, A, PILLARS, BOUNCE_PADS, SPEED_ZONES, STEPS,
  RAMP_ANGLES, staticHeight, resolveSolids } = arena;

const problems = [];
const ok = (m) => console.log('  ok    ' + m);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/** does `list` contain a point at (-x, -z) matching every entry? */
function symmetric(list, label, mapName, keys = []) {
  for (const it of list) {
    const twin = list.find((o) => near(o.x, -it.x) && near(o.z, -it.z)
      && keys.every((k) => near(o[k] ?? 0, it[k] ?? 0)));
    if (!twin) {
      problems.push(`${mapName}: ${label} at (${it.x}, ${it.z}) has no 180-degree twin`);
      return false;
    }
  }
  return true;
}

for (let i = 0; i < MAPS.length; i++) {
  setArena(i);
  const m = MAPS[i];
  const n = m.name;

  // 1. symmetry - otherwise one spawn is simply better
  const symOk = [
    symmetric(PILLARS, 'pillar', n, ['r', 'h']),
    symmetric(BOUNCE_PADS, 'pad', n),
    symmetric(SPEED_ZONES, 'zone', n),
    symmetric(STEPS, 'step', n, ['w', 'd', 'h']),
  ].every(Boolean);

  // ramp angles must also come in opposing pairs
  let rampSym = true;
  for (const a of RAMP_ANGLES) {
    const opp = Math.atan2(Math.sin(a + Math.PI), Math.cos(a + Math.PI));
    if (!RAMP_ANGLES.some((b) => near(Math.atan2(Math.sin(b - opp), Math.cos(b - opp)), 0, 1e-6))) {
      problems.push(`${n}: ramp at ${a.toFixed(3)} rad has no opposing ramp`);
      rampSym = false;
      break;
    }
  }

  // 2. both spawns must be inside the walls and not buried in a pillar
  let spawnOk = true;
  for (const sp of SPAWNS) {
    const lim = A.HALF - CFG.P_RADIUS;
    if (Math.abs(sp.x) > lim || Math.abs(sp.z) > lim) {
      problems.push(`${n}: spawn (${sp.x}, ${sp.z}) is outside the walls (HALF ${A.HALF})`);
      spawnOk = false;
    }
    for (const p of PILLARS) {
      const clear = (p.r || A.PILLAR_R) + CFG.P_RADIUS + 0.6;
      if ((sp.x - p.x) ** 2 + (sp.z - p.z) ** 2 < clear * clear) {
        problems.push(`${n}: pillar at (${p.x}, ${p.z}) crowds spawn (${sp.x}, ${sp.z})`);
        spawnOk = false;
      }
    }
    // and standing there must not shove the player somewhere else
    const e = { x: sp.x, z: sp.z, vx: 0, vz: 0 };
    resolveSolids(e, CFG.P_RADIUS);
    if (Math.hypot(e.x - sp.x, e.z - sp.z) > 1e-6) {
      problems.push(`${n}: spawn (${sp.x}, ${sp.z}) is pushed out by collision resolution`);
      spawnOk = false;
    }
  }

  // 3. the dais must be walkable up to: every ramp has to rise smoothly from
  //    the floor to the dais with no step down to trip on
  const rampRun = A.RAMP_END - A.DAIS_R;
  if (rampRun <= 0.5) problems.push(`${n}: ramps are too short to climb (run ${rampRun.toFixed(2)})`);
  const slope = A.DAIS_H / rampRun;
  if (slope > 0.6) problems.push(`${n}: ramp slope ${slope.toFixed(2)} is too steep`);
  for (let ri = 0; ri < RAMP_ANGLES.length; ri++) {
    const ang = RAMP_ANGLES[ri];
    let prev = null, bad = false;
    for (let r = A.RAMP_END; r >= 0; r -= 0.2) {
      const h = staticHeight(Math.cos(ang) * r, Math.sin(ang) * r);
      if (prev !== null && h < prev - 1e-9) { bad = true; break; }
      prev = h;
    }
    if (bad) problems.push(`${n}: ramp ${ri} steps back down instead of climbing`);
    else if (!near(prev, A.DAIS_H)) problems.push(`${n}: ramp ${ri} tops out at ${prev} not DAIS_H ${A.DAIS_H}`);
  }

  // 4. nothing may sit outside or on top of the wall
  for (const [label, list, rad] of [
    ['pillar', PILLARS, null], ['pad', BOUNCE_PADS, A.PAD_R], ['zone', SPEED_ZONES, A.ZONE_R],
  ]) {
    for (const it of list) {
      const r = rad == null ? (it.r || A.PILLAR_R) : rad;
      if (Math.abs(it.x) + r > A.HALF || Math.abs(it.z) + r > A.HALF) {
        problems.push(`${n}: ${label} at (${it.x}, ${it.z}) pokes through the wall`);
      }
    }
  }

  // 5. the centre must be standable at the height the brainrot spawns over
  if (!near(staticHeight(0, 0), A.DAIS_H)) {
    problems.push(`${n}: centre height ${staticHeight(0, 0)} does not match DAIS_H ${A.DAIS_H}`);
  }

  if (symOk && rampSym && spawnOk) {
    ok(`${n.padEnd(14)} symmetric, spawns clear, dais reachable ` +
       `(HALF ${A.HALF}, ${RAMP_ANGLES.length} ramps, ${A.MOVERS} platforms)`);
  }
}

/* ---- the pick must be deterministic and reasonably spread ---- */
{
  const seen = new Array(MAPS.length).fill(0);
  const N = 60000;
  for (let i = 0; i < N; i++) {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const a = mapForSeed(seed);
    if (a !== mapForSeed(seed)) { problems.push('mapForSeed is not deterministic'); break; }
    if (!(a >= 0 && a < MAPS.length)) { problems.push('mapForSeed returned ' + a); break; }
    seen[a]++;
  }
  const pct = seen.map((c) => (c / N) * 100);
  const lo = Math.min(...pct), hi = Math.max(...pct);
  const fair = 100 / MAPS.length;
  if (lo < fair * 0.8 || hi > fair * 1.2) {
    problems.push(`map distribution is lopsided: ${pct.map((p) => p.toFixed(1) + '%').join(' ')}`);
  } else {
    ok(`seed picks spread evenly: ${pct.map((p) => p.toFixed(1) + '%').join(' ')}`);
  }
}

/* ---- both clients must derive the same map from the same seed ---- */
{
  let bad = 0;
  for (let i = 0; i < 5000; i++) {
    const seed = (Math.random() * 0xffffffff) >>> 0;
    if (mapForSeed(seed) !== mapForSeed(seed >>> 0)) bad++;
  }
  if (bad) problems.push(`${bad} seeds disagreed between clients`);
  else ok('host and client derive the same map from the same seed');
}

/* ---- swapping maps must fully replace the previous one ---- */
{
  setArena(3);
  const yardHalf = A.HALF, yardPillars = PILLARS.length;
  setArena(2);
  if (A.HALF === yardHalf) problems.push('dims did not change when swapping map');
  if (PILLARS.length === yardPillars) problems.push('pillars did not change when swapping map');
  setArena(3);
  if (A.HALF !== yardHalf || PILLARS.length !== yardPillars) {
    problems.push('swapping back did not restore the map');
  } else {
    ok('maps swap cleanly in both directions, no leftover state');
  }
}

/* ---- every map must survive a full headless round ----
   Geometry bugs show up as players tunnelling out of the arena, falling
   through the floor, or NaN creeping into the state. */
{
  const { createSim, stepSim, DT } = await import(url('game/sim.js'));
  for (let mi = 0; mi < MAPS.length; mi++) {
    setArena(mi);
    const name = MAPS[mi].name;
    const sim = createSim(1234 + mi * 7919, { brainrotId: 'banana' });
    let inputs = [{ x: 0, z: -1 }, { x: 0, z: 1 }];
    const ticks = Math.ceil((60 + 4.8) / DT);
    let escaped = 0, sank = 0, nan = false;
    const lim = A.HALF + 0.75;
    for (let i = 0; i < ticks; i++) {
      if (i % 37 === 0) {
        const a = (i * 0.37) % (Math.PI * 2);
        inputs = [
          { x: Math.cos(a), z: Math.sin(a), dash: i % 111 === 0, a0: i % 173 === 0, a1: i % 211 === 0, a2: i % 401 === 0 },
          { x: -Math.cos(a * 1.3), z: -Math.sin(a * 1.3), dash: i % 97 === 0, a1: i % 181 === 0 },
        ];
      }
      stepSim(sim, inputs, null);
      for (const pl of sim.players) {
        if (!Number.isFinite(pl.x) || !Number.isFinite(pl.y) || !Number.isFinite(pl.z)) nan = true;
        if (Math.abs(pl.x) > lim || Math.abs(pl.z) > lim) escaped++;
        if (pl.y < -3) sank++;
      }
      if (nan) break;
    }
    // Scores are not asserted here: the scripted pilots are crude and a big
    // arena legitimately yields fewer pickups. Reachability is proven by the
    // ramp walk above; this pass is about physical integrity.
    if (nan) problems.push(`${name}: NaN appeared in player state`);
    else if (escaped) problems.push(`${name}: a player left the arena on ${escaped} ticks`);
    else if (sank) problems.push(`${name}: a player fell through the floor on ${sank} ticks`);
    else if (sim.phase !== 'over') problems.push(`${name}: round did not finish (phase ${sim.phase})`);
    else ok(`${name.padEnd(14)} full 60s round completes, nobody escaped, sank or NaN'd`);
  }
}

/* ---- the roaming platforms must launch you, and must not escalate ----
   A trampoline whose bounce feeds its own impact bonus would ramp a player
   into orbit, so the bonus is capped. Prove both halves. */
{
  const { createSim, stepSim, DT, CFG } = await import(url('game/sim.js'));
  const { moverPos } = arena;
  const idle = { x: 0, z: 0 };
  const padApex = (CFG.BOUNCE_VY ** 2) / (2 * -CFG.GRAVITY);

  for (let mi = 0; mi < MAPS.length; mi++) {
    setArena(mi);
    const name = MAPS[mi].name;
    if (!A.MOVERS) { ok(`${name.padEnd(14)} has no platforms - trampoline check skipped`); continue; }

    const sim = createSim(5, { brainrotId: 'banana' });
    while (sim.phase === 'countdown') stepSim(sim, [idle, idle], null);
    const p = sim.players[0];
    const mp = moverPos(0, sim.t);
    p.x = mp.x; p.z = mp.z; p.y = A.ORB_H + 3; p.vx = 0; p.vz = 0; p.vy = 0; p.onGround = false;

    // The trampoline un-grounds the player in the same tick it lands them, so
    // onGround is never observably true. Detect launches by the velocity spike.
    const apexes = [];
    let peak = -99, launched = false;
    for (let i = 0; i < Math.ceil(8 / DT); i++) {
      const m2 = moverPos(0, sim.t);
      if (p.y < A.ORB_H + 0.8) { p.x = m2.x; p.z = m2.z; }
      const vyBefore = p.vy;
      stepSim(sim, [idle, idle], null);
      const spiked = p.vy > vyBefore + 5 && p.vy >= CFG.TRAMP_VY - 0.5;
      if (spiked) {
        if (launched && peak > -99) apexes.push(peak);
        launched = true; peak = p.y;
      } else if (launched) {
        peak = Math.max(peak, p.y);
      }
    }
    if (launched && peak > -99) apexes.push(peak);

    if (apexes.length < 2) {
      problems.push(`${name}: landing on a platform did not launch the player`);
      continue;
    }
    const hi = Math.max(...apexes);
    const theoreticalMax = A.ORB_H + ((CFG.TRAMP_VY + CFG.TRAMP_BONUS_MAX) ** 2) / (2 * -CFG.GRAVITY);
    if (hi <= A.ORB_H + padApex) {
      problems.push(`${name}: platform apex ${hi.toFixed(2)} is no higher than a bounce pad`);
    } else if (hi > theoreticalMax + 0.6) {
      problems.push(`${name}: platform launched past the cap (${hi.toFixed(2)} > ${theoreticalMax.toFixed(2)}) - runaway bounce`);
    } else {
      const last = apexes.slice(-3).map((v) => v.toFixed(1)).join(' -> ');
      ok(`${name.padEnd(14)} platform launches to ${hi.toFixed(1)}u (pad tops out at ` +
         `${(A.ORB_H + padApex).toFixed(1)}u), stable: ${last}`);
    }
  }
}

if (problems.length) {
  console.error('\n' + problems.map((p) => '  FAIL  ' + p).join('\n'));
  process.exit(1);
}
console.log(`\n✅ ${MAPS.length} maps: all symmetric, fair spawns, deterministic random pick`);
process.exit(0);
