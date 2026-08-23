/* ============================================================
   devkit.js - browser-side test harness. NOT part of the game.

   Load it from the console (or an automation tool) with:
     await import('/tools/devkit.js')

   It provides:
     __run(seconds, speed)  drive real frames without requestAnimationFrame
     __shot(name)           save the WebGL canvas to tools/shots/
     __full(name)           save canvas + DOM composited together
     __autoPlay()           give the local player a scripted brain
     __playRound(opts)      practice match -> N seconds -> screenshots
   The server must be running with --dev for the screenshot sink.
   ============================================================ */

const $ = (id) => document.getElementById(id);
let CSS = '';

const OVERRIDE = `
  #ui,.screen,#boot,#fx-flash{position:absolute !important}
  html,body{overflow:visible}
  .screen{display:none}.screen.show{display:flex !important}
  *{animation:none !important;transition:none !important}`;

async function loadCss() {
  if (!CSS) CSS = await (await fetch('/styles.css')).text();
  return CSS;
}

async function post(name, dataUrl) {
  const r = await fetch('/_devshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, data: dataUrl }),
  });
  return (await r.json()).ok;
}

/** raw WebGL canvas only */
export async function shot(name, scale = 0.5) {
  const gl = $('gl');
  const w = Math.round(gl.width * scale), h = Math.round(gl.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(gl, 0, 0, w, h);
  return post(name, c.toDataURL('image/png'));
}

/**
 * WebGL canvas with the DOM UI composited on top via an SVG foreignObject.
 * Text is rasterised by the SVG renderer, so colours are approximate -
 * use it to check LAYOUT, and computed styles to check colour.
 */
export async function full(name, scale = 0.5) {
  await loadCss();
  const gl = $('gl');
  const W = gl.clientWidth, H = gl.clientHeight;
  const w = Math.round(W * scale), h = Math.round(H * scale);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(gl, 0, 0, w, h);

  const src = $('ui').hidden ? $('boot') : $('ui');
  const wrap = document.createElement('div');
  wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrap.style.cssText = `width:${W}px;height:${H}px;position:relative;overflow:hidden`;
  const st = document.createElement('style');
  st.textContent = CSS.replace(/env\([^)]*\)/g, '0px') + OVERRIDE;
  wrap.appendChild(st);

  const clone = src.cloneNode(true);
  clone.removeAttribute('hidden');
  clone.querySelectorAll('canvas').forEach((c) => c.replaceWith(document.createElement('span')));
  // XML comments cannot contain "--" and index.html is full of ---- rules
  const tw = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const dead = []; while (tw.nextNode()) dead.push(tw.currentNode);
  dead.forEach((n) => n.remove());
  wrap.appendChild(clone);

  const xml = new XMLSerializer().serializeToString(wrap);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
    `<foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
  const img = new Image();
  let err = null;
  try {
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('svg rasterise failed'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    ctx.drawImage(img, 0, 0, w, h);
  } catch (e) { err = String(e); }
  await post(name, out.toDataURL('image/png'));
  return err;
}

/** Drive real frames. rAF is dead in a hidden tab, so we call step() ourselves. */
export async function run(seconds, speed = 1) {
  const dt = speed / 60;
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) {
    globalThis.__stb.step(dt);
    if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));   // let the loopback deliver
  }
  return summary();
}

export function summary() {
  const a = globalThis.__stb;
  if (!a.session) return { screen: a.ui.current, mode: a.mode };
  const s = a.session.sim;
  return {
    screen: a.ui.current, t: +s.t.toFixed(1), phase: s.phase, left: +s.timeLeft.toFixed(1),
    score: [s.players[0].score, s.players[1].score],
    steals: [s.players[0].steals, s.players[1].steals],
    hits: [s.players[0].dashHits, s.players[1].dashHits],
    hold: [+s.players[0].holdTime.toFixed(1), +s.players[1].holdTime.toFixed(1)],
    owner: s.br.owner, event: s.ev.id, events: s.eventsSeen,
    camDist: +a.view.cam.dist.toFixed(1), draws: a.view.renderer.stats.draws,
  };
}

/** Replace the human with a scripted player so rounds actually play out. */
export function autoPlay(on = true) {
  const a = globalThis.__stb, s = a.session;
  if (!s) throw new Error('no session');
  if (!on) { s.readInput = () => a.input.read(); return; }
  s.readInput = () => {
    const sim = s.sim, me = sim.players[a.localIdx], foe = sim.players[1 - a.localIdx];
    let tx, tz;
    if (sim.br.owner === 1 - a.localIdx) { tx = foe.x; tz = foe.z; }
    else if (sim.br.owner === a.localIdx) { tx = me.x - (foe.x - me.x) * 2; tz = me.z - (foe.z - me.z) * 2; }
    else { tx = sim.br.x; tz = sim.br.z; }
    let dx = tx - me.x, dz = tz - me.z;
    const d = Math.hypot(dx, dz) || 1;
    const near = Math.hypot(foe.x - me.x, foe.z - me.z);
    return {
      x: dx / d, z: dz / d,
      dash: me.dashCd <= 0 && near < 3.6 && sim.br.owner !== a.localIdx,
      taunt: false,
    };
  };
}

/** practice match -> play -> screenshot */
export async function playRound({ seconds = 20, speed = 4, name = 'round' } = {}) {
  const a = globalThis.__stb;
  a.ui.emit('practice');
  for (let i = 0; i < 60 && !a.session; i++) await new Promise((r) => setTimeout(r, 100));
  if (!a.session) throw new Error('match never started');
  autoPlay(true);
  await run(seconds, speed);
  await full(name);
  return summary();
}

Object.assign(globalThis, {
  __shot: shot, __full: full, __run: run, __autoPlay: autoPlay,
  __playRound: playRound, __summary: summary,
});
console.info('[devkit] ready: __run __shot __full __autoPlay __playRound __summary');
