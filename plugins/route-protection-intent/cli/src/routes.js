'use strict';
// Route file detection: which files are routes, what URL they serve, which methods they handle.
const fs = require('fs');
const path = require('path');
const { extractEndpoints, CODE_EXT, parseKey } = require('./endpoints');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'venv', '.venv', '__pycache__', 'coverage', '.turbo', 'vendor', 'target', 'obj', '_build', 'deps', '.gradle', '.idea', '.mvn', 'Pods', '.dart_tool']);
const STATIC_DIRS = new Set(['public', 'static']);
const SRC_EXT = /\.(?:[cm]?[jt]sx?|py|go|java|kts?|cs|rb|php|rs|exs?|swift|dart)$/;
// Languages whose route files are found by path and whose URL comes from the file's own path.
const LEGACY_EXT = /\.(?:[cm]?[jt]sx?|py|go|java)$/;

// Default route patterns (FR-1.1). Globs: ** any depth, * within a segment.
const DEFAULT_PATTERNS = [
  '**/app/**/route.{ts,js,tsx,jsx,mjs}',
  '**/app/**/page.{tsx,jsx,ts,js}',
  '**/pages/**',
  '**/routers/**',
  '**/routes/**',
  '**/urls.py',
  '**/server/api/**',        // Nuxt / Nitro
  '**/server/routes/**',
];

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += '(?:' + glob.slice(i + 1, end).split(',').map(escape).join('|') + ')';
      i = end;
    } else re += escape(c);
  }
  return new RegExp('^' + re + '$');
}
function escape(s) { return s.replace(/[.+^$()|[\]\\?]/g, '\\$&'); }

// Extra authentication patterns from the project's own config (regular expressions as strings).
function compilePatterns(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (typeof s !== 'string' || !s || s.length > 200) continue;
    try { out.push(new RegExp(s)); } catch { /* ignore an invalid pattern */ }
  }
  return out;
}

function loadConfig(root) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, '.route-protection-intent.config.json'), 'utf8'));
    const raw = (c.verify && c.verify.samples) || {};
    const samples = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string' || typeof v === 'number'));
    return { include: c.include || [], exclude: c.exclude || [], adminPaths: c.adminPaths || [], quiet: c.quiet === true, samples, authRegexes: compilePatterns(c.authPatterns), root };
  } catch { return { include: [], exclude: [], adminPaths: [], quiet: false, samples: {}, authRegexes: [], root }; }
}

// True for the literal /admin segment or any route under a configured admin path.
// adminPaths entries are route prefixes; `*` matches within one segment (e.g. "/ops-*").
function isAdminRoute(route, adminPaths = []) {
  const segs = route.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (segs.includes('admin')) return true;
  return adminPaths.some((p) => {
    const prefix = '/' + p.split('/').filter(Boolean).join('/');
    const lower = prefix.toLowerCase();
    return globToRegex(lower).test(route.toLowerCase()) || globToRegex(lower + '/**').test(route.toLowerCase());
  });
}

// Admin if the sidecar's route, or the path of any endpoint it lists, is an admin path.
function docIsAdmin(doc, adminPaths = []) {
  if (isAdminRoute(doc.route, adminPaths)) return true;
  return Object.keys(doc.methods || {}).some((k) => { const e = parseKey(k); return e.path && isAdminRoute(e.path, adminPaths); });
}

function toPosix(p) { return p.split(path.sep).join('/'); }

function isRouteFile(relPath, config = { include: [], exclude: [] }) {
  const p = toPosix(relPath);
  if (!SRC_EXT.test(p)) return false;
  const base = path.posix.basename(p);
  if (/\.(test|spec)\.[^.]+$/.test(base) || /_test\.go$/.test(base) || /Test\.java$/.test(base) || /^(_app|_document|_error|__init__|conftest)\./.test(base)) return false;
  if (/(?:Tests?|Spec)\.(?:kts?|cs|php|swift)$/.test(base) || /_(?:test|spec)\.(?:rb|exs?|rs|dart)$/.test(base) || /^test_.*\.py$/.test(base)) return false;
  if (p.split('/').some((s) => SKIP_DIRS.has(s))) return false;
  if (config.exclude.some((g) => globToRegex(g).test(p))) return false;
  if ([...DEFAULT_PATTERNS, ...config.include].some((g) => globToRegex(g).test(p))) return true;
  // Frameworks that register routes in code (Spring, Go, Rails, Laravel...): the file counts if it looks like a router.
  if (config.root && CODE_EXT.test(p)) {
    try {
      const abs = path.join(config.root, p);
      if (fs.statSync(abs).size > 512 * 1024) return false;
      return extractEndpoints(fs.readFileSync(abs, 'utf8'), p).length > 0;
    } catch { return false; }
  }
  return false;
}

// True when the file's own path gives its URL (the original model); false when its routes are strings in the code.
function isLegacy(relPath, config = { include: [] }) {
  const p = toPosix(relPath);
  return LEGACY_EXT.test(p) && [...DEFAULT_PATTERNS, ...(config.include || [])].some((g) => globToRegex(g).test(p));
}

// Sidecar name: "<dir>/.route.json" when the directory is the route (Next app router),
// otherwise "<stem>.route.json" because many route files share one directory.
function sidecarName(relPath) {
  const p = toPosix(relPath);
  const stem = path.posix.basename(p).replace(SRC_EXT, '');
  if (/(^|\/)app\//.test(p) && (stem === 'route' || stem === 'page')) return '.route.json';
  return `${stem}.route.json`;
}

function sidecarPathFor(relPath) {
  return path.posix.join(path.posix.dirname(toPosix(relPath)), sidecarName(relPath));
}

// URL pattern served by a route file, derived from its path.
function routeFromPath(relPath) {
  const p = toPosix(relPath);
  const stem = path.posix.basename(p).replace(SRC_EXT, '');
  let segs = path.posix.dirname(p).split('/').filter((s) => s !== '.');
  const anchor = Math.max(segs.lastIndexOf('app'), segs.lastIndexOf('pages'));
  const frameworkRoot = anchor >= 0 && !/\.(?:py|go|java)$/.test(p);
  const server = segs.lastIndexOf('server');
  if (server >= 0 && ['api', 'routes'].includes(segs[server + 1]) && !frameworkRoot) {
    // Nuxt / Nitro: server/api/x.get.ts -> /api/x, server/routes/x.ts -> /x
    const sub = segs.slice(server + 1);
    segs = sub[0] === 'api' ? ['api', ...sub.slice(1)] : sub.slice(1);
    const name = stem.replace(/\.(?:get|post|put|patch|delete)$/, '');
    if (name !== 'index') segs.push(name);
  } else if (frameworkRoot) {
    segs = segs.slice(anchor + 1);
    if (stem !== 'route' && stem !== 'page' && stem !== 'index') segs.push(stem);
  } else {
    const a = Math.max(segs.lastIndexOf('routes'), segs.lastIndexOf('routers'));
    segs = a >= 0 ? segs.slice(a + 1) : segs.slice(-0);
    if (!['index', 'urls', 'route', '+server'].includes(stem)) segs.push(stem);
  }
  segs = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@')); // route groups, parallel slots
  return '/' + segs.join('/');
}

function detectMethods(source, relPath) {
  const found = new Set();
  for (const m of METHODS) {
    if (new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${m}\\b`).test(source)) found.add(m);
  }
  const call = source.matchAll(/\b(?:app|router|route|api|bp|r|mux|\w+Router)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(/gi);
  for (const x of call) found.add(x[1].toUpperCase());
  const deco = source.matchAll(/@\s*\w+\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(/gi);
  for (const x of deco) found.add(x[1].toUpperCase());
  const spring = source.matchAll(/@(Get|Post|Put|Patch|Delete)Mapping\b/g);
  for (const x of spring) found.add(x[1].toUpperCase());
  const goHttp = source.matchAll(/\bhttp\.Method(Get|Post|Put|Patch|Delete|Head|Options)\b/g);
  for (const x of goHttp) found.add(x[1].toUpperCase());
  if (/(^|\/)page\.[^/]+$/.test(toPosix(relPath))) found.add('GET');
  const sfx = /\.(get|post|put|patch|delete)\.[cm]?[jt]s$/.exec(toPosix(relPath));
  if (sfx) found.add(sfx[1].toUpperCase());
  return [...found].sort((a, b) => METHODS.indexOf(a) - METHODS.indexOf(b));
}

function walk(root, visit, rel = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, visit, r); }
    else if (e.isFile()) visit(r);
  }
}

function inStaticDir(relPath) {
  return toPosix(relPath).split('/').slice(0, -1).some((s) => STATIC_DIRS.has(s));
}

module.exports = {
  METHODS, isRouteFile, isLegacy, docIsAdmin, loadConfig, sidecarName, sidecarPathFor, routeFromPath,
  detectMethods, walk, inStaticDir, toPosix, isAdminRoute,
};
