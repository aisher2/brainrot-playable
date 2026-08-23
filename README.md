# 🧠 Steal the Brainrot

A 60-second, 2-player, real-time brawl for **YouTube Playables**.
Two players are matched into a small arena. A ridiculous collectible — the
Brainrot — drops in the middle. Whoever holds it scores. Whoever doesn't holds
a grudge, and a dash button.

```
CLICK PLAY → MATCH → RUN → STEAL → CHAOS → WIN → PLAY AGAIN
```

---

> **Deploying it?** See **[DEPLOY.md](DEPLOY.md)** for step-by-step instructions
> to get a public HTTPS URL (static host in ~2 minutes, or a Node host that
> also runs the multiplayer relay).

## Run it

```bash
node server/server.js
```

Then open <http://localhost:8080>. That one command serves the game, runs the
matchmaking relay, hands out friend-room codes and keeps the world leaderboard
— no `npm install`, no dependencies, Node 18+.

To test real multiplayer, open the URL in **two tabs** and press **PLAY** in
both. To play with someone specific, use **PLAY WITH A FRIEND** — one side
creates a room and reads out the 4-character code, the other types it in. To
play alone, press **PRACTICE vs BOT**.

The world leaderboard is stored in `$DATA_DIR/leaderboard.json` (default
`./data/`), rewritten within a second of any change. On a host with an
ephemeral filesystem, point `DATA_DIR` at a persistent disk or the board resets
on each redeploy — see [DEPLOY.md](DEPLOY.md).

| Command | What it does |
| --- | --- |
| `node server/server.js` | game + relay on :8080 |
| `PORT=3000 node server/server.js` | pick a port |
| `DATA_DIR=/data node server/server.js` | keep the world leaderboard somewhere persistent |
| `node server/server.js --root dist` | serve the built bundle |
| `node server/server.js --dev` | additionally accept screenshots from `tools/devkit.js` |
| `node tools/check.mjs` | import every module + simulate a full headless round |
| `node tools/netcheck.mjs` | boot the relay, connect two real clients, play a full round |
| `node tools/playcheck.mjs` | two players press PLAY and get each other, not bots |
| `node tools/servercheck.mjs` | the world board survives a restart; friend codes pair the right two people |
| `node tools/friendcheck.mjs` | CREATE A ROOM works the way `main.js` drives it, retries included |
| `node tools/mapcheck.mjs` | every arena is symmetric, spawns are clear, the map pick is deterministic |
| `node tools/check.mjs` | ...also verifies every ability fires, lands and serialises |
| `node tools/build.mjs --single` | bundle into `dist/` (real 1v1 via this host) |
| `node tools/build.mjs --relay=off` | ...static-host build, practice only |
| `node tools/build.mjs --playables` | ...with the YouTube Playables SDK tag |

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

Each orb carries a 3D emblem of the same icon as its HUD button - a boot, a
peel, a crown - so you can tell what it grants before walking to it.

Orbs always arrive as a **180-degree mirrored pair**, so neither spawn is ever
closer to a drop than the other - the same fairness rule the maps follow. Six
can be alive at once and an untouched one fades after 24s. Each carries a short
shaft of light so you can find it without hunting.

Which orb you get is rolled from the simulation's own seeded RNG, so both
clients agree on every drop without it going over the wire.

Dash is *not* pickup-gated - it is core movement and the steal mechanic is
built on it, so it keeps its own short cooldown.

Everything aims from the direction you are already facing, so a phone needs no
second stick and a keyboard needs no mouse.

---

## Two round variants

| | How you score |
| --- | --- |
| **CLASSIC** | hold the Brainrot. +1 every 0.25s, +10 for a steal |
| **HOT POTATO** | the Brainrot is armed. Holding pays **nothing** - you score by offloading it (+3) and by being the one not holding it when it goes off (+18) |

The fuse starts at 6.5s and tightens to 3.0s by the end of the round, so late
passes get frantic. The Brainrot reddens, smokes and shakes the camera as it
gets close, so you never need to watch a number.

The magnet is not in TAG BOMB. It exists to rip a loose brainrot out of the
air, and the bomb is strapped on and never loose - so it had nothing to do.
Only the kick and the banana drop there.

Practice uses whichever mode is selected on the menu. Online matches derive
it from the shared seed - the same trick the maps use - so both clients agree
without another wire field, and the mode is announced next to the map name at
the start of the round.

---

## The maps

Five arenas in `src/game/maps.js`. Which one you get is derived from the match
seed, so a real 1v1 and a bot match both land on a random map and **both
clients compute the same one without it ever going over the wire**.

| Map | Character |
| --- | --- |
| NEON DAIS | the classic: ramps on every side |
| THE SPIRE | tall narrow pedestal, ramps on one axis only |
| BUMPER BOWL | tight, no platforms, eight bounce pads |
| THE LONG YARD | wide and open, four slow platforms |
| CAROUSEL | six ramps, four fast platforms, ring of pillars |

The roaming platforms are **trampolines**: land on one and it launches you
about twice as high as a static bounce pad, and harder the harder you come
down. The impact bonus is capped so the bounce cannot feed itself into orbit -
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
    sim.js            the authoritative simulation (no DOM, no randomness)
    match.js          host/client sessions, snapshots, rollback
    view.js           animation, effects, camera, nameplates
  net/
    protocol.js       the wire contract
    transport.js      WebSocket + an in-page loopback for practice
    netclient.js      matchmaking
    bot.js            the PRACTICE opponent (never used online)
    leaderboard.js    local board now, one endpoint away from global
  data/
    brainrots.js      28 original characters as shape recipes
    cosmetics.js      skins, hats, faces, trails, emotes, victories, plates
    progression.js    XP curve, daily challenges, achievements
  ui/ui.js            every screen and the HUD
server/
  server.js           static host + matchmaking relay
  ws.js               a minimal RFC 6455 server (zero dependencies)
```

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

### Networking

The server never simulates. It pairs two real players, elects a host, hands
both the same seed, and forwards bytes.

```
player A ──┐                    ┌── player B
           ├── relay (server) ──┤
    host   ┘                    └   client
     │                                │
     │  20Hz snapshots  ───────────►  │  applies, then re-simulates its own
     │  ◄───────────  30Hz inputs     │  inputs on top (rollback)
```

* The host runs `stepSim` at a fixed 60Hz and broadcasts the whole state (it is
  ~96 numbers, about **0.4 kB per snapshot**).
* The client runs the *same* `stepSim`, predicts its own player immediately,
  and on each snapshot rewinds to the authoritative tick and replays its stored
  inputs. Measured over a full round: **median correction 0.01 units, p95 0.13**.
* `game/view.js` smooths everything it draws, so even a large correction
  slides rather than teleports.

`sim.js` has no DOM, no audio and no `Math.random` — only a seeded RNG carried
inside the state. Moving the host into a Node process later is a lift-and-shift:
the same module already runs headless in `tools/check.mjs`.

**Practice mode** runs the identical protocol over an in-page loopback
(`transport.js → localPair`), with `net/bot.js` on the far end. Online
matchmaking never pairs you with a bot, and the bot is labelled as one
everywhere it appears.

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
`pagehide`.

---

## Hooking up your own backend

| What | Where | How |
| --- | --- | --- |
| Matchmaking relay | Settings → **MULTIPLAYER SERVER**, or `defaultServerUrl()` in `net/protocol.js` | blank = `ws(s)://<page origin>/ws` |
| Global leaderboard | `window.STB_CONFIG.leaderboard` in `index.html` | `"auto"` = `/api` on this origin. Any host answering `GET /top?limit=25` and `POST /score` works |
| Cloud saves | `core/storage.js` | add a backend next to `ytgame` / `localStorage` |
| Authoritative server | `game/match.js` | implement the `P.*` half of `net/protocol.js` server-side and drop `HostSession` in |

The relay is stateless apart from the queue and the open friend rooms. It
rate-limits each socket, sanitizes profiles, and drops a room when either side
disappears (the survivor gets the win rather than a hang). Friend codes are
single-use, expire after 15 minutes, and are drawn from an alphabet with no
lookalike glyphs so they can be read aloud.

The leaderboard is a single JSON file, top 200, one row per player with their
best score. It caps submissions at 40/hour per address and refuses anything
above 2000 points. The score is still self-reported by the client, so it is a
friendly scoreboard rather than a ranked ladder.

---

## Verification

```
node tools/check.mjs
  24 modules import clean; a full 60s round simulates with nobody
  leaving the arena and the wire format round-trips losslessly

node tools/netcheck.mjs
  relay booted, two real WebSocket clients queued and paired,
  3890 ticks played, host and client agree on every score,
  1296 snapshots, rollback p50 0.010u / p95 0.134u,
  disconnect mid-round hands the win to the player who stayed

node tools/servercheck.mjs
  the world leaderboard sorts, keeps one row per player, refuses
  implausible scores and survives a hard kill; friend codes pair the
  right two people, fail cleanly when wrong, and cannot be reused

node tools/build.mjs
  24 modules → 3 files, 319 kB raw / 91 kB gzipped, bundle passes node --check
```

`tools/devkit.js` is a browser-side harness (`__playRound`, `__run`, `__full`)
for driving the game without `requestAnimationFrame` and saving screenshots to
`tools/shots/`. It is dev-only and is not referenced by `index.html`.

---

## Original work

Every character, name, model, sound and piece of art here is original. The cast
is inspired by the *genre* of absurd internet meme creatures; none of it is
copied from any existing game, and nothing depends on third-party assets.
