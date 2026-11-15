'use strict';
// Live check of the recorded intent: send requests WITHOUT credentials to a running app and compare
// the answer with what each sidecar says. A route recorded as protected that answers 200 to an
// anonymous caller is a real gap. This proves only that anonymous callers are refused; it says
// nothing about one user reading another user's data.
const R = require('./routes');
const { report } = require('./report');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PROTECTED = new Set(['authenticated', 'internal']);

function isLocal(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

// Fill dynamic segments ([id], [...slug], :id, {id}) from the configured samples.
function buildPath(route, samples = {}) {
  const missing = [];
  const fill = (name) => {
    if (samples[name] === undefined) { missing.push(name); return ''; }
    return encodeURIComponent(String(samples[name]));
  };
  const out = route
    .replace(/\[\[?\.\.\.(\w+)\]?\]/g, (_, n) => fill(n))
    .replace(/\[(\w+)\]/g, (_, n) => fill(n))
    .replace(/\{(\w+)\??(?::[^}]*)?\}/g, (_, n) => fill(n))
    .replace(/<(?:\w+:)?(\w+)>/g, (_, n) => fill(n))
    .replace(/:(\w+)/g, (_, n) => fill(n));
  return { path: out, missing };
}

const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

function judge(exposure, status, location, requested) {
  const refused = status === 401 || status === 403;
  const redirect = status >= 300 && status < 400;
  let toSame = false;
  if (redirect && location) { try { toSame = trim(new URL(location, 'http://x' + requested).pathname) === trim(requested); } catch { toSame = false; } }
  if (PROTECTED.has(exposure)) {
    if (status >= 200 && status < 300) return ['gap', `answered ${status} to an anonymous request, but the sidecar says this route is ${exposure}`];
    if (refused) return ['pass', `refused with ${status}`];
    if (redirect && !toSame) return ['pass', `redirected to ${location || '(no location)'}`];
    if (redirect) return ['inconclusive', `redirected to itself (${status}); probably a trailing-slash redirect`];
    if (status === 404) return ['inconclusive', '404: wrong URL, a missing sample value, or the route is not served here'];
    if (status === 405) return ['inconclusive', '405: the method is not handled'];
    if (status === 400 || status === 422) return ['inconclusive', `${status}: rejected before any authentication decision; check that authentication runs first`];
    return ['inconclusive', `${status}: no clear answer`];
  }
  if (status >= 200 && status < 300) return ['pass', `answered ${status}`];
  if (refused) return ['gap', `refused an anonymous request with ${status}, but the sidecar says this route is public`];
  if (redirect) return ['inconclusive', `redirected to ${location || '(no location)'}`];
  return ['inconclusive', `${status}: no clear answer`];
}

async function verify(root, opts = {}) {
  const { baseUrl, includeMutating = false, allowRemote = false, strict = false, timeoutMs = 10000, delayMs = 0, fetchFn = globalThis.fetch } = opts;
  if (!baseUrl) throw new Error('--base-url is required, for example --base-url http://localhost:3000');
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error(`--base-url "${baseUrl}" is not a valid URL`); }
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('--base-url must be http or https');
  if (!isLocal(base.hostname) && !allowRemote) {
    throw new Error(`"${base.hostname}" is not a local address. Only probe systems you own and may test (a staging environment, not production traffic you do not control). Pass --allow-remote to confirm.`);
  }
  if (typeof fetchFn !== 'function') throw new Error('this Node version has no fetch; use Node 18 or newer');

  const samples = R.loadConfig(root).samples;
  const rows = [];
  for (const r of report(root).rows) {
    if (!['public', 'authenticated', 'internal'].includes(r.exposure)) continue;
    const method = r.method === '*' ? 'GET' : r.method;
    const row = { route: r.route, method, exposure: r.exposure, status: '', result: 'skipped', note: '' };
    rows.push(row);
    if (!SAFE_METHODS.has(method) && !includeMutating) { row.note = 'not sent: this method changes data (use --include-mutating on a test system)'; continue; }
    const { path: p, missing } = buildPath(r.route, samples);
    if (missing.length) { row.note = `needs a sample value for ${missing.join(', ')} (config: verify.samples)`; continue; }
    const url = new URL(p, base);
    if (delayMs && rows.length > 1) await new Promise((res) => setTimeout(res, delayMs));
    try {
      const res = await fetchFn(url, { method, redirect: 'manual', headers: { 'user-agent': 'security-sidecar-verify', accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
      try { await res.body?.cancel(); } catch { /* ignore */ }
      row.status = res.status;
      [row.result, row.note] = judge(r.exposure, res.status, res.headers.get('location'), url.pathname);
      if (r.pathFrom === 'source' && row.result !== 'pass') row.note += ' (path as written in the source; a router mount prefix, if any, is not known)';
    } catch (e) {
      row.result = 'inconclusive';
      row.note = `no response: ${e && e.cause && e.cause.code ? e.cause.code : (e && e.name) || 'error'}`;
    }
  }
  const count = (k) => rows.filter((x) => x.result === k).length;
  const summary = { target: base.origin, checked: rows.length - count('skipped'), pass: count('pass'), gap: count('gap'), inconclusive: count('inconclusive'), skipped: count('skipped') };
  const failing = summary.gap > 0 || (strict && summary.inconclusive > 0);
  return { ok: !failing, exitCode: failing ? 1 : 0, summary, rows };
}

const COLS = [['ROUTE', 'route'], ['METHOD', 'method'], ['RECORDED', 'exposure'], ['STATUS', 'status'], ['RESULT', 'result'], ['NOTE', 'note']];
const cell = (r, k) => String(r[k] === '' || r[k] === undefined ? '-' : r[k]);
const line = (s) => `${s.checked} request(s) sent to ${s.target}: ${s.pass} as recorded, ${s.gap} gap(s), ${s.inconclusive} inconclusive, ${s.skipped} skipped`;

function format(r, kind = 'table') {
  if (kind === 'json') return JSON.stringify({ summary: r.summary, rows: r.rows }, null, 2);
  if (kind === 'csv') {
    const q = (t) => (/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
    return [COLS.map(([h]) => h).join(','), ...r.rows.map((x) => COLS.map(([, k]) => q(String(x[k] ?? ''))).join(','))].join('\n');
  }
  if (kind === 'md' || kind === 'markdown') {
    const esc = (t) => String(t).replace(/\|/g, '\\|');
    return ['# Live verification', '', line(r.summary), '', `| ${COLS.map(([h]) => h).join(' | ')} |`, `| ${COLS.map(() => '---').join(' | ')} |`,
      ...r.rows.map((x) => `| ${COLS.map(([, k]) => esc(cell(x, k))).join(' | ')} |`), ''].join('\n');
  }
  if (kind !== 'table') throw new Error(`unknown format "${kind}" (table, md, json, csv)`);
  const data = r.rows.map((x) => COLS.map(([, k]) => cell(x, k)));
  const w = COLS.map(([h], i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const pad = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(w[i]))).join('  ');
  return [pad(COLS.map(([h]) => h)), ...data.map(pad), '', line(r.summary)].join('\n');
}

module.exports = { verify, format, buildPath, judge, isLocal };
