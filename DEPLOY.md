# Deploying Steal the Brainrot

The build produces exactly one file:

```
dist/
  index.html      the entire game - markup, styles, all 24 modules
```

Nothing else. No `bundle.js`, no stylesheet, no icons, no config files. The
page names a single external resource, the Playables SDK on
`www.youtube.com`, and fetches nothing else at any point - no CDNs, no fonts,
no analytics, no API.

That is a deliberate constraint, not a size optimisation. A YouTube Playable
is not permitted to call out, so the game has no relay, no world leaderboard
and no server side of any kind. Progress lives in the Playables cloud save
when the game runs inside YouTube, and in `localStorage` when it does not.

```bash
node tools/build.mjs
```

Run `npm run checkall` to build and then run all 32 checks. Do it in that
order - the audit reads the emitted page, so it has nothing to inspect until
the build has run.

---

## Deploying it

Any static host works, and the whole job is "serve one HTML file over HTTPS".
Use a **static** host, not a Node one: free Node instances sleep after a few
minutes idle and take the better part of a minute to wake, and that cold start
is what a reviewer opening your link would sit through.

### Render (the primary URL)

`render.yaml` is already configured as a static site, so Render fills
everything in:

1. Push to a GitHub repo.
2. Render → **New → Static Site** → pick the repo.
3. Deploy. You land on `https://<name>.onrender.com`.

Free, no card, no instance hours, and static sites do not spin down.

### GitHub Pages (a free second URL)

`.github/workflows/pages.yml` builds and publishes on every push to `main`.
Turn it on under Settings → Pages → **Source: GitHub Actions**. Sub-path
hosting works as-is; every path in the game is relative.

### Anything else

Drag the `dist` folder onto <https://app.netlify.com/drop>, or
`npx wrangler pages deploy dist`, or `npx vercel deploy dist --prod`, or copy
`dist/index.html` onto any HTTPS server you already have. There is one file to
move and no build step on the far end.

---

## Looking at it locally

`server/server.js` is a static file server with no API, no sockets and no
state. It exists so you can open the built game without deploying it.

```bash
npm start          # serve dist/ on http://localhost:8080
npm run start:csp  # ...with YouTube's exact Content-Security-Policy applied
npm run start:mock # ...with a fake Playables host, so SDK paths actually run
```

`start:csp` is worth using before you submit: it serves the page under the
same policy YouTube does, so a violation shows up in your console now rather
than in certification.

`start:mock` swaps the real SDK for `tools/ytgame-mock.js`. The real SDK is
deliberately inert outside YouTube - `IN_PLAYABLES_ENV` is false and every
call is a no-op - so cloud save, pause and resume, the audio callback and both
ad types are never exercised during normal development. The mock implements
the documented API and adds buttons for the events the host would otherwise
send. It is served from `tools/`, never copied into `dist/`, and only when
that flag is passed.

---

## Submitting to YouTube Playables

The build already satisfies the technical requirements: one HTTPS origin, the
SDK loaded as the first script, no external calls, no copyrighted assets, and
`firstFrameReady` / `gameReady` signalled at the right moments.

One check in the Playables Test Suite, **"SDK loaded before any game code"**,
reports a failure. It also fails for Google's own
`plain-html-js-css` sample served unmodified from the same host, which is what
`docs/sdk-load-order-report.md` documents. Everything else passes.
