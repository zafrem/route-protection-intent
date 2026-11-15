'use strict';
// Compare an OpenAPI document (JSON) with the recorded sidecars. The spec says which operations require
// authentication, in any language; the sidecars say what the team decided. A difference is worth a look:
// either the spec is incomplete or the recorded intent is wrong.
const fs = require('fs');
const path = require('path');
const { report } = require('./report');

const OPS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
const PARAM = /^(?:\{[^}]*\}|:\w+|\[[^\]]*\]|<[^>]*>)$/;
const norm = (p) => '/' + String(p).split('/').filter(Boolean).map((s) => (PARAM.test(s) ? '{}' : s.toLowerCase())).join('/');

// 'protected' when the operation requires a scheme; 'public' when it has no security or allows anonymous callers.
function protection(op, rootSecurity) {
  const sec = op.security !== undefined ? op.security : rootSecurity;
  if (!Array.isArray(sec) || sec.length === 0) return 'public';
  return sec.some((r) => r && typeof r === 'object' && Object.keys(r).length === 0) ? 'public' : 'protected';
}

function serverPrefix(doc) {
  const url = doc.servers && doc.servers[0] && doc.servers[0].url;
  if (typeof url !== 'string' || /\{/.test(url)) return '';
  try { return new URL(url, 'http://x').pathname.replace(/\/+$/, ''); } catch { return ''; }
}

function compareSpec(root, specFile, { prefix, strict = false } = {}) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.resolve(root, specFile), 'utf8')); }
  catch (e) { throw new Error(`cannot read ${specFile} as JSON (${e.code || e.message}). YAML specs are not supported: convert to JSON first`); }
  if (!doc || typeof doc !== 'object' || !doc.paths || typeof doc.paths !== 'object') throw new Error(`${specFile} has no "paths": is it an OpenAPI document?`);

  const base = prefix !== undefined ? prefix.replace(/\/+$/, '') : serverPrefix(doc);
  const recorded = report(root).rows.filter((r) => r.exposure !== '(invalid)' && r.exposure !== '(none)');
  const byKey = new Map();
  for (const r of recorded) byKey.set(`${r.method} ${norm(r.route)}`, r);
  const used = new Set();
  const rows = [];

  for (const [p, item] of Object.entries(doc.paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const m of OPS) {
      if (!item[m] || typeof item[m] !== 'object') continue;
      const method = m.toUpperCase();
      const spec = protection(item[m], doc.security);
      const found = [base + p, p].map((x) => `${method} ${norm(x)}`).concat([base + p, p].map((x) => `* ${norm(x)}`)).find((k) => byKey.has(k));
      const row = { route: p, method, spec, recorded: '', result: 'not-recorded', note: 'in the spec, but no sidecar records this route' };
      if (found) {
        used.add(found);
        const r = byKey.get(found);
        row.recorded = r.exposure;
        if (r.exposure === 'unclassified') { row.result = 'unclassified'; row.note = 'the sidecar has not decided yet'; }
        else if (spec === 'protected' && r.exposure === 'public') { row.result = 'mismatch'; row.note = 'recorded public, but the spec requires authentication'; }
        else if (spec === 'public' && r.exposure !== 'public') { row.result = 'mismatch'; row.note = `the spec documents no authentication, but the sidecar says ${r.exposure} (is the spec incomplete?)`; }
        else { row.result = 'match'; row.note = ''; }
      }
      rows.push(row);
    }
  }
  for (const [k, r] of byKey) {
    if (used.has(k)) continue;
    rows.push({ route: r.route, method: r.method, spec: '', recorded: r.exposure, result: 'not-in-spec', note: 'recorded in a sidecar, but not in the spec (the spec may be partial)' });
  }
  rows.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : OPS.indexOf(a.method.toLowerCase()) - OPS.indexOf(b.method.toLowerCase())));
  const n = (k) => rows.filter((r) => r.result === k).length;
  const summary = { operations: rows.filter((r) => r.spec).length, match: n('match'), mismatch: n('mismatch'), notRecorded: n('not-recorded'), notInSpec: n('not-in-spec'), unclassified: n('unclassified') };
  const failing = summary.mismatch > 0 || (strict && (summary.notRecorded > 0 || summary.unclassified > 0));
  return { ok: !failing, exitCode: failing ? 1 : 0, summary, rows };
}

const COLS = [['ROUTE', 'route'], ['METHOD', 'method'], ['SPEC', 'spec'], ['RECORDED', 'recorded'], ['RESULT', 'result'], ['NOTE', 'note']];
const cell = (r, k) => String(r[k] || '-');
const line = (s) => `${s.operations} operation(s) in the spec: ${s.match} match, ${s.mismatch} mismatch, ${s.notRecorded} not recorded, ${s.unclassified} unclassified; ${s.notInSpec} recorded route(s) not in the spec`;

function format(r, kind = 'table') {
  if (kind === 'json') return JSON.stringify({ summary: r.summary, rows: r.rows }, null, 2);
  if (kind === 'csv') {
    const q = (t) => (/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    return [COLS.map(([h]) => h).join(','), ...r.rows.map((x) => COLS.map(([, k]) => q(String(x[k] || ''))).join(','))].join('\n');
  }
  if (kind === 'md' || kind === 'markdown') {
    const esc = (t) => String(t).replace(/\|/g, '\\|');
    return ['# API spec comparison', '', line(r.summary), '', `| ${COLS.map(([h]) => h).join(' | ')} |`, `| ${COLS.map(() => '---').join(' | ')} |`,
      ...r.rows.map((x) => `| ${COLS.map(([, k]) => esc(cell(x, k))).join(' | ')} |`), ''].join('\n');
  }
  if (kind !== 'table') throw new Error(`unknown format "${kind}" (table, md, json, csv)`);
  const data = r.rows.map((x) => COLS.map(([, k]) => cell(x, k)));
  const w = COLS.map(([h], i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const pad = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(w[i]))).join('  ');
  return [pad(COLS.map(([h]) => h)), ...data.map(pad), '', line(r.summary)].join('\n');
}

module.exports = { compareSpec, format, protection, norm };
