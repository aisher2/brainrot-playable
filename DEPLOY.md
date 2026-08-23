# Deploying Steal the Brainrot to a public HTTPS URL

You need one public link that a stranger can open and immediately play. There
are two ways to get one; both end with a real HTTPS domain.

| | **Node host** | Static host |
| --- | --- | --- |
| **PLAY (real 1v1)** | **yes** | **no** |
| **Play with a friend** (room codes) | **yes** | **no** |
| **World leaderboard** (everyone's scores) | **yes** | **no** — local scores only |
| Practice vs bot | yes | yes |
| Effort | connect a repo, ~5 minutes | drag-and-drop, ~2 minutes |
| Cost | free tier | free |
| Hosts | Render, Railway, Fly.io, Koyeb | Netlify, Cloudflare Pages, Vercel, GitHub Pages |

> **GitHub Pages is a static host.** It can serve the game but never the
> relay or the leaderboard — there is no process to run them in. Pair it
> with a Node host, or use a Node host for both.

**Use the Node host.** `PLAY` matches you against another real person, and that
needs the matchmaking relay, which is a WebSocket server. A static host cannot
run one, so on a static host `PLAY` has nothing to queue against and says so;
only the PRACTICE button works there.

The server in this repo is all of it at once — it serves the game, runs the
relay, hands out friend-room codes and keeps the world leaderboard — so "deploy
the Node host" is one service, not four.

---

## Build it

```bash
node tools/build.mjs --single
```

That writes `dist/`:

```
dist/
  index.html            the game (loads the two files below)
  bundle.js             all 25 modules, one file
  styles.css
  standalone.html       the entire game in ONE file, zero requests
  favicon.ico  apple-touch-icon.png  cover.jpg
  robots.txt  _headers  netlify.toml  vercel.json
```

`dist/` is completely self-contained: no CDNs, no fonts, no analytics, no
external requests of any kind.

---

## Option A — static host (no real multiplayer)

> Only pick this if you cannot run Node. `PLAY` will report that matchmaking is
> unavailable and only PRACTICE will work. Build it with:
>
> ```bash
> node tools/build.mjs --single --relay=off
> ```


### Netlify (drag and drop, no account gymnastics)
1. Run `node tools/build.mjs --single --relay=off`.
2. Open <https://app.netlify.com/drop>.
3. Drag the **`dist` folder** onto the page.
4. You get `https://<random-name>.netlify.app` immediately. Rename it under
   *Site configuration → Change site name*, or attach your own domain under
   *Domain management*.

### Cloudflare Pages
1. `npx wrangler pages deploy dist --project-name steal-the-brainrot`
2. Gives you `https://steal-the-brainrot.pages.dev`.

### Vercel
1. `npx vercel deploy dist --prod`

### GitHub Pages (automated — `.github/workflows/pages.yml` is already here)

**Read this first: GitHub Pages cannot host the server.** Pages serves static
files. It has no process, so it cannot hold a WebSocket open and cannot answer
`/api`. On Pages alone you get PRACTICE VS BOT and nothing else — no real 1v1,
no friend rooms, no world leaderboard.

There is a workflow in the repo that builds and publishes on every push to
`main`:

1. Push this folder to a GitHub repo.
2. Settings → Pages → **Source: GitHub Actions**.
3. Push. You land on `https://<user>.github.io/<repo>/`.

Sub-path hosting works as-is — every path in the game is relative, and the
workflow drops a `.nojekyll` so `_headers` is not swallowed by Jekyll.

The workflow runs `check.mjs` and `mapcheck.mjs` before it builds, so a broken
commit never reaches Pages.

#### Getting multiplayer while still using Pages

Host the *game* on Pages and the *server* somewhere that can run Node, then
point one at the other. Run `server/server.js` on Fly.io (see Option B), then
set two repository **variables** under
Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
| --- | --- |
| `RELAY_URL` | `wss://your-app.fly.dev/ws` |
| `LEADERBOARD_URL` | `https://your-app.fly.dev/api` |

Push again and the Pages build bakes those in. `/api` sends
`access-control-allow-origin: *` and answers preflight, so the cross-origin
leaderboard works; WebSockets are not subject to CORS at all.

Leave the variables unset and the build honestly reports multiplayer as off
rather than opening a socket that cannot exist.

> Simpler alternative: skip Pages and let Fly or Render serve the game *and*
> the relay from the one process (Option B). Same GitHub repo, one deploy,
> one origin, nothing to wire together.

### Any other host / your own server
Upload the contents of `dist/` to any folder that is served over HTTPS. It
works from the domain root **or** a subfolder (`https://example.com/my-game/`).
If you want the absolute simplest thing, upload only `standalone.html` and
rename it `index.html` — that single file is the whole game.

---

## Option B — Node host (this is the one you want)

The included server does every job at once, with zero dependencies:

| Route | What it is |
| --- | --- |
| `/` | the game itself |
| `/ws` | matchmaking relay + friend rooms (WebSocket) |
| `GET /api/top?limit=25` | the world leaderboard |
| `POST /api/score` | submit a score to it |

### Cloudflare Workers (free plan, no card)

An alternative to the Node host, in `worker/` + `wrangler.toml`. The relay
runs as a Durable Object so every waiting player shares one queue, and the
world leaderboard lives in that object's SQLite - durable with no volume to
provision. Workers gives real WebSockets, so the hand-rolled RFC 6455 code is
not used at all on this path.

```
npm run build
npx wrangler login
npm run worker:deploy
```

Verify a local run with `npm run worker:dev` in one terminal and
`npm run workercheck` in another.

### Fly.io — recommended (free, keeps the leaderboard, no GitHub needed)

The only free tier that gives you a persistent disk, and it deploys straight
from this folder — you never have to create a repo.

```bash
fly auth login
fly launch --no-deploy
fly volumes create brainrot_data --size 1
fly deploy
```

`fly launch` will ask to overwrite `fly.toml` — say **no**, the one here is
already configured with the `/data` mount and `DATA_DIR`. Change `app` at the
top of `fly.toml` to a name nobody has taken first.

You end up on `https://<your-app>.fly.dev` with HTTPS, WSS, real 1v1, friend
codes, and a world leaderboard that survives redeploys.

### Render
1. Push this folder to a GitHub repo.
2. Render → **New → Web Service** → pick the repo. `render.yaml` is already
   here, so it fills in:
   - Build: `node tools/build.mjs`  (defaults to real matchmaking)
   - Start: `node server/server.js --root dist`
3. Deploy. You get `https://<name>.onrender.com`, HTTPS and WSS included.

Everything works on the free plan **except** leaderboard persistence — Render's
free filesystem is wiped on every redeploy, and disks need a paid instance. To
keep the board, upgrade, then uncomment the `disk:` and `DATA_DIR` blocks in
`render.yaml`. If you want a persistent board for free, use Fly.io above.

> Render's free tier sleeps after inactivity, so the very first visit can take
> ~30s to wake. If a reviewer might hit a cold start, use a paid instance or
> Fly.io, or ship the static build instead.

### Railway / Koyeb
Connect the repo; both auto-detect the `Procfile`.

### Docker (anywhere)
```bash
docker build -t brainrot .
docker run -p 8080:8080 brainrot
```

Put it behind any HTTPS terminator. **Your proxy must forward WebSocket
upgrades** on `/ws` — nginx needs:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

---

## Making the world leaderboard survive a redeploy

The board lives in one JSON file: `$DATA_DIR/leaderboard.json` (default
`./data/`). It holds the top 200 players, one row each, best score kept, and is
rewritten within a second of any change — so a crash or a hard restart loses at
most a second of scores.

**The catch:** most free tiers give you an *ephemeral* filesystem. The file
survives restarts but is wiped on every redeploy, so your world board silently
resets to empty each time you push. To keep it, point `DATA_DIR` at storage that
persists:

| Host | What to do |
| --- | --- |
| **Render** | Upgrade off the free plan, then uncomment the `disk:` and `DATA_DIR` blocks in `render.yaml`. (Free plans cannot have disks; adding one fails the deploy.) |
| **Fly.io** | Already configured in `fly.toml`. Just run `fly volumes create brainrot_data --size 1` before your first deploy. |
| **Railway** | Add a volume, mount at `/data`, set `DATA_DIR=/data`. |
| **Docker / your own box** | `docker run -p 8080:8080 -e DATA_DIR=/data -v brainrot:/data brainrot` |

Skip this and everything still works — the board just starts fresh after each
deploy. Scores are always written to the player's own device too, so nobody
loses their personal best either way.

The board is rate-limited to 40 submissions per hour per address and rejects
anything above 2000 points, which is well past what a 60-second round can
produce. It is a friendly scoreboard, not an anti-cheat system: the score is
reported by the client, so a determined person can lie to it. Treat it as fun,
not as a ranked ladder.

---

## Playing with a friend on purpose

No hosting work — it comes with the Node host. In the menu, **PLAY WITH A
FRIEND**:

- One of you taps **CREATE A ROOM** and reads out the 4-character code.
- The other types it in and taps **JOIN**.

Codes are single-use, expire after 15 minutes, and skip the public queue
entirely, so you always land with the person you meant to. Codes avoid the
lookalike glyphs (no `O`/`0`, no `I`/`1`), so they are safe to read aloud.

This needs the relay, so it is Node-host only — on a static build the button
explains that multiplayer is off.

---

## The one setting you may want to change

`index.html` (and `dist/index.html`) contains a single config line. Edit it
directly on the deployed file — no rebuild needed:

```html
<script>window.STB_CONFIG = { relay: "auto", leaderboard: "auto", dev: false };</script>
```

| `relay` | Effect |
| --- | --- |
| `"auto"` | **Default.** `PLAY` matches real players via `wss://<this page's host>/ws`. Correct whenever `server/server.js` is serving the page. |
| `"wss://relay.example.com/ws"` | Real players via a relay on a different host. |
| `""` | No multiplayer. `PLAY` reports that matchmaking is off; only PRACTICE works. |

| `leaderboard` | Effect |
| --- | --- |
| `"auto"` | **Default.** World board via `/api` on this page's host. Correct whenever `server/server.js` is serving the page. |
| `"https://api.example.com"` | World board on a different host. |
| `""` | No world board. LEADERBOARD shows the player's own scores from this device. |

`dev: true` (or `?dev=1` on the URL) reveals the developer rows in Settings —
relay URL, connection test, FPS. Leave it `false` in production.

The Docker/Render/Fly builds already pass `--relay=auto`, so online is on.

---

## What a lone visitor sees

This matters for the Playables reviewer, who will be the only person on the site.

`PLAY` always means a real person. It never quietly substitutes a bot.

- **Queue empty** → it keeps queueing, showing your position and a running
  timer. After 25 seconds a small secondary link appears offering the practice
  bot *while you wait* — labelled "this is not a real opponent". The search
  keeps running; nothing happens unless the player taps it.
- **Relay unreachable** → "CAN'T REACH THE SERVER", with the same secondary
  practice link. It does not dead-end and it does not pretend.
- **No relay configured** → "MULTIPLAYER IS OFF".

So a reviewer alone on the site sees an honest queue and can choose the bot
deliberately. If you would rather they never see the bot offer at all, delete
the `_soloTimer` line in `src/ui/ui.js` → `showSearch()`.

**To actually test real 1v1: open the URL in two tabs and press PLAY in both.**

---

## Verifying your deployment

Open the URL in a fresh private window and check:

- [ ] The loading bar completes and the menu appears (should be well under 5s).
- [ ] Open the URL in **two tabs**, press `PLAY` in both → they find each other.
- [ ] In one tab alone, `PLAY` keeps queueing (it must not hand you a bot).
- [ ] DevTools console is empty — no errors, no 404s.
- [ ] Resize the window narrow and wide mid-match; the camera adapts and the
      score keeps running.
- [ ] Refresh mid-match: you land back on the menu with coins/level intact.
- [ ] On a phone: joystick bottom-left; 🦵/🍌/👑/💨 stacked bottom-right with
      live cooldown rings.
- [ ] On a phone, hold the joystick with one thumb and tap an ability with the
      other — you must keep moving while it fires.
- [ ] Get next to the Brainrot holder: the big 🧠 **STEAL!** button appears, and
      disappears again when you move away.
- [ ] Rotate the phone to landscape mid-match; the controls rearrange and the
      score keeps running.

There is also a self-check you can run before deploying:

```bash
node tools/check.mjs       # modules, simulation, config, storage
node tools/playcheck.mjs   # two players press PLAY and get each other
node tools/netcheck.mjs    # a full 60s round over the real relay
```

---

## If you go on to full Playables certification

The consideration form only needs the URL above. If you are accepted and move
to certification, the SDK integration is already written and one flag away:

```bash
node tools/build.mjs --relay=auto --playables
```

That adds the `https://www.youtube.com/game_api/v1` script tag. `src/core/platform.js`
already calls `firstFrameReady()`, `gameReady()`, `onPause()`, `onResume()` and
follows YouTube's mute state, and `src/core/storage.js` already prefers
`ytgame.game.saveData/loadData` for cloud saves. Every call is a no-op when the
SDK is absent, so the same build runs on your own domain too.

Where the game already sits against the published requirements:

| Requirement | Status |
| --- | --- |
| Interactive in under 5s | ~0.5s on desktop |
| Initial bundle under 30 MiB (ideally 15) | 0.39 MiB |
| Every file under 512 KiB | largest is `bundle.js`, 297 kB |
| Save data under 3 MiB | a few kB of JSON |
| All aspect ratios 9:32 → 32:9 | verified at both extremes |
| State survives a resize | verified mid-match |
| Relative paths only | no absolute paths anywhere |
| Touch + mouse everywhere | yes; keyboard and gamepad too |
| Esc closes modals, no `preventDefault` | yes |
| No external links, logins or agreements | none |

One thing to decide before certification: online 1v1 talks to your own relay
over WebSocket. Google's published requirements do not spell out a policy on
third-party runtime connections, so confirm it with them during review. If they
say no, ship with `relay: ""` — the whole single-player game, progression,
collection and customisation work with no network at all.
