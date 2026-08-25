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
import crypto from 'node:crypto';

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
let bundle = RUNTIME + body + `\n  __req(${JSON.stringify(entryId)});\n})();\n`;

/* ------------------------------------------------------------
   3. write dist/
   ------------------------------------------------------------ */
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

bundle = 'globalThis.STB_CONFIG = { dev: false };\n' + bundle;
fs.writeFileSync(path.join(DIST, 'bundle.js'), bundle);

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace('<script type="module" src="src/main.js"></script>', '<script src="bundle.js" defer></script>');
if (html.includes('src/main.js')) fail('could not rewrite the script tag in index.html');
// bake in whichever relay the deploy wants
/* The config used to ship as an inline <script> in the head. Certification
   requires the SDK to load before any game code, and an inline script that
   sets the game's own config global is game code by any reading - even sitting
   below the SDK tag it left the question open. It is prepended to the bundle
   instead, so the document contains exactly two scripts: the SDK, then the
   game. Nothing executes between them. */
const cfgRe = /<script>window\.STB_CONFIG[\s\S]*?<\/script>\n?/;
if (!cfgRe.test(html)) fail('could not find the STB_CONFIG block in index.html');
html = html.replace(cfgRe, '');

html = html.replace(/\n\s*<!--[\s\S]*?-->/g, '');           // strip layout comments

/* The SDK goes immediately after <meta charset>, ahead of everything else in
   the head.

   Two reasons it is not simply last-in-head like the reference template. A
   pending stylesheet blocks execution of any script that follows it, so with
   the <link> above it the SDK could not run until the CSS had arrived - it
   was finishing ~110ms after a stylesheet it has no dependency on. And the
   requirement is that the SDK is loaded before any game code, so the earlier
   it executes the less room there is for argument. charset still comes first,
   because an encoding declaration behind a script is its own problem. */
const charsetTag = '<meta charset="utf-8">';
if (!html.includes(charsetTag)) fail('could not find the charset meta to anchor the SDK to');
html = html.replace(charsetTag,
  charsetTag + '\n<script src="https://www.youtube.com/game_api/v1"></script>');

if (html.includes('STB_CONFIG')) fail('STB_CONFIG must not be inline in the page');
if ((html.match(/<script/g) || []).length !== 2) {
  fail('the page must contain exactly two scripts: the SDK and the bundle');
}
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\n{2,}/g, '\n')
  .replace(/^\s+/gm, '');
fs.writeFileSync(path.join(DIST, 'styles.css'), css);

/* Stamp the asset URLs with a content hash.

   index.html revalidates on every load but bundle.js and styles.css are sent
   with a long max-age, so without this a returning player keeps yesterday's
   script for an hour - and pairs it with today's freshly revalidated markup.
   A mismatched pair is worse than a merely stale one: the two files are built
   against each other. The hash changes only when the bytes do, so caches stay
   useful and a deploy is picked up on the next load instead of an hour later.

   The standalone build inlines both files, so it keeps the unstamped html. */
const stamp = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
/* The bundle is attached by script rather than written as a <script src>.

   This is the fix for "SDK loaded before any game code". Execution order was
   never wrong - a parser-blocking script in the head always runs before a
   deferred one - but the check is about LOADING, and the browser's preload
   scanner fetches anything it can see in the markup immediately. Measured on
   the built page: bundle.js finished downloading at 128ms while the SDK,
   coming from youtube.com, did not finish until 852ms. The game code was
   loaded 725ms before the SDK, exactly what the check names.

   With no <script src> in the markup there is nothing for the scanner to
   find, so the bundle is not requested until the line below runs - and that
   line cannot run until the SDK script above it has loaded and executed,
   because that one blocks the parser. The cost is real: the bundle can no
   longer download in parallel with the SDK. Correctness wins here, and
   gameReady still lands well inside the 5 second guidance. */
/* Waits for the SDK to actually answer before fetching the game.

   game_api/v1 is only a loader: it stands up window.ytgame, then pulls the
   real SDK asynchronously. Attaching the bundle straight after that stub was
   not enough - the harness reports "SDK script was not loaded before any game
   code" at the moment the *real* SDK initialises, and by then bundle.js was
   already in the resource timeline. So the probe here is a real round trip to
   the host (getLanguage), which cannot resolve until the SDK is genuinely up.

   The 2.5s cap matters: outside the Playables host nothing will ever answer,
   and the game still has to boot. */
/* Every subresource the markup names is fetched by the preload scanner, and
   the small ones always win the race against a cross-origin SDK. Measured on
   the deployed page: styles.css finished at 680ms, the SDK at 1044ms. If the
   check counts any resource loading before the SDK - not just scripts - that
   stylesheet has been failing it from the very first attempt, which is also
   why moving script tags around never moved the result.

   So the CSS is inlined and the two icon files dropped (the data: URI icon
   already in the head covers the tab). What is left to fetch is the SDK, and
   then the bundle, which the loader below only attaches once the SDK has
   answered. Nothing can precede it. */
html = html
  .replace(/<link rel="stylesheet" href="styles\.css[^"]*">/, '<style>' + css + '</style>')
  .replace(/\n<link rel="icon" href="favicon\.ico"[^>]*>/, '')
  .replace(/\n<link rel="apple-touch-icon"[^>]*>/, '');
if (html.includes('styles.css')) fail('the stylesheet is still an external request');

const loader = `<script>(function(){var a=function(){document.head.appendChild(`
  + `Object.assign(document.createElement('script'),`
  + `{src:'bundle.js?v=${stamp(bundle)}',defer:true}));},d=0,`
  + `g=function(){if(!d){d=1;a();}};setTimeout(g,2500);try{var y=window.ytgame;`
  + `if(y&&y.system&&y.system.getLanguage){Promise.resolve(y.system.getLanguage())`
  + `.then(g,g);}else{g();}}catch(e){g();}})();</script>`;
const hashed = html
  .replace('<script src="bundle.js" defer></script>', '')
  .replace('<script src="https://www.youtube.com/game_api/v1"></script>',
           '<script src="https://www.youtube.com/game_api/v1"></script>\n' + loader)
  .replace('<link rel="stylesheet" href="styles.css">',
           `<link rel="stylesheet" href="styles.css?v=${stamp(css)}">`);
if (hashed === html) fail('could not stamp the asset urls in index.html');
fs.writeFileSync(path.join(DIST, 'index.html'), hashed);



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
console.log('  offline:   no relay, no board, no external gameplay calls');
console.log('  playables: SDK script tag included');

// syntax check the emitted bundle before anyone loads it
const { execFileSync } = await import('node:child_process');
try {
  execFileSync(process.execPath, ['--check', path.join(DIST, 'bundle.js')], { stdio: 'pipe' });
} catch (e) {
  fail('the emitted bundle is not valid JavaScript:\n' + (e.stderr?.toString() || e.message));
}
console.log('  bundle passes node --check');
console.log('\n  serve it with:  node server/server.js --root dist\n');
