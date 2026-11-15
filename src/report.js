'use strict';
// Route inventory: one row per route and method with the recorded intent, who decided it, and
// whether the code shows an authentication check. Static and offline; deterministic output so the
// result can be committed and diffed (an audit trail of exposure over time).
const fs = require('fs');
const path = require('path');
const R = require('./routes');
const { hasAuthSignal } = require('./analyze');
const { validate } = require('./validate');
const { AUTH_ENTRY, EXTERNAL_VIA } = require('./check');
const { extractEndpoints, parseKey } = require('./endpoints');

const SIDECAR_FILE = /(^|\/)(?:[A-Za-z0-9_-]+)?\.route\.json$/;
const PROTECTED = new Set(['authenticated', 'internal']);
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };

function report(root = process.cwd(), { strict = false } = {}) {
  const config = R.loadConfig(root);
  const routeFiles = new Map();   // sidecar path -> route files
  const sidecars = [];
  R.walk(root, (rel) => {
    if (R.isRouteFile(rel, config)) {
      const sc = R.sidecarPathFor(rel);
      if (!routeFiles.has(sc)) routeFiles.set(sc, []);
      routeFiles.get(sc).push(rel);
    }
    if (SIDECAR_FILE.test(rel)) sidecars.push(rel);
  });

  const rows = [];
  const row = (o) => rows.push({ route: '', pathFrom: 'file', method: '*', exposure: '', gate: '', via: '', decidedBy: '', authCheck: 'n/a', sidecar: '', files: [], gaps: [], ...o });

  for (const sc of sidecars) {
    let doc;
    try { doc = JSON.parse(read(root, sc)); } catch { row({ route: sc, method: '-', exposure: '(invalid)', sidecar: sc, gaps: ['schema'] }); continue; }
    if (!validate(doc).valid) { row({ route: sc, method: '-', exposure: '(invalid)', sidecar: sc, gaps: ['schema'] }); continue; }
    const files = routeFiles.get(sc) || [];
    const authCheck = files.length ? (files.some((f) => hasAuthSignal(read(root, f), config.authRegexes)) ? 'yes' : 'no') : 'n/a';
    const via = ((doc.enforcement && doc.enforcement.via) || []).filter((v) => v !== 'none');
    for (const [key, p] of Object.entries(doc.methods)) {
      const e = parseKey(key);
      const method = e.method;
      const gaps = [];
      if (!files.length) gaps.push('orphan');
      if (p.exposure === 'unclassified') gaps.push('unclassified');
      if (PROTECTED.has(p.exposure) && authCheck === 'no' && !via.some((v) => EXTERNAL_VIA.includes(v)) && !AUTH_ENTRY.test(e.path || doc.route)) gaps.push('protected-no-auth-check');
      if (p.exposure === 'public' && authCheck === 'yes') gaps.push('public-with-auth-check');
      row({
        route: e.path || doc.route, pathFrom: e.path ? 'source' : 'file', method, exposure: p.exposure, gate: (doc.gate && doc.gate.type) || '',
        via: via.join(','), decidedBy: (doc.reason && doc.reason.source) || '', reviewed: doc.reason && doc.reason.reviewedBy ? `${doc.reason.reviewedBy} ${doc.reason.reviewedAt}` : '', authCheck, sidecar: sc, files, gaps,
      });
    }
  }
  for (const [sc, files] of routeFiles) {
    if (sidecars.includes(sc)) continue;
    const found = files.flatMap((f) => (R.isLegacy(f, config) ? [] : extractEndpoints(read(root, f), f)));
    if (found.length) {
      for (const e of found) row({ route: e.path, pathFrom: 'source', method: e.method, exposure: '(none)', sidecar: sc, files, gaps: ['no-sidecar'] });
      continue;
    }
    const methods = [...new Set(files.flatMap((f) => R.detectMethods(read(root, f), f)))];
    for (const method of methods.length ? methods : ['*']) {
      row({ route: R.routeFromPath(files[0]), method, exposure: '(none)', sidecar: sc, files, gaps: ['no-sidecar'] });
    }
  }
  rows.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : R.METHODS.indexOf(a.method) - R.METHODS.indexOf(b.method)));

  const count = (f) => rows.filter(f).length;
  const summary = {
    routes: new Set(rows.map((r) => r.route)).size,
    entries: rows.length,
    public: count((r) => r.exposure === 'public'),
    authenticated: count((r) => r.exposure === 'authenticated'),
    internal: count((r) => r.exposure === 'internal'),
    unrecorded: count((r) => r.exposure === '(none)' || r.exposure === 'unclassified' || r.exposure === '(invalid)'),
    decidedByPerson: count((r) => r.decidedBy === 'user'),
    reviewed: count((r) => r.reviewed),
    withGaps: count((r) => r.gaps.length),
  };
  return { ok: !strict || summary.withGaps === 0, exitCode: strict && summary.withGaps ? 1 : 0, summary, rows };
}

const BASE_COLS = [['ROUTE', 'route'], ['METHOD', 'method'], ['EXPOSURE', 'exposure'], ['GATE', 'gate'], ['VIA', 'via'], ['DECIDED BY', 'decidedBy'], ['AUTH CHECK', 'authCheck'], ['GAPS', 'gaps']];
// REVIEWED appears only once some route has a recorded review, so existing output stays the same.
const colsFor = (r) => (r.summary.reviewed ? [...BASE_COLS.slice(0, 6), ['REVIEWED', 'reviewed'], ...BASE_COLS.slice(6)] : BASE_COLS);
const cell = (r, k) => (k === 'gaps' ? r.gaps.join(', ') : r[k]) || '-';

function summaryLine(s) {
  return `${s.routes} route(s), ${s.entries} entr${s.entries === 1 ? 'y' : 'ies'}: ${s.public} public, ${s.authenticated} authenticated, ${s.internal} internal, ${s.unrecorded} without a recorded decision; ${s.decidedByPerson} confirmed by a person${s.reviewed ? `; ${s.reviewed} with a recorded review` : ''}; ${s.withGaps} with gaps`;
}

function formatTable(r) {
  const COLS = colsFor(r);
  const data = r.rows.map((x) => COLS.map(([, k]) => cell(x, k)));
  const widths = COLS.map(([h], i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(COLS.map(([h]) => h)), ...data.map(line), '', summaryLine(r.summary)].join('\n');
}

function formatMarkdown(r) {
  const COLS = colsFor(r);
  const esc = (t) => String(t).replace(/\|/g, '\\|');
  const head = `| ${COLS.map(([h]) => h).join(' | ')} |\n| ${COLS.map(() => '---').join(' | ')} |`;
  const body = r.rows.map((x) => `| ${COLS.map(([, k]) => esc(k === 'route' ? `\`${cell(x, k)}\`` : cell(x, k))).join(' | ')} |`);
  return ['# Route inventory', '', summaryLine(r.summary), '', head, ...body, ''].join('\n');
}

function formatCsv(r) {
  const COLS = colsFor(r);
  const q = (t) => (/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
  return [COLS.map(([h]) => q(h)).join(','), ...r.rows.map((x) => COLS.map(([, k]) => q(k === 'gaps' ? x.gaps.join(' ') : x[k] || '')).join(','))].join('\n');
}

function format(r, kind = 'table') {
  if (kind === 'json') return JSON.stringify({ summary: r.summary, rows: r.rows.map(({ files, ...x }) => ({ ...x, files })) }, null, 2);
  if (kind === 'md' || kind === 'markdown') return formatMarkdown(r);
  if (kind === 'csv') return formatCsv(r);
  if (kind === 'table') return formatTable(r);
  throw new Error(`unknown format "${kind}" (table, md, json, csv)`);
}

module.exports = { report, format };
