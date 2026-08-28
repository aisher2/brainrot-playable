# 🧠 Steal the Brainrot

A 60-second arena brawl for **YouTube Playables**. A ridiculous collectible —
the Brainrot — drops in the middle of a small arena. Whoever holds it scores.
Whoever doesn't holds a grudge, and a dash button.

```
PLAY → RUN → STEAL → CHAOS → WIN → PLAY AGAIN
```

You play against an on-device opponent. There is no server, no matchmaking and
no network traffic of any kind — see [Offline by construction](#offline-by-construction).

---

> **Deploying it?** See **[DEPLOY.md](DEPLOY.md)**. The build is one HTML file,
> so any static host will do.

## Run it

```bash
npm run build   # writes dist/index.html
npm start       # serve it on http://localhost:8080
```

No `npm install`, no dependencies, Node 18+.

| Command | What it does |
| --- | --- |
| `npm run build` | bundle everything into a single `dist/index.html` |
| `npm start` | serve `dist/` on :8080 |
| `npm run start:csp` | ...under YouTube's exact Content-Security-Policy |
| `npm run start:mock` | ...with a fake Playables host, so SDK paths actually run |
| `npm run checkall` | build, then run all 32 checks |
| `node tools/check.mjs` | imports, a full headless round, storage, UI wiring, the offline audit |
| `node tools/solocheck.mjs` | a complete round plays out with no server present |
| `node tools/mapcheck.mjs` | every arena is symmetric, spawns are clear, map picks are deterministic |

Build before checking. The audit reads the emitted page, so it has nothing to
inspect until `dist/` exists.

---

## Controls

| | Desktop | Mobile |
| --- | --- | --- |
| Move | `WASD` / arrows / gamepad stick | virtual joystick, bottom-left, 360° |
| Dash | `Space` / `Shift` | 💨 **DASH** button |
| 🦵 Yeet Kick | `Q` | ability button |
| 🍌 Banana Slip | `E` | ability button |
| 👑 Brainrot Magnet | `R` | ability button |
| Emote | `F` / left click | **TAUNT** button |
| Look around | — | swipe the arena (sensitivity in Settings) |

Touch controls appear automatically on the first touch or on a coarse pointer.
Movement and abilities are separate fingers: holding the stick never blocks a
button, and tapping a button never drops your movement.

**Both platforms play the identical game** — same speeds, cooldowns, damage,
scoring and match length. Only the input device differs.

### The three abilities

**None of them are on a timer.** You start a round with nothing: abilities drop
into the arena as glowing orbs, and you have to go and get them. Running over
one banks a charge; using the ability spends it. You can hold two of each.

| | What it does | Drop rate |
| --- | --- | --- |
| 🦵 **Yeet Kick** | A cone in front of you. Big knockback, stuns, and the holder drops the Brainrot. **+5** | common |
| 🍌 **Banana Slip** | Lobs a peel that arms where it lands. The other player slips, drops the Brainrot, and you score **+5**. Two live at a time. | common |
| 👑 **Brainrot Magnet** | Rips the Brainrot out of their hands and reels it toward you for 1.5s. | rare |

Each orb carries a 3D emblem of the same icon as its HUD button — a boot, a
peel, a crown — so you can tell what it grants before walking to it.

Orbs always arrive as a **180-degree mirrored pair**, so neither spawn is ever
closer to a drop than the other — the same fairness rule the maps follow. Six
can be alive at once and an untouched one fades after 24s.

Dash is *not* pickup-gated. It is core movement, and the steal mechanic is
built on it, so it keeps its own short cooldown.

Everything aims from the direction you are already facing, so a phone needs no
second stick and a keyboard needs no mouse.

---

## Two round variants

| | How you score |
| --- | --- |
| **CLASSIC** | hold the Brainrot. +1 every 0.25s, +10 for a steal — and you steal it by **touching** the holder, no button |
| **TAG BOMB** | the Brainrot is armed. Holding pays **nothing** — you score by offloading it (+3) and by being the one not holding it when it goes off (+18) |

The fuse starts at 6.5s and tightens to 3.0s by the end of the round, so late
passes get frantic. The Brainrot reddens, smokes and shakes the camera as it
gets close, so you never need to watch a number.

The magnet is not in TAG BOMB. It exists to rip a loose Brainrot out of the
air, and the bomb is strapped on and never loose — so it had nothing to do.
Only the kick and the banana drop there.

---

## The level ladder

Twelve hand-tuned stages in `src/data/levels.js`. Each pins its own map,
variant and bot difficulty rather than rolling them, so a level is the same
challenge for everyone and a 3-star run means the same thing on any device.

Clearing one requires a stated goal — win the round, reach a score, or make a
number of tags — and two further thresholds award the second and third star.
`tools/check.mjs` asserts that every stage's goal and star targets stay
consistent with its variant.

---

## The maps

Five arenas in `src/game/maps.js`. Which one you get is derived from the match
seed.

| Map | Character |
| --- | --- |
| NEON DAIS | the classic: ramps on every side |
| THE SPIRE | tall narrow pedestal, ramps on one axis only |
| BUMPER BOWL | tight, no platforms, eight bounce pads |
| THE LONG YARD | wide and open, four slow platforms |
| CAROUSEL | six ramps, four fast platforms, ring of pillars |

The roaming platforms are **trampolines**: land on one and it launches you
about twice as high as a static bounce pad, and harder the harder you come
down. The impact bonus is capped so the bounce cannot feed itself into orbit —
`mapcheck` asserts both the launch and the ceiling.

Every map is 180-degree symmetric. The spawns are fixed at `(0, ±11)`, so an
asymmetric layout would hand one player an advantage before the round starts —
`tools/mapcheck.mjs` enforces that, along with clear spawns and a dais you can
actually walk up to.

Adding one is a data edit: append to `MAPS`, keep it symmetric, run mapcheck.
The arena tables are mutated in place rather than reassigned, because the
bundler rewrites `import { A }` into a destructured copy — reassigning an
export would work in dev and silently break in `dist/`.

---

## The rules

* **60 seconds.** Holding the Brainrot pays **+1 every 0.25s**.
* **Steal +10** — take it within 8s of knocking it loose.
* **Dash hit +5** — connect a dash and the holder drops it in an arc.
* **Longest hold +20** — awarded at the buzzer to whoever kept it longest in one go.
* A **chaos event** fires every 10–15s: Brainrot Frenzy (five decoys, one real),
  Speed Brainrot, Chaos Teleport, Freeze, Mega Knockback, Golden Brainrot (2× points).
* Temporary hazard zones open every ~7s and bog you down if you run through them.

Dropping the Brainrot locks the ex-holder out of it for 0.55s, so a good bonk
actually earns you the pickup instead of bouncing straight back.

---

## Architecture

```
index.html            shell + every screen's markup
styles.css            the whole UI skin (no web fonts, no images)
src/
  main.js             boot, the frame loop, round lifecycle
  core/
    util.js           math, seeded RNG, event bus, colour helpers
    platform.js       the Playables SDK adapter (inert outside YouTube)
    storage.js        profile persistence (ytgame SDK → localStorage → memory)
    input.js          keyboard + mouse + gamepad + touch joystick, one API
    audio.js          every sound, synthesized: no audio files are downloaded
  gfx/
    m4.js             the 2 kB slice of matrix maths this needs
    mesh.js           procedural primitives + a mesh accumulator
    gl.js             WebGL1 toon renderer, one shader, one vertex format
    models.js         recipes → baked meshes (one draw call per character)
    particles.js      pooled CPU particles → one dynamic buffer
    studio.js         offscreen renderer for menu thumbnails
  game/
    arena.js          arena geometry + collision + the moving parts
    maps.js           the five arenas, as data
    sim.js            the authoritative simulation (no DOM, no randomness)
    solo.js           the match loop: your input and the bot's, one sim
    bot.js            the opponent
    view.js           animation, effects, camera, nameplates
    scores.js         this device's board, kept in the saved profile
  data/
    brainrots.js      28 original characters as shape recipes
    cosmetics.js      skins, hats, faces, trails, emotes, victories, plates
    levels.js         the 12-stage ladder
    progression.js    XP curve, daily challenges, achievements
  ui/ui.js            every screen and the HUD
server/
  server.js           a static file host, for looking at the build locally
```

### Offline by construction

A Playable is not permitted to call out, so the networking here is not disabled
— it is gone. There is no `src/net/`, no relay, no `/ws`, no `/api` and no
world leaderboard. `server/server.js` serves files and holds no state.

Both players live in one simulation (`game/solo.js`), so there is no wire to
pack for, no latency to predict around and nothing to reconcile. Each fixed
tick reads your input and the bot's, and steps the sim once.

The offline audit in `tools/check.mjs` asserts this against the built page
rather than trusting the source: no `WebSocket`, no `fetch`, no
`XMLHttpRequest` and no external origin survives into `dist/index.html`. The
only external resource the page names at all is the Playables SDK.

### Nothing is downloaded but code

There are no model files, no textures, no audio files, no web fonts.

* **Characters** are *recipes* — lists of primitives with positions, scales and
  colours (`data/brainrots.js`). `gfx/models.js` bakes a recipe into one
  interleaved vertex buffer, so a whole character is a single draw call. 28
  characters cost a few kB of source instead of a few MB of assets.
* **Sound** is synthesized from oscillators and filtered noise
  (`core/audio.js`). Each Brainrot has its own little synth patch, and the
  music is a scheduled 16-step chiptune loop that gains layers and tempo as the
  clock runs down.
* **Type** is a system-font stack. No FOUT, no font requests.

A full round renders in **13–31 draw calls**.

### Performance

* Geometry detail is chosen once at boot from `deviceMemory`,
  `hardwareConcurrency` and pointer type.
* A governor watches the rolling frame time and drops device-pixel-ratio and
  the particle budget if it slips, then raises them again if there is headroom.
  Players can force **AUTO / HIGH / LOW** in Settings.
* No post-processing. Shadows are blob decals. Outlines are inverted hulls,
  drawn only for characters.

### Saving

`core/storage.js` tries, in order: the YouTube Playables SDK
(`window.ytgame.game.saveData`), `localStorage`, then memory. Everything the
player earns lives in one JSON blob, written debounced and flushed on
`pagehide`. Cloud writes are held to the documented 3 MiB of UTF-16 and are
made well-formed first, so a lone surrogate cannot fail a save.

---

## The Playables SDK

`core/platform.js` is the only thing that touches `window.ytgame`. It reports
`firstFrameReady` when the first frame is on screen and `gameReady` when the
menu is interactive, mirrors the host's audio setting, pauses and resumes with
the host, sends a score at the end of a round, and offers both ad types.

Outside YouTube the SDK sets `IN_PLAYABLES_ENV` to false and every call is a
no-op, which means none of those paths run during ordinary development.
`npm run start:mock` substitutes `tools/ytgame-mock.js`, which implements the
documented API and adds buttons for the events the host would otherwise send —
pause, resume, an audio change, a failed ad, a declined reward. It is served
from `tools/`, never copied into `dist/`, and only behind that flag.

---

## Verification

`npm run checkall` builds and then runs 32 checks:

```
node tools/check.mjs
  24 modules import clean; a full 60s round simulates with nobody leaving
  the arena; storage falls back correctly when it is denied; every button
  in the markup is wired; no markup reaches el(); the built page makes no
  external calls

node tools/solocheck.mjs
  a full round plays out end to end with no server running

node tools/mapcheck.mjs
  every arena symmetric, spawns clear, trampolines bounded

node tools/build.mjs
  24 modules → one 408 kB file, 120 kB gzipped, and it parses
```

`tools/devkit.js` is a browser-side harness (`__playRound`, `__run`, `__full`)
for driving the game without `requestAnimationFrame` and saving screenshots to
`tools/shots/`. It is dev-only and is not referenced by `index.html`.

---

## Original work

Every character, name, model, sound and piece of art here is original. The cast
is inspired by the *genre* of absurd internet meme creatures; none of it is
copied from any existing game, and nothing depends on third-party assets.
