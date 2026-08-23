/* ============================================================
   studio.js - a tiny offscreen renderer used by the menus.

   One extra WebGL context renders collection thumbnails (cached as
   data URLs, generated a few per frame so opening the collection
   never blocks) and drives the live customise preview.
   ============================================================ */

import * as m4 from './m4.js';
import { Renderer, Camera } from './gl.js';
import { getBrainrotMesh, getPlayerMesh } from './models.js';
import { hex } from '../core/util.js';

export class Studio {
  constructor(size = 192) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.canvas.style.cssText = 'position:absolute;left:-9999px;top:0;width:' + size + 'px;height:' + size + 'px';
    document.body.appendChild(this.canvas);
    this.ok = true;
    try {
      this.renderer = new Renderer(this.canvas);
    } catch (_) {
      this.ok = false;
      return;
    }
    this.renderer.maxDpr = 1;
    this.renderer.resize(true);
    this.renderer.env.clear = hex('#2a1044');
    this.renderer.env.fogRange = [40, 120];
    this.cam = new Camera();
    this.cam.dist = 4.4;
    this.cam.pitch = 0.34;
    this.cam.fov = 0.72;
    this.cam.target = [0, -0.05, 0];
    this.cam.lookLift = 0;      // portraits aim straight at the subject
    this._m = m4.create();
    this.cache = new Map();
    this.queue = [];
    this._pumping = false;
  }

  _frame(drawFn, yaw = 0.5) {
    const r = this.renderer;
    this.cam.yaw = yaw;
    this.cam.update(0.016, 1);
    r.begin(this.cam);
    drawFn(r, this.cam);
  }

  /** synchronous single shot -> data URL (cached) */
  brainrotShot(id, variant = '') {
    if (!this.ok) return null;
    const key = 'b:' + id + variant;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const mesh = getBrainrotMesh(this.renderer.gl, id, variant);
    this.cam.dist = 3.9; this.cam.pitch = 0.3;
    this._frame((r) => {
      m4.compose(0, 0, 0, 0, 0.55, 0, 1.5, 1.5, 1.5, this._m);
      r.outline(mesh, this._m, 0.05);
      r.draw(mesh, this._m);
    }, 0.42);
    const url = this.canvas.toDataURL('image/webp', 0.72);
    this.cache.set(key, url);
    return url;
  }

  /** cosmetic item preview: a default body wearing/holding the item */
  itemShot(slot, id, baseLoadout) {
    if (!this.ok) return null;
    const key = 's:' + slot + ':' + id;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const lo = { ...baseLoadout, [slot]: id };
    if (slot === 'trail' || slot === 'emote' || slot === 'victory' || slot === 'plate') {
      // not a wearable - fall back to a neutral body so cards stay uniform
      lo.skin = baseLoadout.skin;
    }
    const mesh = getPlayerMesh(this.renderer.gl, lo);
    this.cam.dist = 4.2; this.cam.pitch = 0.24;
    this._frame((r) => {
      m4.compose(0, -0.15, 0, 0, 0.5, 0, 1.15, 1.15, 1.15, this._m);
      r.outline(mesh, this._m, 0.05);
      r.draw(mesh, this._m);
    }, 0.36);
    const url = this.canvas.toDataURL('image/webp', 0.72);
    this.cache.set(key, url);
    return url;
  }

  /** live animated preview drawn straight onto a visible 2D canvas */
  drawPreview(destCanvas, loadout, t) {
    if (!this.ok || !destCanvas) return;
    const mesh = getPlayerMesh(this.renderer.gl, loadout);
    this.cam.dist = 4.5;
    this.cam.pitch = 0.26;
    const bob = Math.sin(t * 2.4) * 0.06;
    this._frame((r) => {
      m4.compose(0, -0.18 + bob, 0, 0, 0, 0, 1.15, 1.15 + bob * 0.2, 1.15, this._m);
      r.outline(mesh, this._m, 0.05);
      r.draw(mesh, this._m);
    }, t * 0.55);

    const w = destCanvas.clientWidth || 240, h = destCanvas.clientHeight || 190;
    if (destCanvas.width !== w || destCanvas.height !== h) { destCanvas.width = w; destCanvas.height = h; }
    const ctx = destCanvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    // Fit inside the area above the nameplate strip. The rendered square
    // already carries ~15% padding, so a small zoom fills the panel without
    // pushing the character's feet off the bottom edge.
    const LABEL = 26;
    const s = Math.min(w, (h - LABEL) * 1.19);
    ctx.drawImage(this.canvas, (w - s) / 2, (h - LABEL - s) / 2, s, s);
  }

  dispose() {
    this.canvas.remove();
    this.cache.clear();
  }
}
