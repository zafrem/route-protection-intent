'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./routes');
const { protectedRoutes, scanFile } = require('./links');
const { hasAuthSignal } = require('./analyze');
const { validate } = require('./validate');

const NETWORK_RESTRICTIONS = ['ip-allowlist', 'mtls'];
const EXPOSURE_RANK = { unclassified: 0, public: 1, authenticated: 2, internal: 3 };


// No leading '-', so the value can never be read by git as an option.
const SAFE_REF = /^(?!-)[A-Za-z0-9_./~^-]+$/;
function gitShow(root, base, rel) {
  if (!base || !SAFE_REF.test(base)) return null;
  const g = spawnSync('git', ['show', `${base}:./${rel}`], { cwd: root, encoding: 'utf8' });
  return g.status === 0 ? g.stdout : null;
}
// First line of `rf` that differs from `base`, so an annotation lands on the pull request's diff.
function firstChangedLine(root, base, rf) {
  if (!base || !SAFE_REF.test(base)) return undefined;
  const g = spawnSync('git', ['diff', '-U0', base, '--', rf], { cwd: root, encoding: 'utf8' });
  const m = g.status === 0 && /^@@ -\S+ \+(\d+)/m.exec(g.stdout);
  return m ? Math.max(1, Number(m[1])) : undefined;
}
// Where the check is declared to live outside the route code: no signal expected in the handler.
// Sign-in endpoints are reachable before authentication by design, so a missing check there is not drift.
const AUTH_ENTRY = /(^|\/)(login|logout|signin|signup|register|auth|session|callback|oauth)(\/|$)/i;
const EXTERNAL_VIA = ['app-middleware', 'api-gateway', 'waf', 'ip-allowlist', 'mtls'];

// Intent says "needs login" but the route code shows no sign of it, or a PR removed the sign.
function checkAuthDrift(root, sidecarRel, doc, routeFiles = [], base, authRegexes = []) {
  const out = [];
  const secured = Object.values(doc.methods || {}).some((m) => m.exposure === 'authenticated' || m.exposure === 'internal');
  if (!secured || !routeFiles.length) return out;
  const via = (doc.enforcement && doc.enforcement.via) || [];
  const external = via.some((v) => EXTERNAL_VIA.includes(v));
  for (const rf of routeFiles) {
    let now = '';
    try { now = fs.readFileSync(path.join(root, rf), 'utf8'); } catch { continue; }
    const before = gitShow(root, base, rf);
    const hadBefore = before != null && hasAuthSignal(before, authRegexes);
    const hasNow = hasAuthSignal(now, authRegexes);
    if (hadBefore && !hasNow) {
      out.push({ type: 'auth-removed', file: rf, line: firstChangedLine(root, base, rf), message: `an authentication check present at ${base} is gone from this route, but its sidecar (${sidecarRel}) says it must be protected. Restore it, or change the recorded intent on purpose` });
    } else if (!hasNow && !external && !AUTH_ENTRY.test(doc.route || '')) {
      out.push({ type: 'auth-not-found', file: rf, message: `sidecar ${sidecarRel} says this route is protected, but no authentication check was found in the route code. If it is enforced elsewhere (middleware, gateway), record that in enforcement.via` });
    }
  }
  return out;
}

// The route code changed in git after the recorded review date, so the review may no longer hold.
// Day granularity: a change committed on the review day itself is not flagged. No git history, no finding.
function checkReviewStale(root, sidecarRel, doc, routeFiles = []) {
  const r = doc.reason || {};
  if (!r.reviewedAt) return [];
  const out = [];
  for (const rf of routeFiles) {
    const g = spawnSync('git', ['log', '-1', '--format=%cI', '--', rf], { cwd: root, encoding: 'utf8' });
    const changed = g.status === 0 ? g.stdout.trim().slice(0, 10) : '';
    if (changed && changed > r.reviewedAt) {
      out.push({ type: 'review-stale', file: rf, message: `route code last changed ${changed}, after the review by ${r.reviewedBy || 'unknown'} on ${r.reviewedAt} (${sidecarRel}). Re-check the intent, then update reason.reviewedAt` });
    }
  }
  return out;
}

function checkIntentCodeDrift(root, sidecarRel, doc, routeFiles = []) {
  const out = [];
  const methods = Object.values(doc.methods || {});
  const wantsNoStore = methods.some((m) => m.cache && m.cache.policy === 'no-store');
  const wantsNoIndex = methods.some((m) => m.indexing === 'noindex');
  const wantsIndex = methods.length > 0 && methods.every((m) => m.indexing === 'index');

  for (const rf of routeFiles) {
    let src = '';
    try { src = fs.readFileSync(path.join(root, rf), 'utf8'); } catch { continue; }
    if (wantsNoStore) {
      if (/\bexport\s+const\s+dynamic\s*=\s*['"]force-static['"]/.test(src)
          || /\bexport\s+const\s+revalidate\s*=\s*[1-9]\d*/.test(src)) {
        out.push({
          type: 'intent-code-mismatch',
          file: sidecarRel,
          message: `${rf} enables static caching (force-static / revalidate > 0) while sidecar requires cache.policy "no-store"`,
        });
      }
    }
    if (wantsNoIndex && /\brobots\s*:\s*(?:\{[^}]*\bindex\s*:\s*true\b|['"]index['"])/.test(src)) {
      out.push({
        type: 'intent-code-mismatch',
        file: sidecarRel,
        message: `${rf} sets robots index:true while sidecar requires indexing "noindex"`,
      });
    }
    if (wantsIndex && /\brobots\s*:\s*(?:\{[^}]*\bindex\s*:\s*false\b|['"]noindex['"])/.test(src)) {
      out.push({
        type: 'intent-code-mismatch',
        file: sidecarRel,
        message: `${rf} sets robots noindex while sidecar requires indexing "index"`,
      });
    }
  }
  return out;
}

function diffSidecar(oldDoc, newDoc, rel) {
  const out = [];
  if (!oldDoc || !newDoc || !oldDoc.methods || !newDoc.methods) return out;
  if (oldDoc.mode === 'enforce' && (newDoc.mode || 'annotate') !== 'enforce') {
    out.push({ type: 'policy-downgrade', file: rel, message: 'mode downgraded from "enforce" to "annotate"' });
  }
  if (oldDoc.gate && !newDoc.gate) {
    out.push({ type: 'policy-downgrade', file: rel, message: `gate (${oldDoc.gate.type}) was removed` });
  }
  const oldVia = (oldDoc.enforcement && oldDoc.enforcement.via) || [];
  const newVia = (newDoc.enforcement && newDoc.enforcement.via) || [];
  for (const nr of NETWORK_RESTRICTIONS) {
    if (oldVia.includes(nr) && !newVia.includes(nr)) {
      out.push({ type: 'policy-downgrade', file: rel, message: `network restriction "${nr}" was removed from enforcement.via` });
    }
  }
  for (const [m, oldP] of Object.entries(oldDoc.methods)) {
    const newP = newDoc.methods[m] || newDoc.methods['*'];
    if (!newP) continue;
    if (EXPOSURE_RANK[newP.exposure] < EXPOSURE_RANK[oldP.exposure]) {
      out.push({ type: 'policy-downgrade', file: rel, message: `${m} exposure downgraded from "${oldP.exposure}" to "${newP.exposure}"` });
    }
    if (oldP.rateLimit && !newP.rateLimit) {
      out.push({ type: 'policy-downgrade', file: rel, message: `${m} rateLimit was removed` });
    }
  }
  return out;
}

// Path of `root` inside its git repository ('' at the top). GitHub annotations need repo-relative paths.
function repoPrefix(root) {
  const g = spawnSync('git', ['rev-parse', '--show-prefix'], { cwd: root, encoding: 'utf8' });
  return g.status === 0 ? g.stdout.trim() : '';
}

// Why `--base` cannot be used, or null when it can. Silently skipping the comparison would make a
// pipeline look green while the removed-check and downgrade findings do nothing.
function baseProblem(root, base) {
  if (!SAFE_REF.test(base)) return `--base "${base}" is not a valid git ref`;
  const g = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root, encoding: 'utf8' });
  if (g.status !== 0) return `--base "${base}" cannot be resolved here (typo, missing fetch, or a shallow clone: use fetch-depth: 0). No comparison was made`;
  return null;
}

function check(root = process.cwd(), { strict = false, base } = {}) {
  const config = R.loadConfig(root);
  const findings = [];
  if (base !== undefined) {
    const problem = baseProblem(root, String(base));
    if (problem) { findings.push({ type: 'base-unresolved', file: '', message: problem }); base = undefined; }
  }
  const allFiles = [];
  const expected = new Set();   // sidecars that should exist
  const routeFilesBySidecar = new Map();
  const existing = [];          // sidecars on disk

  R.walk(root, (rel) => {
    allFiles.push(rel);
    if (R.isRouteFile(rel, config)) {
      const sc = R.sidecarPathFor(rel);
      expected.add(sc);
      if (!routeFilesBySidecar.has(sc)) routeFilesBySidecar.set(sc, []);
      routeFilesBySidecar.get(sc).push(rel);
    }
    if (/(^|\/)(?:[A-Za-z0-9_-]+)?\.route\.json$/.test(rel)) existing.push(rel);
  });

  const docs = new Map();
  for (const rel of existing) {
    if (R.inStaticDir(rel)) {
      findings.push({ type: 'static-served', file: rel, message: 'sidecar sits in a statically served directory and may be public' });
    }
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); }
    catch (e) { findings.push({ type: 'schema', file: rel, message: `invalid JSON: ${e.message}` }); continue; }
    const v = validate(doc);
    if (!v.valid) { findings.push({ type: 'schema', file: rel, message: v.errors.join('; ') }); continue; }
    docs.set(rel, doc);
    const open = Object.entries(doc.methods).filter(([, p]) => p.exposure === 'unclassified').map(([m]) => m);
    if (open.length) findings.push({ type: 'unclassified', file: rel, message: `unclassified exposure for ${open.join(', ')}` });
    const via = (doc.enforcement && doc.enforcement.via) || [];
    if ((R.docIsAdmin(doc, config.adminPaths) || Object.values(doc.methods).some((p) => p.exposure === 'internal'))
        && !via.some((v) => NETWORK_RESTRICTIONS.includes(v))) {
      findings.push({ type: 'admin-no-network-restriction', file: rel, message: `${doc.route} is admin/internal but enforcement.via lacks ${NETWORK_RESTRICTIONS.join(' or ')}; a hidden path or login alone is not a network restriction` });
    }
    if (doc.linkable === true && !(doc.reason && doc.reason.source === 'user')) {
      findings.push({ type: 'linkable-not-approved', file: rel, message: '"linkable": true is set but reason.source is not "user"; confirm with the user that this route may be linked' });
    }
    if (R.docIsAdmin(doc, config.adminPaths) && !doc.gate) {
      findings.push({ type: 'admin-no-gate', file: rel, message: `${doc.route} is an admin route with no extra gate recorded (passphrase of 8+ characters, SSO or MFA); a login alone is one factor` });
    }
    if (!expected.has(rel)) findings.push({ type: 'orphan', file: rel, message: 'no matching route source (deleted or renamed?)' });
    else {
      const rfs = routeFilesBySidecar.get(rel);
      findings.push(...checkIntentCodeDrift(root, rel, doc, rfs));
      findings.push(...checkAuthDrift(root, rel, doc, rfs, base, config.authRegexes));
      findings.push(...checkReviewStale(root, rel, doc, rfs));
    }
    const old = gitShow(root, base, rel);
    if (old) { try { findings.push(...diffSidecar(JSON.parse(old), doc, rel)); } catch { /* ignore invalid base json */ } }
  }
  for (const rel of [...expected].sort()) {
    if (!existing.includes(rel)) findings.push({ type: 'missing', file: rel, message: 'route has no sidecar' });
  }

  const prot = protectedRoutes(docs, config.adminPaths);
  if (prot.length) for (const rel of allFiles) findings.push(...scanFile(root, rel, prot));

  // Show the person's reason next to a finding, so a reviewer sees why the route was set up this way.
  const sidecarOfRoute = new Map();
  for (const [sc, files] of routeFilesBySidecar) for (const rf of files) sidecarOfRoute.set(rf, sc);
  for (const f of findings) {
    const doc = docs.get(f.file) || docs.get(sidecarOfRoute.get(f.file));
    const notes = doc ? Object.entries(doc.methods).filter(([, p]) => p.note).map(([m, p]) => `${m}: ${p.note}`) : [];
    if (notes.length) f.note = notes.join('; ');
  }

  const enforcing = (f) => docs.get(f.file)?.mode === 'enforce';
  const failing = findings.filter((f) => strict || enforcing(f) || f.type === 'base-unresolved');
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.type < b.type ? -1 : 1));
  return {
    ok: failing.length === 0, exitCode: failing.length ? 1 : 0, strict,
    routes: expected.size, sidecars: existing.length, findings, pathPrefix: repoPrefix(root),
    summary: findings.length ? `${findings.length} finding(s)` : 'all routes have valid sidecars',
  };
}

function format(r) {
  const lines = r.findings.map((f) => `  [${f.type}] ${f.file ? `${f.file}: ` : ''}${f.message}${f.note ? `\n      note: ${f.note}` : ''}`);
  const head = `route-protection-intent check: ${r.routes} route(s), ${r.sidecars} sidecar(s) - ${r.summary}`;
  const tail = (r.findings.length && !r.strict && r.exitCode === 0
    ? '\n(annotate mode: warnings only, exit 0. Use --strict to fail on findings.)' : '');
  return [head, ...lines].join('\n') + tail;
}

// GitHub Actions annotations: show findings on the pull request's changed lines.
const ERROR_TYPES = new Set(['auth-removed', 'policy-downgrade', 'base-unresolved']);
// Findings per severity, the same split formatGithub uses for error vs warning annotations.
function countFindings(r) {
  const errors = r.findings.filter((f) => ERROR_TYPES.has(f.type)).length;
  return { findings: r.findings.length, errors, warnings: r.findings.length - errors, routes: r.routes };
}
function formatGithub(r) {
  const esc = (t) => String(t).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return r.findings.map((f) => `::${ERROR_TYPES.has(f.type) ? 'error' : 'warning'} ${f.file ? `file=${(r.pathPrefix || '') + f.file}${f.line ? `,line=${f.line}` : ''},` : ''}title=${f.type}::${esc(f.message + (f.note ? ` Note recorded for this route: ${f.note}` : ''))}`).join('\n');
}

module.exports = { check, format, formatGithub, countFindings, diffSidecar, AUTH_ENTRY, EXTERNAL_VIA };
