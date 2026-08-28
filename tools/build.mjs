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
/* The bundle is inlined into the page, so writing it out as a file too just
   put an unreferenced 362 kB copy of the game in the deploy. dist/ is one
   file now: index.html and nothing else. */

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace('<script type="module" src="src/main.js"></script>', '<script src="bundle.js" defer></script>');
if (html.includes('src/main.js')) fail('could not rewrite the script tag in index.html');
/* The config is prepended to the bundle above rather than written into the
   page. An inline script that sets the game's own config global is game code
   by any reading, and certification wants nothing of the sort ahead of the
   SDK. The source carries none, so there is nothing to strip here - only an
   assertion that it stays that way. */
if (/<script>[^<]*STB_CONFIG/.test(html)) {
  fail('index.html has an inline STB_CONFIG script; it belongs in the bundle');
}

html = html.replace(/\n\s*<!--[\s\S]*?-->/g, '');           // strip layout comments

/* The SDK tag lives in the source index.html, not here.

   It used to be injected at build time, which meant the source entry point
   had no SDK at all: anyone serving the repo directly for development ran
   the game with the integration absent, and the ordering the requirement
   cares about was only ever exercised in a built artifact. The source owns
   it now and the build only checks it, so dev and production load the same
   way. */
const sdkTag = '<script src="https://www.youtube.com/game_api/v1"></script>';
if (!html.includes(sdkTag)) fail('index.html is missing the Playables SDK script tag');
if (html.indexOf(sdkTag) !== html.indexOf('<script')) {
  fail('the Playables SDK must be the first script in index.html');
}

if (html.includes('STB_CONFIG')) fail('STB_CONFIG must not be inline in the page');
if ((html.match(/<script/g) || []).length !== 2) {
  fail('the page must contain exactly two scripts: the SDK and the bundle');
}
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\n{2,}/g, '\n')
  .replace(/^\s+/gm, '');
// css is inlined into the page above; no separate file ships

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
/* The stylesheet is inlined and the icon files dropped. Google's sample does
   keep an external stylesheet, so this is not required for certification -
   but it removes a round trip on first load and leaves the SDK as the only
   external file the markup names, which costs nothing to keep. */
html = html
  .replace(/<link rel="stylesheet" href="styles\.css[^"]*">/, '<style>' + css + '</style>')
  .replace(/\n<link rel="icon" href="favicon\.ico"[^>]*>/, '')
  .replace(/\n<link rel="apple-touch-icon"[^>]*>/, '');
if (html.includes('styles.css')) fail('the stylesheet is still an external request');

/* The bundle is attached only once the SDK has answered a call.
/* The game code is inlined, so it is never a resource at all.

   The SDK reports resources to the host through a PerformanceObserver
   started with `buffered: true`, which hands it everything already sitting
   in the performance buffer and skips only youtube.com/game_api URLs. Every
   earlier attempt tried to win a race against that - reorder the tag, defer
   it, inject it once the SDK had answered a call. Each narrowed the window
   without closing it, because a separate file is always a resource that can
   land in that batch.

   There is no race if there is no request. The bundle goes in as an inline
   script at the end of <body>, leaving the SDK as the only thing the
   document fetches. End of body also keeps first paint quick: the markup and
   the loading screen parse before the script is reached, which a
   parser-blocking 106 KiB tag in the head did not - that cost 2.8s. */
/* Inlining is only safe while the bundle contains no closing script tag: the
   HTML parser would end the block at the first one and dump the rest of the
   game into the document as text. Nothing produces one today, but a stray
   string in future source would break the page silently. */
if (/<\/script/i.test(bundle)) {
  fail('the bundle contains a closing script tag and cannot be inlined');
}
const inlineBundle = '<script>' + bundle + '</script>';

const hashed = html
  .replace('<script src="bundle.js" defer></script>', '')
  .replace('</body>', inlineBundle + '\n</body>');
if (hashed === html) fail('could not inline the bundle into index.html');
fs.writeFileSync(path.join(DIST, 'index.html'), hashed);



/* ------------------------------------------------------------
   4. verify + report
   ------------------------------------------------------------ */
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1) + ' kB';

/* There is no separate "standalone" build any more. `--single` used to fold
   the stylesheet and the bundle into one file as an option; the ordinary
   build does that unconditionally now, so the flag only ever emitted a
   duplicate of the page that was already there. */

/* public/ is not copied. Nothing in it is referenced by the built page: the
   icon is a data URI, the stylesheet is inlined, and the per-host config files
   (netlify, vercel, _headers) describe hosts this is not deployed to. dist/ is
   one file - index.html - and nothing else. */

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
console.log(`\n  ${modules.size} modules bundled, ${bundle.split('\n').length} lines`);
console.log('  offline:   no relay, no board, no external gameplay calls');
console.log('  playables: SDK script tag included');

/* Syntax-check what actually ships. This used to run `node --check` against
   dist/bundle.js, which no longer exists now the game is inlined - so the
   check is against the inline script pulled back out of the generated page,
   which is closer to the truth anyway: it validates the bytes the browser
   will parse, not an intermediate artifact. new Function parses without
   executing, so nothing runs here. */
const emitted = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const inlineOpen = emitted.lastIndexOf('<script>');
const inlineClose = emitted.lastIndexOf('</script>');
if (inlineOpen < 0 || inlineClose < inlineOpen) fail('no inline game script in index.html');
try {
  // eslint-disable-next-line no-new-func
  new Function(emitted.slice(inlineOpen + 8, inlineClose));
} catch (e) {
  fail('the inlined game script is not valid JavaScript: ' + e.message);
}
console.log('  inlined game script parses cleanly');
console.log('\n  serve it with:  node server/server.js --root dist\n');
