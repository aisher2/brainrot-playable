/* ============================================================
   gl.js - a small WebGL1 toon renderer.

   Deliberately tiny: one shader program, one vertex format,
   inverted-hull outlines, blob shadows, distance fog. No
   post-processing (it is the first thing that dies on low-end
   mobile), no shadow maps, no texture loads at all.
   ============================================================ */

import * as m4 from './m4.js';
import { hex, clamp01 } from '../core/util.js';

const VERT = `
precision mediump float;
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 aCol;
attribute vec3 aFlg;      // x=emissive y=metal z=alpha

uniform mat4 uVP;
uniform mat4 uModel;
uniform float uOutline;   // >0 -> inflate along normal
uniform vec3 uCam;

varying vec3 vNrm;
varying vec3 vCol;
varying vec3 vFlg;
varying vec3 vWorld;

void main(){
  vec3 pos = aPos + aNrm * uOutline;
  vec4 world = uModel * vec4(pos, 1.0);
  vWorld = world.xyz;
  vNrm = mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz) * aNrm;
  vCol = aCol;
  vFlg = aFlg;
  gl_Position = uVP * world;
}`;

const FRAG = `
precision mediump float;
varying vec3 vNrm;
varying vec3 vCol;
varying vec3 vFlg;
varying vec3 vWorld;

uniform vec4 uTint;       // rgb multiply + alpha multiply
uniform vec3 uAdd;        // additive flash (hit / golden)
uniform float uMode;      // 0 shaded, 1 outline, 2 unlit
uniform vec3 uLight;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uFogCol;
uniform vec2 uFogRange;
uniform vec3 uCam;
uniform vec3 uLineCol;

void main(){
  float alpha = vFlg.z * uTint.a;
  if (uMode > 1.5) {                       // unlit (particles, shadows, decals)
    vec3 c = vCol * uTint.rgb + uAdd;
    gl_FragColor = vec4(c, alpha);
    return;
  }
  if (uMode > 0.5) {                       // outline hull
    gl_FragColor = vec4(uLineCol, alpha);
    return;
  }

  vec3 N = normalize(vNrm);
  vec3 V = normalize(uCam - vWorld);
  vec3 base = vCol * uTint.rgb;

  float nl = dot(N, uLight);
  float band = nl > 0.42 ? 1.0 : (nl > -0.08 ? 0.76 : 0.58);
  vec3 col = base * band;

  // hemisphere ambient: sky above, bounced ground below
  vec3 amb = mix(uGround, uSky, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  col += base * amb * 0.42;

  // toon specular for metals
  if (vFlg.y > 0.01) {
    vec3 H = normalize(uLight + V);
    float s = pow(max(dot(N, H), 0.0), 24.0);
    col += vec3(step(0.35, s)) * vFlg.y * 0.85;
  }

  // rim light keeps silhouettes readable against the arena
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += rim * 0.30 * mix(vec3(1.0), base + 0.5, 0.5);

  // emissive parts ignore lighting
  col = mix(col, base * 1.25 + 0.18, clamp(vFlg.x, 0.0, 1.0));

  col += uAdd;

  float d = distance(uCam, vWorld);
  float f = clamp((d - uFogRange.x) / max(0.001, uFogRange.y - uFogRange.x), 0.0, 1.0);
  col = mix(col, uFogCol, f * 0.9);

  gl_FragColor = vec4(col, alpha);
}`;

/* ------------------------------------------------------------ */

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

export class Mesh {
  constructor(gl, data, dynamic = false) {
    this.gl = gl;
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    this.count = 0;
    this.dynamic = dynamic;
    this.u32 = false;
    this.bounds = data ? data.bounds : { minY: 0, maxY: 1, r: 1 };
    if (data) this.upload(data);
  }

  upload(data) {
    const gl = this.gl;
    const n = data.pos.length / 3;
    const inter = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) {
      const o = i * 12, p = i * 3;
      inter[o] = data.pos[p]; inter[o + 1] = data.pos[p + 1]; inter[o + 2] = data.pos[p + 2];
      inter[o + 3] = data.nrm[p]; inter[o + 4] = data.nrm[p + 1]; inter[o + 5] = data.nrm[p + 2];
      inter[o + 6] = data.col[p]; inter[o + 7] = data.col[p + 1]; inter[o + 8] = data.col[p + 2];
      inter[o + 9] = data.flg[p]; inter[o + 10] = data.flg[p + 1]; inter[o + 11] = data.flg[p + 2];
    }
    const usage = this.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, inter, usage);

    this.u32 = n > 65535;
    const idx = this.u32 ? new Uint32Array(data.idx) : new Uint16Array(data.idx);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, usage);
    this.count = data.idx.length;
    this.bounds = data.bounds || this.bounds;
    return this;
  }

  dispose() {
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteBuffer(this.ibo);
    this.count = 0;
  }
}

/** A mesh you rewrite every frame (particles, ribbons). */
export class DynamicMesh {
  constructor(gl, maxVerts = 4096) {
    this.gl = gl;
    this.max = maxVerts;
    this.data = new Float32Array(maxVerts * 12);
    this.idx = new Uint16Array(Math.floor(maxVerts * 1.5));
    this.vbo = gl.createBuffer();
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx.byteLength, gl.DYNAMIC_DRAW);
    this.v = 0; this.i = 0;
    this.u32 = false;
    this.bounds = { minY: 0, maxY: 0, r: 0 };
  }
  reset() { this.v = 0; this.i = 0; }
  /** push one quad (4 verts, 2 tris) */
  quad(p0, p1, p2, p3, col, alpha, emissive = 0) {
    if (this.v + 4 > this.max) return;
    const d = this.data;
    const pts = [p0, p1, p2, p3];
    for (let k = 0; k < 4; k++) {
      const o = (this.v + k) * 12, p = pts[k];
      d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2];
      d[o + 3] = 0; d[o + 4] = 1; d[o + 5] = 0;
      d[o + 6] = col[0]; d[o + 7] = col[1]; d[o + 8] = col[2];
      d[o + 9] = emissive; d[o + 10] = 0; d[o + 11] = alpha;
    }
    const b = this.v;
    this.idx[this.i++] = b; this.idx[this.i++] = b + 1; this.idx[this.i++] = b + 2;
    this.idx[this.i++] = b; this.idx[this.i++] = b + 2; this.idx[this.i++] = b + 3;
    this.v += 4;
  }
  commit() {
    const gl = this.gl;
    if (!this.i) { this.count = 0; return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data.subarray(0, this.v * 12));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.idx.subarray(0, this.i));
    this.count = this.i;
  }
}

/* ------------------------------------------------------------ */

const IDENT = m4.create();

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const attrs = {
      alpha: false, antialias: true, depth: true, stencil: false,
      premultipliedAlpha: false, powerPreference: 'high-performance',
      preserveDrawingBuffer: false, desynchronized: true,
      failIfMajorPerformanceCaveat: false,
    };
    let gl = canvas.getContext('webgl2', attrs);
    this.isGL2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    if (!this.isGL2) gl.getExtension('OES_element_index_uint');

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);

    this.a = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      nrm: gl.getAttribLocation(prog, 'aNrm'),
      col: gl.getAttribLocation(prog, 'aCol'),
      flg: gl.getAttribLocation(prog, 'aFlg'),
    };
    const U = (n) => gl.getUniformLocation(prog, n);
    this.u = {
      VP: U('uVP'), model: U('uModel'), outline: U('uOutline'), tint: U('uTint'),
      add: U('uAdd'), mode: U('uMode'), light: U('uLight'), sky: U('uSky'),
      ground: U('uGround'), fogCol: U('uFogCol'), fogRange: U('uFogRange'),
      cam: U('uCam'), lineCol: U('uLineCol'),
    };
    for (const k of ['pos', 'nrm', 'col', 'flg']) if (this.a[k] >= 0) gl.enableVertexAttribArray(this.a[k]);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.dpr = 1;
    this.maxDpr = 2;
    this.width = 1; this.height = 1;
    this.vp = m4.create();
    this.camPos = [0, 20, 20];
    this.env = {
      light: [0.42, 0.82, 0.38],
      sky: hex('#9d7cff'),
      ground: hex('#4a2a6b'),
      fog: hex('#2a0f43'),
      fogRange: [34, 90],
      line: hex('#180827'),
      clear: hex('#1a0a2b'),
    };
    this._blend = false;
    this._depthWrite = true;
    this.stats = { draws: 0, tris: 0 };
    this.resize();
  }

  setQuality(q) {
    // q: 0 (potato) .. 1 (full)
    this.maxDpr = q >= 1 ? 2 : q >= 0.6 ? 1.5 : 1;
    this.resize(true);
  }

  resize(force = false) {
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio || 1, this.maxDpr);
    const w = Math.max(2, Math.round(c.clientWidth * dpr));
    const h = Math.max(2, Math.round(c.clientHeight * dpr));
    if (!force && w === this.width && h === this.height) return false;
    c.width = w; c.height = h;
    this.width = w; this.height = h; this.dpr = dpr;
    this.gl.viewport(0, 0, w, h);
    return true;
  }

  get aspect() { return this.width / this.height; }

  /** @param cam {vp:mat4, pos:[x,y,z]} */
  begin(cam) {
    const gl = this.gl, u = this.u, e = this.env;
    gl.useProgram(this.prog);
    this.vp = cam.vp;
    this.camPos = cam.pos;
    gl.uniformMatrix4fv(u.VP, false, cam.vp);
    gl.uniform3fv(u.light, e.light);
    gl.uniform3fv(u.sky, e.sky);
    gl.uniform3fv(u.ground, e.ground);
    gl.uniform3fv(u.fogCol, e.fog);
    gl.uniform2fv(u.fogRange, e.fogRange);
    gl.uniform3fv(u.cam, cam.pos);
    gl.uniform3fv(u.lineCol, e.line);
    gl.clearColor(e.clear[0], e.clear[1], e.clear[2], 1);
    this.setBlend(false);
    this.setDepthWrite(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.stats.draws = 0; this.stats.tris = 0;
  }

  setBlend(on) {
    if (this._blend === on) return;
    this._blend = on;
    on ? this.gl.enable(this.gl.BLEND) : this.gl.disable(this.gl.BLEND);
  }
  setDepthWrite(on) {
    if (this._depthWrite === on) return;
    this._depthWrite = on;
    this.gl.depthMask(on);
  }
  setCull(mode) {
    const gl = this.gl;
    if (mode === 'none') { gl.disable(gl.CULL_FACE); return; }
    gl.enable(gl.CULL_FACE);
    gl.cullFace(mode === 'front' ? gl.FRONT : gl.BACK);
  }

  _bind(mesh) {
    const gl = this.gl, a = this.a, S = 48;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.vertexAttribPointer(a.pos, 3, gl.FLOAT, false, S, 0);
    gl.vertexAttribPointer(a.nrm, 3, gl.FLOAT, false, S, 12);
    gl.vertexAttribPointer(a.col, 3, gl.FLOAT, false, S, 24);
    gl.vertexAttribPointer(a.flg, 3, gl.FLOAT, false, S, 36);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
  }

  /**
   * @param mesh   Mesh | DynamicMesh
   * @param model  mat4 (defaults to identity)
   * @param o      {tint,[r,g,b]} {alpha} {add:[r,g,b]} {mode:'shaded'|'unlit'} {outline:width} {lineCol}
   */
  draw(mesh, model, o = {}) {
    if (!mesh || !mesh.count) return;
    const gl = this.gl, u = this.u;
    this._bind(mesh);
    gl.uniformMatrix4fv(u.model, false, model || IDENT);
    const t = o.tint || WHITE3;
    gl.uniform4f(u.tint, t[0], t[1], t[2], o.alpha == null ? 1 : o.alpha);
    const ad = o.add || ZERO3;
    gl.uniform3f(u.add, ad[0], ad[1], ad[2]);
    gl.uniform1f(u.mode, o.mode === 'unlit' ? 2 : 0);
    gl.uniform1f(u.outline, 0);
    const type = mesh.u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.drawElements(gl.TRIANGLES, mesh.count, type, 0);
    this.stats.draws++; this.stats.tris += mesh.count / 3;
  }

  /** inverted-hull outline; call before draw() for the same mesh */
  outline(mesh, model, width = 0.045, color = null, alpha = 1) {
    if (!mesh || !mesh.count) return;
    const gl = this.gl, u = this.u;
    this._bind(mesh);
    this.setCull('front');
    gl.uniformMatrix4fv(u.model, false, model || IDENT);
    gl.uniform4f(u.tint, 1, 1, 1, alpha);
    gl.uniform3f(u.add, 0, 0, 0);
    gl.uniform1f(u.mode, 1);
    gl.uniform1f(u.outline, width);
    const c = color || this.env.line;
    gl.uniform3fv(u.lineCol, c);
    const type = mesh.u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.drawElements(gl.TRIANGLES, mesh.count, type, 0);
    gl.uniform1f(u.outline, 0);
    gl.uniform3fv(u.lineCol, this.env.line);
    this.setCull('back');
    this.stats.draws++;
  }

  /** outline + shaded in one go */
  drawOutlined(mesh, model, o = {}) {
    if (o.outline !== 0) this.outline(mesh, model, o.outline || 0.035, o.lineCol, o.alpha == null ? 1 : o.alpha);
    this.draw(mesh, model, o);
  }

  /** world point -> css pixel coords, or null when off-screen/behind */
  toScreen(x, y, z) {
    const n = m4.project(this.vp, x, y, z);
    if (!n) return null;
    return [(n[0] * 0.5 + 0.5) * this.canvas.clientWidth, (0.5 - n[1] * 0.5) * this.canvas.clientHeight];
  }
}

const WHITE3 = [1, 1, 1];
const ZERO3 = [0, 0, 0];

/* ------------------------------------------------------------
   Camera - angled isometric-ish chase cam that always frames
   both players.
   ------------------------------------------------------------ */
export class Camera {
  constructor() {
    this.target = [0, 0, 0];
    this.look = [0, 0, 0];
    this.pos = [0, 26, 26];
    this.dist = 26;
    this.pitch = 0.78;     // radians above horizon
    this.yaw = 0;
    this.fov = 0.86;
    /* How far above the target the camera actually aims. In the arena this
       tips the horizon up so you see the ground ahead of the players. A
       portrait of a single character wants 0, or the subject slides off the
       bottom of the frame. */
    this.lookLift = 1.4;
    this.vp = m4.create();
    this.view = m4.create();
    this.proj = m4.create();
    this.shake = 0;
    this.shakeSeed = 0;
    this.time = 0;
  }

  addShake(v) { this.shake = Math.min(1.4, this.shake + v); }

  /**
   * Frame the action: sit close enough that the characters read as
   * characters, pulling back only as far as keeping both of them (and a
   * loose brainrot) on screen actually requires. Weighted toward the
   * local player so you always know where you are.
   */
  frame(pts, bias = null, dt = 0.016, aspect = 1.7, clampTo = 0) {
    let cx = 0, cz = 0;
    for (const p of pts) { cx += p[0]; cz += p[1]; }
    cx /= pts.length; cz /= pts.length;
    if (bias) { cx = cx * 0.4 + bias[0] * 0.6; cz = cz * 0.4 + bias[1] * 0.6; }
    if (clampTo) {
      cx = Math.max(-clampTo, Math.min(clampTo, cx));
      cz = Math.max(-clampTo, Math.min(clampTo, cz));
    }

    /* Solve for distance from the actual bounding box of what must stay on
       screen, treating width and depth separately. Screen X maps to world X;
       screen Y maps to world Z foreshortened by the camera pitch. A tall
       phone therefore needs much more distance for a side-by-side chase than
       a wide monitor does, and less for a chase up the screen. */
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
    /* Margins double as the minimum world box, so a cornered scrap still
       shows enough arena to read where the walls and ramps are. On a tall
       phone, insisting on the same *width* would shove the camera into
       orbit, so the horizontal requirement shrinks with the aspect and the
       tall axis does the work instead. */
    const MX = Math.max(6, Math.min(13, 13 * (aspect / 1.3)));
    const MZ = 16;
    const needX = (maxX - minX) + MX + Math.abs(cx - (minX + maxX) / 2) * 2;
    const needZ = (maxZ - minZ) + MZ + Math.abs(cz - (minZ + maxZ) / 2) * 2;

    const vFov = 2 * Math.tan(this.fov / 2);       // visible height per unit of distance
    const forWidth = needX / (vFov * Math.max(0.26, aspect));   // 9:32 is 0.28
    const forDepth = (needZ * Math.max(0.25, Math.sin(this.pitch))) / vFov;
    const want = Math.min(Math.max(Math.max(forWidth, forDepth), 14), 32);

    const k = 1 - Math.exp(-5.5 * dt);
    this.target[0] += (cx - this.target[0]) * k;
    this.target[2] += (cz - this.target[2]) * k;
    // zoom out fast (never lose someone), zoom back in gently
    const lambda = want > this.dist ? 6 : 2.2;
    this.dist += (want - this.dist) * (1 - Math.exp(-lambda * dt));
  }

  snap(x, z) { this.target[0] = x; this.target[2] = z; }

  update(dt, aspect) {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 2.6);
    const s = this.shake * this.shake;
    const t = this.time * 46;
    const sx = Math.sin(t * 1.7) * s * 0.9;
    const sy = Math.sin(t * 2.3 + 1.7) * s * 0.7;

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy2 = Math.sin(this.yaw);
    this.pos[0] = this.target[0] + sy2 * cp * this.dist + sx;
    this.pos[1] = this.target[1] + sp * this.dist + sy;
    this.pos[2] = this.target[2] + cy * cp * this.dist;
    this.look[0] = this.target[0] + sx * 0.6;
    this.look[1] = this.target[1] + this.lookLift;
    this.look[2] = this.target[2];

    m4.perspective(this.fov, aspect, 0.6, 240, this.proj);
    m4.lookAt(this.pos, this.look, UP, this.view);
    m4.multiply(this.proj, this.view, this.vp);
    return this;
  }
}
const UP = [0, 1, 0];

export { clamp01 };
