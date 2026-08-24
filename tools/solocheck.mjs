/* ============================================================
   solocheck.mjs - "the player presses PLAY".

   playcheck.mjs used to prove that two people pressing PLAY were
   matched with each other and never with a bot. There is no second
   person any more, so the guarantee worth proving is the opposite
   one: a match runs start to finish with no transport, no protocol
   and no server process, purely inside SoloSession.

     node tools/solocheck.mjs
   ============================================================ */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const url = (p) => pathToFileURL(path.join(ROOT, 'src', p)).href;

let bad = 0;
const ok = (m) => console.log('  ' + m);
const fail = (m) => { console.error('  FAIL  ' + m); bad++; };

/* The sim is deliberately DOM-free, but SoloSession reaches for the arena,
   which expects a few browser globals to exist. */
globalThis.STB_CONFIG = { dev: false };
globalThis.location = { protocol: 'http:', host: 'localhost', search: '' };

const { SoloSession, makeOpponent } = await import(url('game/solo.js'));
const { DT } = await import(url('game/sim.js'));

for (const variant of ['classic', 'tagbomb']) {
  const seed = variant === 'classic' ? 20260825 : 777;
  const opp = makeOpponent(seed);
  if (!opp.name || !opp.loadout?.skin) fail(`${variant}: opponent was not generated`);

  /* A human who never touches the controls. The AI should still play a whole
     round against them and the round should still resolve - that is the part
     that used to depend on a peer being connected. */
  const idle = { x: 0, z: 0, dash: false, taunt: false, a0: false, a1: false, a2: false };
  const s = new SoloSession({ idx: 0, seed, opp, variant, difficulty: 'normal', readInput: () => idle });

  let ended = null;
  s.on('ended', (d) => { ended = d; });
  s.start();

  let ticks = 0;
  while (!ended && ticks < 60 * 90) { s.update(DT); ticks++; }

  if (!ended) { fail(`${variant}: round never ended after ${ticks} ticks`); continue; }
  if (ended.winner === undefined) fail(`${variant}: no winner decided`);
  if (!ended.me || !ended.them) fail(`${variant}: missing per-player stats`);

  /* The AI has to have actually played, and what that looks like differs by
     mode. In CLASSIC it should go and take the loose brainrot, so it scores.
     In TAG BOMB an idle human who starts holding the bomb simply keeps it, and
     the correct AI behaviour is to stay away and let them explode - so the
     thing to assert is that doing nothing loses, not that the bot tagged. */
  if (variant === 'classic') {
    if (!(ended.them.score > 0)) fail('classic: the AI never took the brainrot');
  } else if (ended.winner === 0) {
    fail('tagbomb: standing still while holding the bomb somehow won');
  }

  const who = ended.winner === -1 ? 'draw' : `p${ended.winner}`;
  ok(`${variant.padEnd(7)} full round with no network: ${ticks} ticks, winner=${who}, `
    + `bot scored ${ended.them.score}${variant === 'tagbomb' ? `, tags ${ended.them.tags}` : ''}`);
}

console.log(`\n${bad ? '\u274c' : '\u2705'} solo path ${bad ? 'FAILED' : 'works with no server'}`);
process.exit(bad ? 1 : 0);
