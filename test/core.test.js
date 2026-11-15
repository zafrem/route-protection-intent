'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { analyzeSource, analyze } = require('../src/analyze');
const { save } = require('../src/save');
const { check, countFindings } = require('../src/check');
const { report, format: formatReport } = require('../src/report');
const { compile } = require('../src/compile');
const R = require('../src/routes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

test('detects route files and derives URLs', () => {
  assert.ok(R.isRouteFile('app/api/login/route.ts'));
  assert.ok(!R.isRouteFile('app/components/Button.tsx'));
  assert.ok(!R.isRouteFile('node_modules/x/routes/a.js'));
  assert.strictEqual(R.routeFromPath('app/(shop)/products/[id]/page.tsx'), '/products/[id]');
  assert.strictEqual(R.routeFromPath('src/app/api/v1/payment/route.ts'), '/api/v1/payment');
  assert.strictEqual(R.routeFromPath('pages/api/users.ts'), '/api/users');
  assert.strictEqual(R.routeFromPath('server/routes/orders.js'), '/orders');
});

test('classification is conservative', () => {
  const a = analyzeSource({ relPath: 'app/api/login/route.ts', source: 'export async function POST(){}' });
  assert.strictEqual(a.confidence, 'high');
  assert.strictEqual(a.suggestion.exposure, 'authenticated');
  const b = analyzeSource({ relPath: 'app/reports/route.ts', source: 'export async function GET(){}' });
  assert.strictEqual(b.needsUserInput, true);
  assert.strictEqual(b.suggestion.exposure, 'authenticated');
  assert.ok(b.options.some((o) => o.policy.methods.GET.exposure === 'unclassified'));
  const c = analyzeSource({ relPath: 'app/blog/page.tsx', source: '' });
  assert.strictEqual(c.suggestion.exposure, 'public');
});

test('save validates, is deterministic, and preserves human edits', () => {
  const d = tmp();
  const policy = { route: '/api/x', methods: { POST: { cache: { policy: 'no-store' }, exposure: 'authenticated' } }, reason: { source: 'heuristic', rule: 'r' } };
  const r1 = save(d, policy);
  assert.ok(r1.ok);
  const text = fs.readFileSync(path.join(d, '.route.json'), 'utf8');
  assert.ok(text.indexOf('"exposure"') < text.indexOf('"cache"'), 'stable key order');
  assert.strictEqual(JSON.parse(text).mode, 'annotate');
  assert.strictEqual(save(d, policy).written, false, 'idempotent');

  // person edits notes + picks a value
  const doc = JSON.parse(text); doc.notes = 'hand written'; doc.reason = { source: 'user' }; doc.methods.POST.exposure = 'internal';
  fs.writeFileSync(path.join(d, '.route.json'), JSON.stringify(doc));
  assert.ok(save(d, policy).ok);
  const after = JSON.parse(fs.readFileSync(path.join(d, '.route.json'), 'utf8'));
  assert.strictEqual(after.notes, 'hand written');
  assert.strictEqual(after.methods.POST.exposure, 'internal');
});

test('save rejects schema violations and secrets, writing nothing', () => {
  const d = tmp();
  const bad = save(d, { route: '/a', methods: { GET: { exposure: 'nope' } } });
  assert.strictEqual(bad.code, 2);
  const unk = save(d, { route: '/a', methods: { GET: { exposure: 'public' } }, extra: 1 });
  assert.strictEqual(unk.code, 2);
  for (const notes of ['postgres://admin:hunter22@db/prod', 'token=abcdef123456', 'AKIAABCDEFGHIJKLMNOP']) {
    const r = save(d, { route: '/a', methods: { GET: { exposure: 'public' } }, notes });
    assert.strictEqual(r.code, 2, notes);
  }
  assert.strictEqual(save(d, { route: '/a', methods: { GET: { exposure: 'public' } } }, { file: '../evil.route.json' }).code, 2);
  assert.deepStrictEqual(fs.readdirSync(d), []);
});

test('check: missing, orphan, unclassified, static; annotate exits 0, strict exits 1', () => {
  const root = tmp();
  put(root, 'app/api/a/route.ts', 'export function GET(){}');
  put(root, 'app/api/b/route.ts', 'export function GET(){}');
  put(root, 'app/api/b/.route.json', JSON.stringify({ version: 1, route: '/api/b', methods: { GET: { exposure: 'unclassified' } } }));
  put(root, 'app/gone/.route.json', JSON.stringify({ version: 1, route: '/gone', methods: { GET: { exposure: 'public' } } }));
  put(root, 'public/.route.json', JSON.stringify({ version: 1, route: '/p', methods: { GET: { exposure: 'public' } } }));
  const r = check(root);
  const types = r.findings.map((f) => f.type).sort();
  assert.deepStrictEqual(types, ['missing', 'orphan', 'orphan', 'static-served', 'unclassified']);
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(check(root, { strict: true }).exitCode, 1);
});

test('check fails on violations in enforce-mode sidecars', () => {
  const root = tmp();
  put(root, 'app/x/route.ts', 'export function GET(){}');
  put(root, 'app/x/.route.json', JSON.stringify({ version: 1, mode: 'enforce', route: '/x', methods: { GET: { exposure: 'unclassified' } } }));
  assert.strictEqual(check(root).exitCode, 1);
});

test('compile: enforce only, skips by via, refuses unclassified', () => {
  const root = tmp();
  const w = (rel, doc) => put(root, rel, JSON.stringify({ version: 1, ...doc }));
  w('app/a/.route.json', { mode: 'enforce', route: '/admin/a', methods: { GET: { exposure: 'internal' } }, enforcement: { via: ['ip-allowlist'] } });
  w('app/b/.route.json', { mode: 'enforce', route: '/b/[id]', methods: { POST: { exposure: 'authenticated', cache: { policy: 'no-store' }, rateLimit: { windowMs: 60000, max: 10 } } }, enforcement: { via: ['api-gateway'] } });
  w('app/c/.route.json', { mode: 'enforce', route: '/c', methods: { GET: { exposure: 'public' } }, enforcement: { via: ['app-middleware'] } });
  w('app/d/.route.json', { route: '/d', methods: { GET: { exposure: 'unclassified' } } });
  const r = compile(root, 'nginx');
  assert.ok(r.ok);
  assert.strictEqual(r.compiled, 2);
  assert.deepStrictEqual(r.skipped.map((s) => s.route), ['/c']);
  const conf = fs.readFileSync(r.target, 'utf8');
  assert.match(conf, /location = \/admin\/a/);
  assert.match(conf, /location ~ \^\/b\/\[\^\/\]\+\$/);
  assert.match(conf, /limit_req_zone .* rate=10r\/m/);
  assert.ok(!conf.includes('/d'), 'annotate sidecars are not compiled');
  assert.strictEqual(compile(root, 'unknown-target').ok, false);
  const nx = compile(root, 'nextjs');
  assert.ok(nx.ok);
  assert.strictEqual(nx.compiled, 2);
  const nxMod = require(nx.target);
  assert.strictEqual(nxMod.routePolicies.length, 2);
  const cf = compile(root, 'cloudflare');
  assert.ok(cf.ok);
  assert.match(fs.readFileSync(cf.target, 'utf8'), /WAF block\/allowlist rule \(internal\):/);
  w('app/e/.route.json', { mode: 'enforce', route: '/e', methods: { GET: { exposure: 'unclassified' } } });
  assert.strictEqual(compile(root, 'nginx').code, 1);
});

test('plugin hook emits context for route files only, and the bundle is current', () => {
  const hook = path.join(__dirname, '..', 'plugins', 'route-protection-intent', 'hooks', 'post-tool-use.js');
  const root = tmp();
  put(root, 'app/api/login/route.ts', 'export async function POST(){}');
  put(root, 'lib/util.ts', 'export const x = 1');
  const run = (file) => spawnSync('node', [hook], { input: JSON.stringify({ cwd: root, tool_input: { file_path: path.join(root, file) } }), encoding: 'utf8' });
  const hit = JSON.parse(run('app/api/login/route.ts').stdout);
  assert.match(hit.hookSpecificOutput.additionalContext, /"route": "\/api\/login"/);
  assert.strictEqual(run('lib/util.ts').stdout, '');
  for (const f of ['src/analyze.js', 'src/save.js', 'src/check.js', 'src/compile.js', 'src/routes.js', 'src/targets/nginx.js', 'src/targets/nextjs.js', 'src/targets/cloudflare.js', 'src/links.js', 'src/guidance.js', 'schema/route.schema.json']) {
    assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'plugins/route-protection-intent/cli', f), 'utf8'), fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), `${f} out of date; run npm run bundle`);
  }
});

test('adminPaths config classifies renamed admin paths without prompting', () => {
  const adminPaths = ['/ops-k7Qx92mVbT4nLw'];
  const a = analyzeSource({ relPath: 'app/ops-k7Qx92mVbT4nLw/users/route.ts', source: 'export function GET(){}', adminPaths });
  assert.strictEqual(a.confidence, 'high');
  assert.strictEqual(a.policy.reason.rule, 'config-admin-path');
  assert.strictEqual(a.suggestion.indexing, 'noindex');
  assert.strictEqual(analyzeSource({ relPath: 'app/ops-k7Qx92mVbT4nLw/route.ts', source: 'export function GET(){}' }).needsUserInput, true, 'unconfigured path still asks');
  assert.ok(R.isAdminRoute('/ops-abc/x', ['/ops-*']));
  assert.ok(!R.isAdminRoute('/ops-abc-extra', ['/ops-abc']));
});

test('check warns when admin/internal routes lack a network restriction', () => {
  const root = tmp();
  put(root, '.route-protection-intent.config.json', JSON.stringify({ adminPaths: ['/ops-k7Qx92mVbT4nLw'] }));
  const w = (dir, route, via, exposure = 'authenticated') => {
    put(root, `app/${dir}/route.ts`, 'export function GET(){}');
    put(root, `app/${dir}/.route.json`, JSON.stringify({ version: 1, route, methods: { GET: { exposure } }, ...(via ? { enforcement: { via } } : {}) }));
  };
  w('ops-k7Qx92mVbT4nLw', '/ops-k7Qx92mVbT4nLw', ['app-middleware']);
  w('admin', '/admin', ['ip-allowlist']);
  w('jobs', '/jobs', null, 'internal');
  w('shop', '/shop', null, 'public');
  const hits = check(root).findings.filter((f) => f.type === 'admin-no-network-restriction').map((f) => f.file).sort();
  assert.deepStrictEqual(hits, ['app/jobs/.route.json', 'app/ops-k7Qx92mVbT4nLw/.route.json']);
  assert.strictEqual(check(root).exitCode, 0, 'warning only in annotate mode');
  assert.strictEqual(check(root, { strict: true }).exitCode, 1);
});

test('analyze gives guidance and asks for a gate on admin routes', () => {
  const a = analyzeSource({ relPath: 'app/admin/route.ts', source: 'export function GET(){}' });
  assert.strictEqual(a.needsGate, true);
  assert.ok(a.gateOptions.some((o) => o.gate && o.gate.minLength === 8));
  assert.ok(a.guidance.some((g) => /404/.test(g)));
  const p = analyzeSource({ relPath: 'app/blog/page.tsx', source: '' });
  assert.ok(p.guidance.some((g) => /sitemap/i.test(g)));
  assert.strictEqual(p.needsGate, undefined);
  assert.ok(analyzeSource({ relPath: 'app/reports/route.ts', source: 'export function GET(){}' }).options.some((o) => /SEO/.test(o.label)));
});

test('gate: passphrase needs 8+ chars, no secret stored, human setting preserved', () => {
  const d = tmp();
  const base = { route: '/admin', methods: { GET: { exposure: 'authenticated' } } };
  assert.strictEqual(save(d, { ...base, gate: { type: 'passphrase', minLength: 4 } }).code, 2);
  assert.strictEqual(save(d, { ...base, gate: { type: 'passphrase', password: 'hunter2hunter2' } }).code, 2);
  assert.ok(save(d, { ...base, gate: { type: 'passphrase', minLength: 12 } }).ok);
  assert.ok(save(d, base).ok, 're-save without gate');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, '.route.json'), 'utf8')).gate.minLength, 12);
});

test('check flags links to admin routes outside the route, unless linkable', () => {
  const root = tmp();
  put(root, 'app/admin/route.ts', 'export function GET(){}');
  put(root, 'app/admin/users/page.tsx', 'export default () => <a href="/admin">back</a>');
  put(root, 'app/admin/.route.json', JSON.stringify({ version: 1, route: '/admin', gate: { type: 'sso' }, methods: { GET: { exposure: 'authenticated' } }, enforcement: { via: ['ip-allowlist'] } }));
  put(root, 'app/page.tsx', 'export default () => <a href="/admin">Admin</a>');
  put(root, 'app/api/admin-stats/route.ts', 'const x = "/administrator"; const y = "/api/admin"');
  put(root, 'public/robots.txt', 'Disallow: /admin');
  put(root, 'app/layout.tsx', 'const u = "https://site.com/admin"');
  const exposed = check(root).findings.filter((f) => f.type === 'admin-path-exposed').map((f) => f.file).sort();
  assert.deepStrictEqual(exposed, ['app/layout.tsx', 'app/page.tsx', 'public/robots.txt']);
  assert.ok(!check(root).findings.some((f) => f.type === 'admin-no-gate'), 'gate recorded');
  const side = path.join(root, 'app/admin/.route.json');
  fs.writeFileSync(side, JSON.stringify({ ...JSON.parse(fs.readFileSync(side, 'utf8')), linkable: true }));
  assert.strictEqual(check(root).findings.filter((f) => f.type === 'admin-path-exposed').length, 0);
});

test('check warns when an admin route has no gate', () => {
  const root = tmp();
  put(root, 'app/admin/route.ts', 'export function GET(){}');
  put(root, 'app/admin/.route.json', JSON.stringify({ version: 1, route: '/admin', methods: { GET: { exposure: 'authenticated' } } }));
  assert.ok(check(root).findings.some((f) => f.type === 'admin-no-gate'));
});

test('hook warns when a non-route file links to an admin route', () => {
  const hook = path.join(__dirname, '..', 'plugins', 'route-protection-intent', 'hooks', 'post-tool-use.js');
  const root = tmp();
  put(root, 'app/admin/route.ts', 'export function GET(){}');
  put(root, 'app/admin/.route.json', JSON.stringify({ version: 1, route: '/admin', methods: { GET: { exposure: 'authenticated' } } }));
  put(root, 'components/Nav.tsx', 'export const Nav = () => <a href="/admin">x</a>');
  put(root, 'components/Footer.tsx', 'export const Footer = () => null');
  const run = (file) => spawnSync('node', [hook], { input: JSON.stringify({ cwd: root, tool_input: { file_path: path.join(root, file) } }), encoding: 'utf8' }).stdout;
  assert.match(JSON.parse(run('components/Nav.tsx')).hookSpecificOutput.additionalContext, /components\/Nav\.tsx:1 -> \/admin/);
  assert.strictEqual(run('components/Footer.tsx'), '');
});

test('linkable needs user approval: save refuses, check flags hand edits', () => {
  const d = tmp();
  const base = { route: '/admin', methods: { GET: { exposure: 'authenticated' } } };
  const refused = save(d, { ...base, linkable: true, reason: { source: 'agent' } });
  assert.strictEqual(refused.code, 2);
  assert.match(refused.error, /approval/);
  assert.deepStrictEqual(fs.readdirSync(d), []);
  assert.ok(save(d, { ...base, linkable: true, reason: { source: 'user' } }).ok);
  assert.ok(save(d, { ...base, reason: { source: 'heuristic' } }).ok, 're-save keeps an approved linkable');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, '.route.json'), 'utf8')).linkable, true);

  const root = tmp();
  put(root, 'app/admin/route.ts', 'export function GET(){}');
  put(root, 'app/admin/.route.json', JSON.stringify({ ...base, version: 1, linkable: true, reason: { source: 'heuristic' }, gate: { type: 'sso' } }));
  assert.ok(check(root).findings.some((f) => f.type === 'linkable-not-approved'));
  put(root, 'app/admin/.route.json', JSON.stringify({ ...base, version: 1, linkable: true, reason: { source: 'user' }, gate: { type: 'sso' } }));
  assert.ok(!check(root).findings.some((f) => f.type === 'linkable-not-approved'));
});

test('quiet config is reported by analyze and defaults to off', () => {
  const { analyze } = require('../src/analyze');
  const root = tmp();
  put(root, 'app/api/x/route.ts', 'export async function POST(){}');
  assert.strictEqual(analyze('app/api/x/route.ts', { root }).quiet, false);
  put(root, '.route-protection-intent.config.json', JSON.stringify({ quiet: true }));
  assert.strictEqual(analyze('app/api/x/route.ts', { root }).quiet, true);
  put(root, '.route-protection-intent.config.json', JSON.stringify({ quiet: 'yes' }));
  assert.strictEqual(analyze('app/api/x/route.ts', { root }).quiet, false, 'only boolean true counts');
  // quiet never hides findings
  put(root, 'app/api/x/route.ts', 'export async function POST(){}');
  assert.ok(check(root).findings.some((f) => f.type === 'missing'));
});

test('hook carries the quiet-mode instruction only when quiet is on', () => {
  const hook = path.join(__dirname, '..', 'plugins', 'route-protection-intent', 'hooks', 'post-tool-use.js');
  const root = tmp();
  put(root, 'app/api/x/route.ts', 'export async function POST(){}');
  const run = () => JSON.parse(spawnSync('node', [hook], { input: JSON.stringify({ cwd: root, tool_input: { file_path: path.join(root, 'app/api/x/route.ts') } }), encoding: 'utf8' }).stdout).hookSpecificOutput.additionalContext;
  assert.ok(!/QUIET MODE/.test(run()));
  put(root, '.route-protection-intent.config.json', JSON.stringify({ quiet: true }));
  assert.match(run(), /QUIET MODE is on/);
});

test('analyze: source auth signals boost confidence and per-method policies are preserved', () => {
  const a = analyzeSource({
    relPath: 'app/reports/route.ts',
    source: 'export async function GET() { const s = await getServerSession(); return Response.json(s); }',
  });
  assert.strictEqual(a.hasAuthSignal, true);
  assert.strictEqual(a.confidence, 'high');
  assert.strictEqual(a.needsUserInput, false);
  assert.strictEqual(a.policy.reason.rule, 'source-auth-signal');

  const multi = analyzeSource({
    relPath: 'app/blog/route.ts',
    source: 'export async function GET() {}\nexport async function POST() {}',
  });
  assert.strictEqual(multi.confidence, 'high');
  assert.strictEqual(multi.policy.methods.GET.exposure, 'public');
  assert.strictEqual(multi.policy.methods.POST.exposure, 'authenticated');
});

test('check detects intent-code-mismatch and policy-downgrade against git base', () => {
  const { diffSidecar } = require('../src/check');
  const root = tmp();
  put(root, 'app/api/orders/route.ts', "export const dynamic = 'force-static';\nexport function GET(){}");
  put(root, 'app/api/orders/.route.json', JSON.stringify({
    version: 1,
    route: '/api/orders',
    methods: { GET: { exposure: 'authenticated', cache: { policy: 'no-store' } } },
  }));
  put(root, 'app/secret/page.tsx', 'export const metadata = { robots: { index: true } };\nexport default function P(){ return null; }');
  put(root, 'app/secret/.route.json', JSON.stringify({
    version: 1,
    route: '/secret',
    methods: { GET: { exposure: 'authenticated', indexing: 'noindex' } },
  }));
  const drift = check(root).findings.filter((f) => f.type === 'intent-code-mismatch');
  assert.strictEqual(drift.length, 2);

  const oldDoc = {
    version: 1,
    mode: 'enforce',
    route: '/admin',
    gate: { type: 'sso' },
    enforcement: { via: ['ip-allowlist'] },
    methods: { POST: { exposure: 'internal', rateLimit: { windowMs: 60000, max: 5 } } },
  };
  const newDoc = {
    version: 1,
    mode: 'annotate',
    route: '/admin',
    enforcement: { via: ['app-middleware'] },
    methods: { POST: { exposure: 'public' } },
  };
  const downs = diffSidecar(oldDoc, newDoc, 'app/admin/.route.json');
  assert.strictEqual(downs.length, 5);

  spawnSync('git', ['init'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  put(root, 'app/admin/route.ts', 'export function POST(){}');
  put(root, 'app/admin/.route.json', JSON.stringify(oldDoc));
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
  put(root, 'app/admin/.route.json', JSON.stringify(newDoc));
  const gitCheck = check(root, { base: 'HEAD' });
  const gitDowns = gitCheck.findings.filter((f) => f.type === 'policy-downgrade');
  assert.strictEqual(gitDowns.length, 5);
});

test('detects Go and Java routes and gives language-specific guidance', () => {
  assert.ok(R.isRouteFile('routes/orders.go'));
  assert.ok(R.isRouteFile('routes/OrdersController.java'));
  assert.ok(!R.isRouteFile('routes/orders_test.go'));
  assert.ok(!R.isRouteFile('routes/OrdersTest.java'));
  const goRes = analyzeSource({ relPath: 'routes/orders.go', source: 'r.Post("/orders", createOrder)' });
  assert.deepStrictEqual(goRes.methods, ['POST']);
  const javaRes = analyzeSource({ relPath: 'routes/Orders.java', source: '@GetMapping("/orders")\n@PostMapping("/orders")' });
  assert.deepStrictEqual(javaRes.methods, ['GET', 'POST']);
});

test('auth drift: flags a protected route with no auth check, and one removed since the base ref', () => {
  const { formatGithub } = require('../src/check');
  const root = tmp();
  const doc = { version: 1, route: '/api/orders', methods: { GET: { exposure: 'authenticated' } } };
  const guarded = "export async function GET(){ const s = await getServerSession(); if(!s) return new Response('no',{status:401}); }";
  spawnSync('git', ['init'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: root });
  put(root, 'app/api/orders/route.ts', guarded);
  put(root, 'app/api/orders/.route.json', JSON.stringify(doc));
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
  assert.ok(!check(root, { base: 'HEAD' }).findings.some((f) => /^auth-/.test(f.type)), 'guarded route is clean');
  put(root, 'app/api/orders/route.ts', 'export async function GET(){ return Response.json([]); }');
  const r = check(root, { base: 'HEAD' });
  assert.ok(r.findings.some((f) => f.type === 'auth-removed' && f.file === 'app/api/orders/route.ts'));
  assert.ok(!r.findings.some((f) => f.type === 'auth-not-found'), 'removal is reported once');
  assert.ok(/^::error file=app\/api\/orders\/route\.ts,line=1,title=auth-removed::/.test(formatGithub(r)));
  const noBase = check(root);
  assert.ok(noBase.findings.some((f) => f.type === 'auth-not-found'), 'without a base it still warns');
  put(root, 'app/api/orders/.route.json', JSON.stringify({ ...doc, enforcement: { via: ['api-gateway'] } }));
  assert.ok(!check(root).findings.some((f) => f.type === 'auth-not-found'), 'declared external enforcement is not flagged');
  put(root, 'app/api/login/route.ts', 'export async function POST(){ return Response.json({}); }');
  put(root, 'app/api/login/.route.json', JSON.stringify({ version: 1, route: '/api/login', methods: { POST: { exposure: 'authenticated' } } }));
  assert.ok(!check(root).findings.some((f) => f.type === 'auth-not-found' && f.file.includes('login')), 'sign-in endpoints are exempt');
  put(root, 'app/api/orders/.route.json', JSON.stringify({ ...doc, methods: { GET: { exposure: 'public' } } }));
  assert.ok(!check(root, { base: 'HEAD' }).findings.some((f) => /^auth-/.test(f.type)), 'public routes need no auth check');
});

test('check --base works when the checked folder is a subdirectory of the repo', () => {
  const { formatGithub } = require('../src/check');
  const repo = tmp();
  const sub = path.join(repo, 'examples', 'app');
  spawnSync('git', ['init'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  put(repo, 'examples/app/app/api/orders/route.ts', 'export async function GET(){ await getServerSession(); }');
  put(repo, 'examples/app/app/api/orders/.route.json', JSON.stringify({ version: 1, route: '/api/orders', methods: { GET: { exposure: 'authenticated' } } }));
  spawnSync('git', ['add', '.'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });
  put(repo, 'examples/app/app/api/orders/route.ts', 'export async function GET(){ return Response.json([]); }');
  const r = check(sub, { base: 'HEAD' });
  assert.ok(r.findings.some((f) => f.type === 'auth-removed'), 'base lookup works from a subdirectory');
  assert.ok(formatGithub(r).includes('file=examples/app/app/api/orders/route.ts,line=1,'), 'annotation path is repo-relative and has a line');
});

test('auth-removed annotation points at the first changed line', () => {
  const { formatGithub } = require('../src/check');
  const root = tmp();
  spawnSync('git', ['init'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: root });
  const lines = ['import x from "y";', '', 'export async function GET(){', '  const s = await getServerSession();', '  if (!s) return new Response("no",{status:401});', '  return Response.json([]);', '}', ''];
  put(root, 'app/api/orders/route.ts', lines.join('\n'));
  put(root, 'app/api/orders/.route.json', JSON.stringify({ version: 1, route: '/api/orders', methods: { GET: { exposure: 'authenticated' } } }));
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
  put(root, 'app/api/orders/route.ts', [lines[0], lines[1], lines[2], lines[5], lines[6], ''].join('\n'));
  const f = check(root, { base: 'HEAD' }).findings.find((x) => x.type === 'auth-removed');
  assert.strictEqual(f.line, 3, 'a deletion is reported on the line before it (the handler)');
  assert.ok(formatGithub({ findings: [f], pathPrefix: '' }).includes(',line=3,title=auth-removed::'));
});

test('per-method note: saved, kept on re-save, shown by check, validated', () => {
  const { formatGithub } = require('../src/check');
  const root = tmp();
  const dir = path.join(root, 'app', 'api', 'orders');
  fs.mkdirSync(dir, { recursive: true });
  put(root, 'app/api/orders/route.ts', 'export async function GET(){}\nexport async function POST(){}');
  const policy = { route: '/api/orders', methods: { GET: { exposure: 'public', note: 'status page, safe to cache' }, POST: { exposure: 'authenticated', note: 'creates an order' } }, reason: { source: 'user' } };
  assert.strictEqual(save(dir, policy).code, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, '.route.json'), 'utf8'));
  assert.strictEqual(saved.methods.POST.note, 'creates an order');
  assert.deepStrictEqual(Object.keys(saved.methods.GET), ['exposure', 'note'], 'note is written last');
  // a later heuristic save without notes keeps them
  const again = { route: '/api/orders', methods: { GET: { exposure: 'public' }, POST: { exposure: 'authenticated' } }, reason: { source: 'heuristic', rule: 'x' } };
  save(dir, again);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, '.route.json'), 'utf8')).methods.POST.note, 'creates an order');
  // findings carry the note
  const r = check(root);
  const f = r.findings.find((x) => x.file === 'app/api/orders/route.ts' && x.type === 'auth-not-found');
  assert.ok(f && /POST: creates an order/.test(f.note));
  assert.ok(/note: .*creates an order/.test(require('../src/check').format(r)));
  assert.ok(/Note recorded for this route/.test(formatGithub(r)));
  // validation and secret scan apply
  assert.strictEqual(save(dir, { ...policy, methods: { GET: { exposure: 'public', note: 'x'.repeat(301) } } }).code, 2);
  assert.strictEqual(save(dir, { ...policy, methods: { GET: { exposure: 'public', note: 'token ghp_' + 'a'.repeat(36) } } }).code, 2);
});

test('--base that cannot be used fails loudly instead of skipping the comparison', () => {
  const { formatGithub } = require('../src/check');
  const root = tmp();
  put(root, 'app/api/orders/route.ts', 'export async function GET(){ await getServerSession(); }');
  put(root, 'app/api/orders/.route.json', JSON.stringify({ version: 1, route: '/api/orders', methods: { GET: { exposure: 'authenticated' } } }));
  for (const bad of ['no-such-ref', '--no-index', '-p', 'a b']) {
    const r = check(root, { base: bad });
    assert.ok(r.findings.some((f) => f.type === 'base-unresolved'), `${bad} is reported`);
    assert.strictEqual(r.exitCode, 1, `${bad} fails even in annotate mode`);
  }
  assert.ok(/^::error title=base-unresolved::/m.test(formatGithub(check(root, { base: 'no-such-ref' }))));
  assert.ok(!check(root).findings.some((f) => f.type === 'base-unresolved'), 'no --base means no comparison and no finding');
  spawnSync('git', ['init'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: root });
  assert.ok(!check(root, { base: 'HEAD' }).findings.some((f) => f.type === 'base-unresolved'), 'a real ref works');
});

test('report: one row per route and method, with gaps, deterministic, several formats', () => {
  const { report, format } = require('../src/report');
  const root = tmp();
  const guarded = "export async function GET(){ await getServerSession(); }\nexport async function POST(){ await getServerSession(); }";
  put(root, 'app/api/orders/route.ts', guarded);
  put(root, 'app/api/orders/.route.json', JSON.stringify({ version: 1, route: '/api/orders', methods: { GET: { exposure: 'authenticated' }, POST: { exposure: 'authenticated' } }, reason: { source: 'user' } }));
  put(root, 'app/api/exports/route.ts', 'export async function GET(){ return Response.json([]); }');
  put(root, 'app/api/exports/.route.json', JSON.stringify({ version: 1, route: '/api/exports', methods: { GET: { exposure: 'authenticated' } }, reason: { source: 'heuristic' } }));
  put(root, 'app/blog/page.tsx', 'export default function P(){ return null }');
  put(root, 'app/blog/.route.json', JSON.stringify({ version: 1, route: '/blog', methods: { GET: { exposure: 'public' } }, reason: { source: 'heuristic' } }));
  put(root, 'app/me/route.ts', 'export async function GET(){ await getServerSession(); }');
  put(root, 'app/me/.route.json', JSON.stringify({ version: 1, route: '/me', methods: { GET: { exposure: 'public' } } }));
  put(root, 'app/api/new/route.ts', 'export async function PUT(){}');
  put(root, 'app/api/gone/.route.json', JSON.stringify({ version: 1, route: '/api/gone', methods: { GET: { exposure: 'public' } } }));
  put(root, 'app/api/bad/.route.json', '{not json');
  put(root, 'app/api/login/route.ts', 'export async function POST(){}');
  put(root, 'app/api/login/.route.json', JSON.stringify({ version: 1, route: '/api/login', methods: { POST: { exposure: 'authenticated' } } }));
  put(root, 'app/api/behind/route.ts', 'export async function GET(){}');
  put(root, 'app/api/behind/.route.json', JSON.stringify({ version: 1, route: '/api/behind', enforcement: { via: ['api-gateway'] }, methods: { GET: { exposure: 'authenticated' } } }));

  const r = report(root);
  const get = (route, method) => r.rows.find((x) => x.route === route && x.method === method);
  assert.deepStrictEqual([get('/api/orders', 'GET').authCheck, get('/api/orders', 'POST').authCheck, get('/api/orders', 'GET').gaps], ['yes', 'yes', []]);
  assert.strictEqual(get('/api/orders', 'GET').decidedBy, 'user');
  assert.deepStrictEqual(get('/api/exports', 'GET').gaps, ['protected-no-auth-check']);
  assert.deepStrictEqual(get('/me', 'GET').gaps, ['public-with-auth-check']);
  assert.deepStrictEqual(get('/blog', 'GET').gaps, []);
  assert.deepStrictEqual(get('/api/new', 'PUT').gaps, ['no-sidecar']);
  assert.deepStrictEqual(get('/api/gone', 'GET').gaps, ['orphan']);
  assert.ok(r.rows.some((x) => x.exposure === '(invalid)' && x.gaps[0] === 'schema'));
  assert.deepStrictEqual(get('/api/login', 'POST').gaps, [], 'sign-in endpoints are exempt');
  assert.deepStrictEqual(get('/api/behind', 'GET').gaps, [], 'declared external control is not a gap');
  assert.strictEqual(r.exitCode, 0);
  assert.strictEqual(report(root, { strict: true }).exitCode, 1);

  assert.strictEqual(format(r), format(report(root)), 'deterministic');
  const keys = r.rows.map((x) => `${x.route} ${x.method}`);
  assert.deepStrictEqual(keys, [...keys].sort((a, b) => (a.split(' ')[0] < b.split(' ')[0] ? -1 : a.split(' ')[0] > b.split(' ')[0] ? 1 : 0)), 'sorted by route');
  assert.ok(/^ROUTE +METHOD +EXPOSURE/.test(format(r)));
  assert.ok(/^\| ROUTE \|/m.test(format(r, 'md')) && /^# Route inventory/.test(format(r, 'md')));
  assert.strictEqual(JSON.parse(format(r, 'json')).summary.routes, r.summary.routes);
  assert.ok(format(r, 'csv').split('\n')[0].startsWith('ROUTE,METHOD'));
  assert.throws(() => format(r, 'xml'));
  assert.ok(r.summary.decidedByPerson >= 2);
});

test('report command runs through the CLI and exits 1 only with --strict and gaps', () => {
  const root = tmp();
  put(root, 'app/api/x/route.ts', 'export async function GET(){}');
  const cli = path.join(__dirname, '..', 'bin', 'route-protection-intent.js');
  const plain = spawnSync('node', [cli, 'report', root], { encoding: 'utf8' });
  assert.strictEqual(plain.status, 0);
  assert.ok(/no-sidecar/.test(plain.stdout));
  assert.strictEqual(spawnSync('node', [cli, 'report', root, '--strict'], { encoding: 'utf8' }).status, 1);
  assert.ok(JSON.parse(spawnSync('node', [cli, 'report', root, '--format', 'json'], { encoding: 'utf8' }).stdout).rows.length === 1);
});

test('verify: probes a running app without credentials and compares with the recorded intent', async () => {
  const http = require('http');
  const { verify, format, buildPath, isLocal } = require('../src/verify');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} auth=${req.headers.authorization || ''} cookie=${req.headers.cookie || ''}`);
    const u = req.url;
    if (u === '/api/orders') { res.writeHead(401); return res.end(); }
    if (u === '/api/leak') { res.writeHead(200); return res.end('data'); }
    if (u === '/blog') { res.writeHead(200); return res.end('hi'); }
    if (u === '/api/pub-refused') { res.writeHead(403); return res.end(); }
    if (u === '/dash') { res.writeHead(302, { location: '/login' }); return res.end(); }
    if (u === '/api/orders/42') { res.writeHead(403); return res.end(); }
    if (u === '/api/wrong-url') { res.writeHead(404); return res.end(); }
    if (u === '/api/posts') { res.writeHead(req.method === 'POST' ? 401 : 200); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const root = tmp();
    const sc = (dir, route, methods, extra = {}) => {
      put(root, `app${dir}/route.ts`, 'export async function GET(){}');
      put(root, `app${dir}/.route.json`, JSON.stringify({ version: 1, route, methods, ...extra }));
    };
    sc('/api/orders', '/api/orders', { GET: { exposure: 'authenticated' } });
    sc('/api/leak', '/api/leak', { GET: { exposure: 'authenticated' } });
    sc('/blog', '/blog', { GET: { exposure: 'public' } });
    sc('/api/pub-refused', '/api/pub-refused', { GET: { exposure: 'public' } });
    sc('/dash', '/dash', { GET: { exposure: 'authenticated' } });
    sc('/api/orders/[id]', '/api/orders/[id]', { GET: { exposure: 'authenticated' } });
    sc('/api/wrong-url', '/api/wrong-url', { GET: { exposure: 'authenticated' } });
    sc('/api/posts', '/api/posts', { GET: { exposure: 'public' }, POST: { exposure: 'authenticated' } });
    sc('/api/unknown', '/api/unknown', { GET: { exposure: 'unclassified' } });

    const r = await verify(root, { baseUrl: base });
    const get = (route, m = 'GET') => r.rows.find((x) => x.route === route && x.method === m);
    assert.strictEqual(get('/api/orders').result, 'pass');
    assert.strictEqual(get('/api/leak').result, 'gap');
    assert.ok(/anonymous request/.test(get('/api/leak').note));
    assert.strictEqual(get('/blog').result, 'pass');
    assert.strictEqual(get('/api/pub-refused').result, 'gap');
    assert.strictEqual(get('/dash').result, 'pass', 'a redirect to login counts as refused');
    assert.strictEqual(get('/api/orders/[id]').result, 'skipped', 'needs a sample value');
    assert.strictEqual(get('/api/wrong-url').result, 'inconclusive', '404 never counts as a pass');
    assert.strictEqual(get('/api/posts', 'POST').result, 'skipped', 'mutating methods are not sent by default');
    assert.ok(!r.rows.some((x) => x.route === '/api/unknown'), 'unclassified routes are not probed');
    assert.strictEqual(r.exitCode, 1, 'a gap fails the run');
    assert.ok(!seen.some((x) => x.startsWith('POST ')), 'no POST was sent');
    assert.ok(seen.every((x) => x.endsWith('auth= cookie=')), 'no credentials are ever sent');

    put(root, '.route-protection-intent.config.json', JSON.stringify({ verify: { samples: { id: 42 } } }));
    const withSamples = await verify(root, { baseUrl: base, includeMutating: true });
    assert.strictEqual(withSamples.rows.find((x) => x.route === '/api/orders/[id]').result, 'pass');
    assert.strictEqual(withSamples.rows.find((x) => x.route === '/api/posts' && x.method === 'POST').result, 'pass');
    assert.ok(seen.some((x) => x.startsWith('POST ')), 'POST is sent only when asked');

    assert.ok(/^ROUTE +METHOD +RECORDED/.test(format(r)) && /RESULT/.test(format(r)));
    assert.strictEqual(JSON.parse(format(r, 'json')).summary.gap, 2);
    assert.ok(format(r, 'md').startsWith('# Live verification') && format(r, 'csv').startsWith('ROUTE,'));

    // a server that is down is inconclusive, and --strict turns that into a failure
    const down = await verify(root, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 });
    assert.ok(down.rows.filter((x) => x.result !== 'skipped').every((x) => x.result === 'inconclusive'));
    const noGap = tmp();
    put(noGap, 'app/blog/page.tsx', 'export default function P(){return null}');
    put(noGap, 'app/blog/.route.json', JSON.stringify({ version: 1, route: '/blog', methods: { GET: { exposure: 'public' } } }));
    assert.strictEqual((await verify(noGap, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })).exitCode, 0);
    assert.strictEqual((await verify(noGap, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000, strict: true })).exitCode, 1);
  } finally { server.close(); }

  await assert.rejects(() => verify(tmp(), { baseUrl: 'https://example.com' }), /not a local address/);
  await assert.rejects(() => verify(tmp(), {}), /--base-url is required/);
  await assert.rejects(() => verify(tmp(), { baseUrl: 'ftp://localhost' }), /http or https/);
  assert.ok(isLocal('localhost') && isLocal('127.0.0.1') && isLocal('[::1]') && isLocal('app.localhost'));
  assert.ok(!isLocal('example.com') && !isLocal('10.0.0.5') && !isLocal('127.0.0.1.evil.com'));
  assert.deepStrictEqual(buildPath('/a/[id]/b/:name/{x}/[...rest]', { id: '1', name: 'n', x: 'y', rest: 'r' }), { path: '/a/1/b/n/y/r', missing: [] });
  assert.deepStrictEqual(buildPath('/a/[id]', {}).missing, ['id']);
});

test('verify through the CLI: exit 1 on a gap, exit 2 on a refused remote target', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const root = tmp();
    put(root, 'app/api/x/route.ts', 'export async function GET(){}');
    put(root, 'app/api/x/.route.json', JSON.stringify({ version: 1, route: '/api/x', methods: { GET: { exposure: 'authenticated' } } }));
    const cli = path.join(__dirname, '..', 'bin', 'route-protection-intent.js');
    const run = (args) => new Promise((resolve) => { const c = require('child_process').spawn('node', [cli, ...args]); let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('close', (code) => resolve({ code, out })); });
    const gap = await run(['verify', root, '--base-url', `http://127.0.0.1:${server.address().port}`]);
    assert.strictEqual(gap.code, 1);
    assert.ok(/gap/.test(gap.out));
    const remote = await run(['verify', root, '--base-url', 'https://example.com']);
    assert.strictEqual(remote.code, 2);
    assert.ok(/--allow-remote/.test(remote.out));
  } finally { server.close(); }
});

test('routes registered in code are found in many languages, as "METHOD /path" entries', () => {
  const { extractEndpoints, commonRoute, keyOf } = require('../src/endpoints');
  const { analyzeSource } = require('../src/analyze');
  const keys = (rel, src) => extractEndpoints(src, rel).map(keyOf);
  assert.deepStrictEqual(keys('src/api.js', "const express = require('express'); r.get('/orders', h); r.post('/orders', h); axios.get('/api/x');"), ['GET /orders', 'POST /orders']);
  assert.deepStrictEqual(keys('src/a.js', "axios.get('/api/x'); r.get('/y', h);"), [], 'no web framework in the file: not a router');
  assert.deepStrictEqual(keys('src/cats.ts', "import { Controller } from '@nestjs/common'; @Controller('cats') class C { @Get() a(){} @Post(':id') b(){} }"), ['GET /cats', 'POST /cats/:id']);
  assert.deepStrictEqual(keys('app/x.py', "from fastapi import APIRouter\nrouter = APIRouter(prefix='/api')\n@router.get('/items')\n@router.post('/items/{id}')\n"), ['GET /api/items', 'POST /api/items/{id}']);
  assert.deepStrictEqual(keys('app/y.py', "from flask import Flask\n@app.route('/x', methods=['GET', 'POST'])\n@app.route('/y')\n"), ['GET /x', 'POST /x', 'GET /y']);
  assert.deepStrictEqual(keys('cmd/s.go', 'import "github.com/go-chi/chi/v5"\nr.Get("/orders", h)\nhttp.HandleFunc("POST /ping", h)\nrouter.HandleFunc("/z", h).Methods("GET", "PUT")'), ['POST /ping', 'GET /orders', 'GET /z', 'PUT /z'].sort((a, b) => (a.split(' ')[1] < b.split(' ')[1] ? -1 : a.split(' ')[1] > b.split(' ')[1] ? 1 : 0)));
  assert.deepStrictEqual(keys('src/O.java', '@RestController @RequestMapping("/api/orders") public class O { @GetMapping("/{id}") x(){} @PostMapping y(){} @RequestMapping(value="/q", method=RequestMethod.DELETE) z(){} }'), ['POST /api/orders', 'DELETE /api/orders/q', 'GET /api/orders/{id}']);
  assert.deepStrictEqual(keys('src/R.java', '@Path("/res") public class R { @GET @Path("/a") a(){} @Path("/b") @POST b(){} }'), ['GET /res/a', 'POST /res/b']);
  assert.deepStrictEqual(keys('src/K.kt', 'import io.ktor.server.routing.*\nrouting {\n  get("/ping") { }\n  post("/orders") { }\n}'), ['POST /orders', 'GET /ping']);
  assert.deepStrictEqual(keys('Controllers/OrdersController.cs', '[ApiController][Route("api/[controller]")] public class OrdersController : ControllerBase { [HttpGet] a(){} [HttpGet("{id}")] b(){} [HttpPost] c(){} }'), ['GET /api/orders', 'POST /api/orders', 'GET /api/orders/{id}']);
  assert.deepStrictEqual(keys('Program.cs', 'app.MapGet("/health", () => 1); app.MapPost("/x", () => 1);'), ['GET /health', 'POST /x']);
  assert.deepStrictEqual(keys('config/routes.rb', 'Rails.application.routes.draw do\n  get "/ping", to: "a#b"\n  resources :orders, only: [:index, :show]\nend'), ['GET /orders', 'GET /orders/:id', 'GET /ping']);
  assert.deepStrictEqual(keys('routes/api.php', '<?php Route::get("/users", f); Route::apiResource("posts", C::class); Route::match(["get", "post"], "/m", f);').filter((k) => /users|\/m$/.test(k)), ['GET /m', 'POST /m', 'GET /users']);
  assert.ok(keys('routes/api.php', '<?php Route::apiResource("posts", C::class);').includes('DELETE /posts/:id'));
  assert.deepStrictEqual(keys('src/s.rs', 'use actix_web::*; #[get("/a")] async fn a(){}\nuse axum::Router; let r = Router::new().route("/c", get(h).post(h2));'), ['GET /a', 'GET /c', 'POST /c']);
  assert.deepStrictEqual(keys('lib/router.ex', 'use Phoenix.Router\nget "/", P, :index\npost "/login", S, :create'), ['GET /', 'POST /login']);
  assert.deepStrictEqual(keys('Sources/routes.swift', 'import Vapor\nroutes.get("orders", ":id") { r in }\napp.post("todos") { r in }'), ['GET /orders/:id', 'POST /todos']);
  assert.strictEqual(commonRoute(extractEndpoints('@RestController @RequestMapping("/api/orders") class O { @GetMapping("/{id}") a(){} @PostMapping b(){} }', 'O.java')), '/api/orders');

  // analysis: one entry per endpoint, classified on its own path
  const a = analyzeSource({ relPath: 'src/AdminController.java', source: '@RestController @RequestMapping("/api") class A { @GetMapping("/admin/users") a(){} @GetMapping("/health") b(){} @PostMapping("/orders") c(){} }' });
  assert.deepStrictEqual(a.methods, ['GET /api/admin/users', 'GET /api/health', 'POST /api/orders']);
  assert.strictEqual(a.isAdmin, true, 'one admin endpoint makes the file admin');
  assert.strictEqual(a.policy.methods['GET /api/admin/users'].exposure, 'authenticated');
  assert.strictEqual(a.policy.methods['POST /api/orders'].exposure, 'authenticated');
  // file-based frameworks keep the original model
  assert.deepStrictEqual(analyzeSource({ relPath: 'app/api/orders/route.ts', source: 'export async function GET(){}' }).methods, ['GET']);
});

test('code-registered routes are discovered by content, saved, checked and reported', () => {
  const { report } = require('../src/report');
  const root = tmp();
  put(root, 'src/main/java/shop/OrdersController.java', '@RestController @RequestMapping("/api/orders") public class OrdersController {\n @PreAuthorize("isAuthenticated()") @GetMapping("/{id}") x(){}\n @PostMapping y(){} }');
  put(root, 'cmd/server/handlers.go', 'package main\nimport "github.com/go-chi/chi/v5"\nfunc r(){ r.Get("/health", h); r.Get("/internal/jobs", j) }');
  put(root, 'config/routes.rb', 'Rails.application.routes.draw do\n  get "/ping", to: "a#b"\nend');
  put(root, 'routes/api.php', '<?php Route::middleware("auth")->group(function () { Route::get("/me", f); });');
  put(root, 'src/helper.go', 'package main\nfunc add(a int) int { return a }');
  put(root, 'src/client.js', "fetch('/api/x'); axios.get('/api/y');");
  put(root, 'vendor/lib/routes.go', 'import "net/http"\nhttp.HandleFunc("/vendored", h)');
  put(root, 'src/main/java/shop/OrdersControllerTest.java', '@RestController class T { @GetMapping("/t") a(){} }');
  put(root, 'app/api/ok/route.ts', 'export async function GET(){}');

  const config = R.loadConfig(root);
  const is = (rel) => R.isRouteFile(rel, config);
  assert.ok(is('src/main/java/shop/OrdersController.java') && is('cmd/server/handlers.go') && is('config/routes.rb') && is('routes/api.php'));
  assert.ok(!is('src/helper.go') && !is('src/client.js') && !is('vendor/lib/routes.go') && !is('src/main/java/shop/OrdersControllerTest.java'));
  assert.ok(!R.isRouteFile('cmd/server/handlers.go'), 'without a root only paths count');

  const missing = check(root).findings.filter((f) => f.type === 'missing').map((f) => f.file).sort();
  assert.deepStrictEqual(missing, ['app/api/ok/.route.json', 'cmd/server/handlers.route.json', 'config/routes.route.json', 'routes/api.route.json', 'src/main/java/shop/OrdersController.route.json']);

  // save a multi-endpoint sidecar for the Java controller exactly as analyze suggests
  const an = analyze('src/main/java/shop/OrdersController.java', { root });
  assert.deepStrictEqual(an.methods, ['POST /api/orders', 'GET /api/orders/{id}']);
  assert.strictEqual(an.hasAuthSignal, true, 'Spring @PreAuthorize is an auth signal');
  const res = save(path.join(root, 'src/main/java/shop'), an.policy, { file: 'OrdersController.route.json' });
  assert.strictEqual(res.code, 0, JSON.stringify(res));
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'src/main/java/shop/OrdersController.route.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(saved.methods), ['POST /api/orders', 'GET /api/orders/{id}'].sort((x, y) => (x.split(' ')[1] < y.split(' ')[1] ? -1 : 1)));
  assert.ok(!check(root).findings.some((f) => f.file.includes('OrdersController') && /^auth-/.test(f.type)), 'auth check found through @PreAuthorize');

  const go = analyze('cmd/server/handlers.go', { root });
  assert.deepStrictEqual(go.methods, ['GET /health', 'GET /internal/jobs']);
  assert.strictEqual(go.policy.methods['GET /internal/jobs'].exposure, 'internal');
  assert.strictEqual(save(path.join(root, 'cmd/server'), go.policy, { file: 'handlers.route.json' }).code, 0);

  const rows = report(root).rows;
  const row = (route, m) => rows.find((x) => x.route === route && x.method === m);
  assert.strictEqual(row('/api/orders/{id}', 'GET').pathFrom, 'source');
  assert.strictEqual(row('/api/orders/{id}', 'GET').authCheck, 'yes');
  assert.strictEqual(row('/health', 'GET').exposure, 'public');
  assert.deepStrictEqual(row('/internal/jobs', 'GET').gaps, ['protected-no-auth-check'], 'internal route without a recorded control');
  assert.deepStrictEqual(row('/ping', 'GET').gaps, ['no-sidecar']);
  assert.ok(rows.every((x) => x.route.startsWith('/') || x.exposure === '(invalid)'));
});

test('authPatterns in the config add project-specific auth signals', () => {
  const { hasAuthSignal } = require('../src/analyze');
  const root = tmp();
  put(root, '.route-protection-intent.config.json', JSON.stringify({ authPatterns: ['\\bcheckMyAcl\\(', '(', 5] }));
  const config = R.loadConfig(root);
  assert.strictEqual(config.authRegexes.length, 1, 'invalid and non-string patterns are ignored');
  assert.strictEqual(hasAuthSignal('x = checkMyAcl(req)'), false);
  assert.strictEqual(hasAuthSignal('x = checkMyAcl(req)', config.authRegexes), true);
  put(root, 'app/api/a/route.ts', 'export async function GET(){ checkMyAcl(1); }');
  put(root, 'app/api/a/.route.json', JSON.stringify({ version: 1, route: '/api/a', methods: { GET: { exposure: 'authenticated' } } }));
  assert.ok(!check(root).findings.some((f) => f.type === 'auth-not-found'), 'the project pattern counts');
});

test('SvelteKit and Nuxt file routes, dynamic segments in more syntaxes', () => {
  const { buildPath } = require('../src/verify');
  assert.strictEqual(R.routeFromPath('src/routes/api/orders/+server.ts'), '/api/orders');
  assert.ok(R.isRouteFile('src/routes/api/orders/+server.ts'));
  assert.strictEqual(R.routeFromPath('server/api/orders.get.ts'), '/api/orders');
  assert.deepStrictEqual(R.detectMethods('export default defineEventHandler(()=>1)', 'server/api/orders.get.ts'), ['GET']);
  assert.strictEqual(R.routeFromPath('server/routes/health.ts'), '/health');
  assert.deepStrictEqual(buildPath('/u/<int:id>/{name?}/:x', { id: 1, name: 'n', x: 'y' }), { path: '/u/1/n/y', missing: [] });
});

test('spec: compares an OpenAPI document with the recorded sidecars', () => {
  const { compareSpec, format, protection, norm } = require('../src/spec');
  const root = tmp();
  const sc = (dir, route, methods) => {
    put(root, `app${dir}/route.ts`, 'export async function GET(){}');
    put(root, `app${dir}/.route.json`, JSON.stringify({ version: 1, route, methods }));
  };
  sc('/api/orders', '/api/orders', { GET: { exposure: 'authenticated' }, POST: { exposure: 'authenticated' } });
  sc('/api/orders/[id]', '/api/orders/[id]', { GET: { exposure: 'public' } });
  sc('/api/blog', '/api/blog', { GET: { exposure: 'authenticated' } });
  sc('/api/health', '/api/health', { GET: { exposure: 'public' } });
  sc('/api/legacy', '/api/legacy', { GET: { exposure: 'public' } });
  sc('/api/todo', '/api/todo', { GET: { exposure: 'unclassified' } });
  const spec = {
    openapi: '3.0.0', servers: [{ url: 'https://api.example.com' }], security: [{ bearer: [] }],
    paths: {
      '/api/orders': { get: {}, post: {} },
      '/api/orders/{id}': { get: {} },
      '/api/blog': { get: { security: [] } },
      '/api/health': { get: { security: [{}, { bearer: [] }] } },
      '/api/reports': { get: {} },
      '/api/todo': { get: {} },
    },
  };
  put(root, 'openapi.json', JSON.stringify(spec));
  const r = compareSpec(root, 'openapi.json');
  const get = (route, m = 'GET') => r.rows.find((x) => x.route === route && x.method === m);
  assert.strictEqual(get('/api/orders').result, 'match');
  assert.strictEqual(get('/api/orders', 'POST').result, 'match');
  assert.strictEqual(get('/api/orders/{id}').result, 'mismatch', '{id} matches [id]');
  assert.ok(/recorded public, but the spec requires authentication/.test(get('/api/orders/{id}').note));
  assert.strictEqual(get('/api/blog').result, 'mismatch', 'spec says no security, sidecar says authenticated');
  assert.strictEqual(get('/api/health').result, 'match', 'optional authentication counts as public');
  assert.strictEqual(get('/api/reports').result, 'not-recorded');
  assert.strictEqual(get('/api/todo').result, 'unclassified');
  assert.strictEqual(get('/api/legacy').result, 'not-in-spec');
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.summary.mismatch, 2);
  assert.ok(format(r).startsWith('ROUTE') && format(r, 'md').startsWith('# API spec comparison') && JSON.parse(format(r, 'json')).summary.match === 3);

  // a server base path is tried with and without
  put(root, 'openapi.json', JSON.stringify({ openapi: '3.0.0', servers: [{ url: '/api' }], paths: { '/health': { get: {} } } }));
  assert.strictEqual(compareSpec(root, 'openapi.json').rows.find((x) => x.route === '/health').result, 'match');
  assert.strictEqual(compareSpec(root, 'openapi.json', { prefix: '' }).rows.find((x) => x.route === '/health').result, 'not-recorded');
  assert.throws(() => compareSpec(root, 'missing.yaml'), /YAML specs are not supported/);
  put(root, 'bad.json', '{"a":1}');
  assert.throws(() => compareSpec(root, 'bad.json'), /no "paths"/);
  assert.strictEqual(protection({}, undefined), 'public');
  assert.strictEqual(protection({}, [{ k: [] }]), 'protected');
  assert.strictEqual(protection({ security: [] }, [{ k: [] }]), 'public');
  assert.strictEqual(norm('/A/{id}/b/:x/[y]/<int:z>'), '/a/{}/b/{}/{}/{}');
});

test('countFindings splits errors from warnings', () => {
  const r = { routes: 3, findings: [{ type: 'auth-removed' }, { type: 'missing' }, { type: 'orphan' }] };
  assert.deepStrictEqual(countFindings(r), { findings: 3, errors: 1, warnings: 2, routes: 3 });
});

test('check --github-output writes counts to GITHUB_OUTPUT', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-'));
  fs.mkdirSync(path.join(root, 'app/api/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app/api/x/route.ts'), 'export async function GET(){ return new Response("ok") }');
  const out = path.join(root, 'gh-output');
  const bin = path.join(__dirname, '..', 'bin', 'route-protection-intent.js');
  const r = spawnSync('node', [bin, 'check', root, '--github-output'], { env: { ...process.env, GITHUB_OUTPUT: out }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /^findings=1$/m);
  assert.match(text, /^warnings=1$/m);
  assert.match(text, /^errors=0$/m);
  assert.match(text, /^routes=1$/m);
});

test('review fields: save accepts a complete review and rejects a partial one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-'));
  const pol = (reason) => ({ route: '/a', methods: { GET: { exposure: 'authenticated' } }, reason });
  assert.strictEqual(save(dir, pol({ source: 'user', reviewedBy: 'Dana', reviewedAt: '2026-11-15' })).ok, true);
  assert.strictEqual(save(dir, pol({ source: 'user', reviewedBy: 'Dana' })).ok, false);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-'));
  assert.strictEqual(save(fresh, pol({ source: 'heuristic', reviewedBy: 'Dana', reviewedAt: '2026-11-15' })).ok, false);
  assert.strictEqual(save(dir, pol({ source: 'user', reviewedBy: 'Dana', reviewedAt: 'yesterday' })).ok, false);
});

test('review-stale: code changed after reviewedAt is flagged, earlier change is not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-'));
  const git = (...a) => spawnSync('git', a, { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-10T12:00:00Z', GIT_AUTHOR_DATE: '2026-11-10T12:00:00Z' } });
  git('init'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  put(root, 'app/me/route.ts', 'export async function GET(){ await getServerSession(); }');
  const sc = (reviewedAt) => JSON.stringify({ version: 1, route: '/me', methods: { GET: { exposure: 'authenticated' } }, reason: { source: 'user', reviewedBy: 'Dana', reviewedAt } });
  put(root, 'app/me/.route.json', sc('2026-11-12'));
  git('add', '.'); git('commit', '-m', 'init');
  assert.ok(!check(root).findings.some((f) => f.type === 'review-stale'));
  put(root, 'app/me/.route.json', sc('2026-11-05'));
  assert.ok(check(root).findings.some((f) => f.type === 'review-stale'));
});

test('report shows REVIEWED only when a review is recorded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpi-'));
  put(root, 'app/blog/page.tsx', 'export default function P(){ return null }');
  put(root, 'app/blog/.route.json', JSON.stringify({ version: 1, route: '/blog', methods: { GET: { exposure: 'public' } }, reason: { source: 'user' } }));
  assert.ok(!formatReport(report(root)).includes('REVIEWED'));
  put(root, 'app/blog/.route.json', JSON.stringify({ version: 1, route: '/blog', methods: { GET: { exposure: 'public' } }, reason: { source: 'user', reviewedBy: 'Dana', reviewedAt: '2026-11-15' } }));
  const out = formatReport(report(root));
  assert.match(out, /REVIEWED/);
  assert.match(out, /Dana 2026-11-15/);
});
