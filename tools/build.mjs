/* ============================================================
   build.mjs - produce dist/ : one HTML, one CSS, one JS.

     node tools/build.mjs

   YouTube Playables wants a small, self-contained package. The game
   is authored as ~24 ES modules for sanity; this walks the import
   graph and folds them into a single script behind a 20-line module
   registry, so the browser makes 3 requests instead of 26.

   Deliberately conservative: it only rewrites `import`/`export`
   statements that start at column 0 (an invariant this codebase
   keeps, and one this script verifies), refuses to guess about
   anything unusual, and fails loudly rather than emitting a subtly
   broken bundle.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const ENTRY = path.join(SRC, 'main.js');
const PUBLIC = path.join(ROOT, 'public');

const argv = process.argv.slice(2);
const flag = (name, def = '') => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
/**
 * Where PLAY looks for a real opponent.
 *   'auto'  (default) wss://<the host serving this page>/ws - i.e. server/server.js
 *   'wss://...'       a relay on a different host
 *   'off'             no multiplayer at all; only the PRACTICE button works
 */
/* Env wins over the flag: some hosts (Render) let you set environment
   variables through their API but not edit the stored build command, so this
   is the only way to retune a running deployment without a dashboard visit. */
const RELAY_RAW = process.env.STB_RELAY || flag('relay', 'auto');
const RELAY = RELAY_RAW === 'off' ? '' : RELAY_RAW;
/**
 * Where the world leaderboard lives.
 *   'auto'  (default) /api on the host serving this page - i.e. server/server.js
 *   'https://...'     a leaderboard API on a different host
 *   'off'             no world board; LEADERBOARD shows this device's own scores
 */
const BOARD_RAW = process.env.STB_LEADERBOARD || flag('leaderboard', 'auto');
const BOARD = BOARD_RAW === 'off' ? '' : BOARD_RAW;
/** include the YouTube Playables SDK <script> (only meaningful inside their host) */
const PLAYABLES = argv.includes('--playables');
/** also emit dist/standalone.html - the whole game in one file, zero requests */
const SINGLE = argv.includes('--single') || argv.includes('--all');

const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/').replace(/\.js$/, '');

/* ------------------------------------------------------------
   1. walk the import graph
   ------------------------------------------------------------ */
const modules = new Map();   // id -> { file, src, deps:Set, code }
const stack = [];

function parse(file) {
  const id = rel(file);
  if (modules.has(id)) return id;
  if (stack.includes(id)) {
    fail(`circular import: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`);
  }
  stack.push(id);

  let src = fs.readFileSync(file, 'utf8');
  const deps = new Set();
  const lines = src.split('\n');
  const out = [];
  const tailExports = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    /* ---- imports (may span several lines) ---- */
    if (/^import[\s{*'"]/.test(line)) {
      let stmt = line;
      while (!/from\s*['"][^'"]+['"]\s*;?\s*$/.test(stmt) && !/^import\s*['"][^'"]+['"]\s*;?\s*$/.test(stmt)) {
        i++;
        if (i >= lines.length) fail(`${id}: unterminated import statement`);
        stmt += '\n' + lines[i];
      }
      out.push(rewriteImport(stmt, file, deps, id));
      continue;
    }

    /* ---- exports ---- */
    if (/^export\s/.test(line)) {
      const r = rewriteExport(line, id);
      out.push(r.code);
      if (r.tail) tailExports.push(r.tail);
      continue;
    }
    if (/^\s+(import|export)\s/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
      fail(`${id}:${i + 1}: indented import/export - the bundler only handles column-0 statements\n    ${line.trim()}`);
    }
    out.push(line);
  }

  modules.set(id, { id, file, deps, code: out.join('\n') + '\n' + tailExports.join('\n') });
  stack.pop();
  return id;
}

function resolveDep(spec, fromFile) {
  if (!spec.startsWith('.')) fail(`bare import "${spec}" in ${rel(fromFile)} - everything must be local`);
  const p = path.resolve(path.dirname(fromFile), spec);
  if (!fs.existsSync(p)) fail(`missing module ${spec} imported by ${rel(fromFile)}`);
  return p;
}

function rewriteImport(stmt, file, deps, id) {
  const flat = stmt.replace(/\n/g, ' ');
  const m = /^import\s+(?:(.+?)\s+from\s+)?['"]([^'"]+)['"]\s*;?\s*$/.exec(flat);
  if (!m) fail(`${id}: cannot parse import\n    ${flat.trim()}`);
  const [, clause, spec] = m;
  const depFile = resolveDep(spec, file);
  const depId = parse(depFile);
  deps.add(depId);

  if (!clause) return `__req(${JSON.stringify(depId)});`;

  const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clause.trim());
  if (ns) return `const ${ns[1]} = __req(${JSON.stringify(depId)});`;

  const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (named) {
    const parts = named[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(s);
      return as ? `${as[1]}: ${as[2]}` : s;
    });
    return `const { ${parts.join(', ')} } = __req(${JSON.stringify(depId)});`;
  }
  fail(`${id}: only named and namespace imports are supported, got "${clause}"`);
  return '';
}

function rewriteExport(line, id) {
  // export { a, b as c };
  let m = /^export\s*\{([^}]*)\}\s*;?\s*$/.exec(line);
  if (m) {
    const assigns = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(s);
      return as ? `__x.${as[2]} = ${as[1]};` : `__x.${s} = ${s};`;
    });
    return { code: '', tail: assigns.join(' ') };
  }
  // export default  -> not supported (and not used)
  if (/^export\s+default\b/.test(line)) fail(`${id}: "export default" is not supported by this bundler`);
  // export function / class NAME
  m = /^export\s+((?:async\s+)?function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (m) return { code: line.replace(/^export\s+/, ''), tail: `__x.${m[2]} = ${m[2]};` };
  // export const/let/var NAME
  m = /^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
  if (m) {
    const body = line.replace(/^export\s+/, '');
    // reject multi-declarator statements rather than half-exporting them
    const decl = body.slice(m[1].length).trim();
    if (/^[A-Za-z_$][\w$]*\s*=[^;]*,\s*[A-Za-z_$][\w$]*\s*=/.test(decl)) {
      fail(`${id}: multi-declarator export not supported: ${line.trim()}`);
    }
    // `let` can be reassigned later, so expose it live
    const tail = m[1] === 'const'
      ? `__x.${m[2]} = ${m[2]};`
      : `Object.defineProperty(__x, ${JSON.stringify(m[2])}, { get: () => ${m[2]}, enumerable: true });`;
    return { code: body, tail };
  }
  fail(`${id}: cannot rewrite export\n    ${line.trim()}`);
  return { code: '', tail: '' };
}

function fail(msg) {
  console.error('\n  BUILD FAILED: ' + msg + '\n');
  process.exit(1);
}

/* ------------------------------------------------------------
   2. emit
   ------------------------------------------------------------ */
const entryId = parse(ENTRY);

const RUNTIME = `/* Steal the Brainrot - bundled. Source lives in src/. */
(function () {
  "use strict";
  var __m = {}, __c = {};
  function __def(id, fn) { __m[id] = fn; }
  function __req(id) {
    if (__c[id]) return __c[id];
    var fn = __m[id];
    if (!fn) throw new Error("module not bundled: " + id);
    var x = (__c[id] = {});
    fn(x, __req);
    return x;
  }
`;

const order = [...modules.keys()];
let body = '';
for (const id of order) {
  const m = modules.get(id);
  body += `\n__def(${JSON.stringify(id)}, function (__x, __req) {\n${m.code}\n});\n`;
}
const bundle = RUNTIME + body + `\n  __req(${JSON.stringify(entryId)});\n})();\n`;

/* ------------------------------------------------------------
   3. write dist/
   ------------------------------------------------------------ */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

fs.writeFileSync(path.join(DIST, 'bundle.js'), bundle);

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace('<script type="module" src="src/main.js"></script>', '<script src="bundle.js" defer></script>');
if (html.includes('src/main.js')) fail('could not rewrite the script tag in index.html');
// bake in whichever relay the deploy wants
const cfg = `<script>window.STB_CONFIG = { relay: ${JSON.stringify(RELAY)}, `
  + `leaderboard: ${JSON.stringify(BOARD)}, dev: false };</script>`;
const cfgRe = /<script>window\.STB_CONFIG[\s\S]*?<\/script>/;
if (!cfgRe.test(html)) fail('could not find the STB_CONFIG block in index.html');
html = html.replace(cfgRe, cfg);

html = html.replace(/\n\s*<!--[\s\S]*?-->/g, '');           // strip layout comments

if (PLAYABLES) {
  // Must load before any game code. It only exists inside the Playables host,
  // so it stays opt-in and a plain web deploy makes zero external requests.
  html = html.replace('</head>', '<script src="https://www.youtube.com/game_api/v1"></script>\n</head>');
}
fs.writeFileSync(path.join(DIST, 'index.html'), html);

const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\n{2,}/g, '\n')
  .replace(/^\s+/gm, '');
fs.writeFileSync(path.join(DIST, 'styles.css'), css);

/* ------------------------------------------------------------
   4. verify + report
   ------------------------------------------------------------ */
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1) + ' kB';

/* ------------------------------------------------------------
   optional: the entire game as one file
   ------------------------------------------------------------ */
if (SINGLE) {
  let one = html
    .replace('<link rel="stylesheet" href="styles.css">', `<style>\n${css}\n</style>`)
    .replace('<script src="bundle.js" defer></script>', `<script>\n${bundle}\n</script>`)
    // a lone file has no siblings to point at: drop the card image and the
    // file-based icons, keeping the inline SVG icon so it still has a mark
    .replace(/\n<meta (?:property="og:image[^>]*|name="twitter:image")[^>]*>/g, '')
    .replace(/\n<link rel="(?:icon|apple-touch-icon)" href="(?!data:)[^"]*"[^>]*>/g, '');
  if (one.includes('styles.css') || one.includes('bundle.js')) {
    fail('standalone build still references external files');
  }
  fs.writeFileSync(path.join(DIST, 'standalone.html'), one);
}

/* copy public/ verbatim: cover image, robots.txt, per-host config files */
let copied = 0;
if (fs.existsSync(PUBLIC)) {
  for (const name of fs.readdirSync(PUBLIC)) {
    const from = path.join(PUBLIC, name);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(DIST, name));
    copied++;
  }
}

const files = fs.readdirSync(DIST)
  .filter((f) => fs.statSync(path.join(DIST, f)).isFile())
  .sort();
let raw = 0, comp = 0;
console.log('\n  dist/');
for (const f of files) {
  const buf = fs.readFileSync(path.join(DIST, f));
  raw += buf.length; comp += gz(buf);
  console.log(`    ${f.padEnd(12)} ${kb(buf.length).padStart(10)}  ${kb(gz(buf)).padStart(10)} gzipped`);
}
console.log(`    ${'TOTAL'.padEnd(12)} ${kb(raw).padStart(10)}  ${kb(comp).padStart(10)} gzipped`);
console.log(`\n  ${modules.size} modules bundled, ${bundle.split('\n').length} lines` +
  (copied ? `, ${copied} file(s) from public/` : ''));
console.log(`  relay:     ${RELAY || '(off - PLAY disabled, practice only)'}`);
if (!RELAY) {
  console.log('             PLAY will not match real players in this build.');
} else if (RELAY === 'auto') {
  console.log('             serve dist/ with server/server.js so /ws exists.');
}
console.log(`  board:     ${BOARD || '(off - LEADERBOARD shows this device only)'}`);
if (BOARD === 'auto') {
  console.log('             set DATA_DIR to a persistent disk or it resets on redeploy.');
}
console.log(`  playables: ${PLAYABLES ? 'SDK script tag included' : 'not included (plain web build)'}`);

// syntax check the emitted bundle before anyone loads it
const { execFileSync } = await import('node:child_process');
try {
  execFileSync(process.execPath, ['--check', path.join(DIST, 'bundle.js')], { stdio: 'pipe' });
} catch (e) {
  fail('the emitted bundle is not valid JavaScript:\n' + (e.stderr?.toString() || e.message));
}
console.log('  bundle passes node --check');
console.log('\n  serve it with:  node server/server.js --root dist\n');
