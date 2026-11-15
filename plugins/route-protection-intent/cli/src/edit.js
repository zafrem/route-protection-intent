'use strict';
// Person-driven edits of a sidecar: set, review, note, unset. Every write goes through save(),
// so validation, secret refusal and key order are the same as for the hook-driven path.
const fs = require('fs');
const path = require('path');
const R = require('./routes');
const { save } = require('./save');

const EXPOSURES = ['public', 'authenticated', 'internal'];
const RANK = { unclassified: 0, public: 1, authenticated: 2, internal: 3 };
const SIDECAR_RE = /(^|\/)(?:[A-Za-z0-9_-]+)?\.route\.json$/;
const fail = (error, extra = {}) => ({ ok: false, code: 2, error, ...extra });

function readJson(abs) { try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; } }

// Turns a route ("/api/orders"), a route file, a sidecar or a folder into the sidecar it means.
function resolve(root, target) {
  if (!target) return fail('a route (such as /api/orders) or a path is required');
  const config = R.loadConfig(root);
  const sidecars = []; const bySidecar = new Map();
  R.walk(root, (rel) => {
    if (SIDECAR_RE.test(rel)) sidecars.push(rel);
    if (R.isRouteFile(rel, config)) {
      const sc = R.sidecarPathFor(rel);
      if (!bySidecar.has(sc)) bySidecar.set(sc, []);
      bySidecar.get(sc).push(rel);
    }
  });
  const done = (sc) => ({ ok: true, sidecar: sc, abs: path.join(root, sc), exists: fs.existsSync(path.join(root, sc)), files: bySidecar.get(sc) || [] });

  const abs = path.resolve(root, target);
  if (fs.existsSync(abs)) {
    const rel = R.toPosix(path.relative(root, abs));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return fail(`${target} is outside the project`);
    if (fs.statSync(abs).isDirectory()) return done(rel ? `${rel}/.route.json` : '.route.json');
    if (SIDECAR_RE.test(rel)) return done(rel);
    if (R.isRouteFile(rel, config)) return done(R.sidecarPathFor(rel));
    return fail(`${target} is neither a route file nor a sidecar`);
  }
  if (!target.startsWith('/')) return fail(`${target} does not exist, and a route must start with "/"`);
  const found = new Set();
  for (const sc of sidecars) { const d = readJson(path.join(root, sc)); if (d && d.route === target) found.add(sc); }
  for (const [sc, files] of bySidecar) if (files.some((f) => R.routeFromPath(f) === target)) found.add(sc);
  if (found.size === 0) return fail(`no route ${target} found in this project; pass the route file or folder instead`);
  if (found.size > 1) return fail(`${target} matches more than one sidecar; pass one of them as a path`, { candidates: [...found].sort() });
  return done([...found][0]);
}

function load(res) {
  const doc = res.exists ? readJson(res.abs) : null;
  return res.exists && !doc ? fail(`${res.sidecar} is not valid JSON; fix or delete it first`) : { ok: true, doc };
}

function write(res, doc, { keepNotes = true } = {}) {
  const r = save(path.dirname(res.abs), doc, { file: path.basename(res.abs), keepNotes });
  return r.ok ? { ...r, sidecar: res.sidecar } : r;
}

function pickMethods(doc, list) {
  const all = Object.keys(doc.methods);
  if (!list) return all;
  const want = String(list).split(',').map((m) => m.trim().toUpperCase()).filter(Boolean);
  const missing = want.filter((m) => !all.includes(m));
  return missing.length ? { error: `${missing.join(', ')} not in this sidecar (has ${all.join(', ')})` } : want;
}

function set(root, target, exposure, { methods } = {}) {
  if (!EXPOSURES.includes(exposure)) return fail(`exposure must be one of ${EXPOSURES.join(', ')}`);
  const res = resolve(root, target); if (!res.ok) return res;
  const l = load(res); if (!l.ok) return l;
  const policyFor = (old = {}) => {
    const p = { ...old, exposure };
    if (exposure !== 'public') { p.cache = p.cache || { policy: 'no-store' }; p.indexing = p.indexing || 'noindex'; }
    return p;
  };
  let doc = l.doc; const warnings = []; let lowered = false;
  if (doc) {
    const list = pickMethods(doc, methods); if (list.error) return fail(list.error);
    for (const m of list) { if (RANK[exposure] < RANK[doc.methods[m].exposure]) lowered = true; doc.methods[m] = policyFor(doc.methods[m]); }
  } else {
    if (!res.files.length) return fail(`no route file found for ${target}; create the route first`);
    const detected = [...new Set(res.files.flatMap((f) => R.detectMethods(fs.readFileSync(path.join(root, f), 'utf8'), f)))];
    const list = methods ? String(methods).split(',').map((m) => m.trim().toUpperCase()) : (detected.length ? detected : ['*']);
    doc = { version: 1, route: R.routeFromPath(res.files[0]), methods: Object.fromEntries(list.map((m) => [m, policyFor()])) };
  }
  doc.reason = { source: 'user' };   // a new decision replaces any earlier review: it covered the old policy
  if (lowered) warnings.push('this lowers the recorded protection; the pull request will show it as a policy-downgrade');
  if (exposure === 'public' && R.docIsAdmin(doc, R.loadConfig(root).adminPaths)) warnings.push('this looks like an admin route; a public admin route is rarely intended');
  const r = write(res, doc);
  return r.ok ? { ...r, action: res.exists ? 'updated' : 'created', route: doc.route, exposure, warnings } : r;
}

function review(root, target, { by, date } = {}) {
  if (!by || !String(by).trim()) return fail('who reviewed it? give --by <name> (do not guess a reviewer)');
  const day = date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) return fail('the date must be a real day as YYYY-MM-DD');
  if (day > new Date().toISOString().slice(0, 10)) return fail('the review date is in the future');
  const res = resolve(root, target); if (!res.ok) return res;
  if (!res.exists) return fail(`${res.sidecar} does not exist; record the route with set first`);
  const l = load(res); if (!l.ok) return l;
  const doc = l.doc;
  doc.reason = { ...(doc.reason || {}), source: 'user', reviewedBy: String(by).trim(), reviewedAt: day };
  const r = write(res, doc);
  return r.ok ? { ...r, action: 'reviewed', route: doc.route, reviewedBy: doc.reason.reviewedBy, reviewedAt: day } : r;
}

function note(root, target, text, { methods, clear = false } = {}) {
  if (!clear && !(text && String(text).trim())) return fail('give the note text, or --clear to remove it');
  const res = resolve(root, target); if (!res.ok) return res;
  if (!res.exists) return fail(`${res.sidecar} does not exist; record the route with set first`);
  const l = load(res); if (!l.ok) return l;
  const doc = l.doc;
  const list = pickMethods(doc, methods); if (list.error) return fail(list.error);
  for (const m of list) {
    const p = { ...doc.methods[m] };
    if (clear) delete p.note; else p.note = String(text).trim();
    doc.methods[m] = p;
  }
  const r = write(res, doc, { keepNotes: !clear });
  return r.ok ? { ...r, action: clear ? 'note-cleared' : 'noted', route: doc.route, methods: list } : r;
}

function unset(root, target, { yes = false } = {}) {
  const res = resolve(root, target); if (!res.ok) return res;
  if (!res.exists) return fail(`${res.sidecar} does not exist; nothing to remove`);
  const doc = readJson(res.abs) || {};
  const r = doc.reason || {};
  const summary = { sidecar: res.sidecar, route: doc.route, decidedBy: r.source, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt, mode: doc.mode };
  if (doc.mode === 'enforce') return fail('this sidecar is in enforce mode; set it back to annotate on purpose before removing it', summary);
  if (!yes) return { ok: false, code: 3, needsConfirmation: true, error: 'removing a sidecar deletes a recorded decision; run again with --yes after the user confirms', ...summary };
  fs.rmSync(res.abs);
  return { ok: true, code: 0, action: 'removed', ...summary, note: 'the route now shows as missing in check until it is classified again' };
}

module.exports = { set, review, note, unset, resolve, EXPOSURES };
