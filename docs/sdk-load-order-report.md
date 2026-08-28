# Test Suite reports "SDK loaded before any game code" for Google's own sample

## Summary

The Playables Test Suite check **"SDK loaded before any game code"** fails for
`google/web-game-samples/plain-html-js-css` when that sample is served
unmodified from a public HTTPS host. The same check fails for our game. Every
other MUST and SHOULD passes for both.

Because the failure reproduces on Google's own reference implementation, this
looks like a problem with the check rather than with either game.

## Reproduce

Both URLs are the same static host, same CDN, same response headers. Only the
page differs.

Serve `plain-html-js-css` from `google/web-game-samples` unmodified on any
public HTTPS host and point the Test Suite at it.

We reproduced this by hosting it alongside our own game, on the same static
host with identical response headers - so the page was the only variable. That
copy has since been taken down, because Google's sample has no business sitting
inside a submission package, but it is two minutes to stand up again: the
sample is four files and needs no build step.

Our game is at `https://steal-the-brainrot.onrender.com`.

**Expected:** MUST 6/6 — it is the reference implementation.
**Actual:** MUST 5/6, with "SDK loaded before any game code" failing.

Test Suite log line:

```
SDK script was not loaded before any game code
```

## The sample's markup, as published

```html
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="ie=edge">
  <title>YouTube Playable Sample - Plain HTML/JS/CSS</title>
  <link rel="stylesheet" href="main.css">
  <!-- Load the YouTube Playables SDK as the first script on the page. -->
  <script src="https://www.youtube.com/game_api/v1"></script>
  <!-- Load the game script. -->
  <script src="main.js"></script>
</head>
```

The SDK is the first script in the document, exactly as
`reference/getting_started` requires.

## What we ruled out on our own game

Before testing the sample we tried, and measured, each of these. None moved the
check:

1. SDK tag moved to the first script in `<head>`.
2. SDK tag hoisted above `<meta charset>`.
3. Bundle switched from `defer` to synchronous, matching the sample. This cost
   2.8s of load time (1.657s to 4.44s as measured by the Test Suite itself)
   and was reverted.
4. Inline config script removed, so the document held only two scripts.
5. Stylesheet inlined and icon files dropped, leaving the SDK as the only
   external reference in the markup.
6. Bundle attached dynamically after `system.getLanguage()` resolved, so it
   was not requested until the SDK had answered a call.
7. Bundle inlined entirely. The page then fetched exactly one resource - the
   SDK - confirmed with `performance.getEntriesByType('resource')` returning a
   single entry. The check still failed.

Step 7 is the significant one: with no game-code resource at all, there is
nothing that could load before the SDK, and the check still reports that
something did.

## The parser demonstrably waits for the SDK

Our page is now a single file: the SDK tag, then the whole game in one inline
`<script>`. A classic `<script src>` blocks the parser, so the inline block
cannot begin until the SDK has been fetched and executed. We measured that
rather than assuming it - the inline block's first statement records what it
can see:

```js
window.__probe = {
  atInlineParse: typeof window.ytgame,
  sdkVersion: (window.ytgame && window.ytgame.SDK_VERSION) || null,
  resourcesSoFar: performance.getEntriesByType('resource').map((r) => r.name),
  tParse: performance.now()
};
```

Six cache-busted loads against the real SDK endpoint, Chrome:

```
object / 1.20260824.0100 / t=267
object / 1.20260824.0100 / t=260
object / 1.20260824.0100 / t=262
object / 1.20260824.0100 / t=264
object / 1.20260824.0100 / t=260
object / 1.20260824.0100 / t=273
```

`window.ytgame` is populated, with a version string, before the first byte of
game code runs. The ~260 ms is the parser blocking on the SDK's 302 and its
65 kB download. `resourcesSoFar` holds exactly one entry, the SDK itself.

There is no ordering left to get wrong: at the moment game code first runs, the
SDK is loaded, and no other resource has been fetched at all.

## Note on the mechanism

The SDK installs a resource observer:

```js
new PerformanceObserver(...).observe({ type: "resource", buffered: true })
```

It forwards each entry to the host, skipping `youtube.com/game_api` URLs.
`buffered: true` replays entries already in the performance buffer when the
observer starts, which is what led us to remove every other resource from the
page. That did not change the result, so the check appears to be measuring
something else, or to be reporting unconditionally.

## Environment

- Chrome, Windows 11
- Host: Render static site, HTTPS
- Response headers on both pages: `content-type: text/html; charset=utf-8`,
  `x-content-type-options: nosniff`. No CSP, no `X-Frame-Options`.
- Verified against the CSP from the Test Suite guide, served locally: no
  violations, game boots and plays.
- Google's bundle analyzer on our package: 0 issues.
