'use strict';
// Classification suggestion (FR-2.x). Conservative: when unsure, suggest the non-public side.
const fs = require('fs');
const path = require('path');
const R = require('./routes');
const { guidance } = require('./guidance');
const { extractEndpoints, commonRoute, keyOf, parseKey } = require('./endpoints');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const AUTH_SEGMENTS = ['admin', 'auth', 'api', 'user', 'users', 'account', 'cart', 'checkout', 'login', 'logout', 'signup', 'session', 'dashboard', 'settings', 'payment', 'billing'];
const INTERNAL_SEGMENTS = ['internal', 'cron', 'jobs', 'webhook', 'webhooks', 'private'];
const PUBLIC_SEGMENTS = ['products', 'product', 'blog', 'posts', 'post', 'docs', 'about', 'pricing', 'faq', 'contact', 'news', 'articles', 'help', 'health', 'healthz', 'status'];

const segs = (route) => route.split('/').filter(Boolean).map((s) => s.toLowerCase());
const has = (list, s) => s.some((x) => list.includes(x));
// Text patterns that suggest an authentication or authorization check, per ecosystem. Not proof that a
// check exists or is correct. Projects add their own helper names with `authPatterns` in the config.
const AUTH_SIGNALS = [
  // JavaScript / TypeScript
  /\b(?:getServerSession|getSession|getToken|currentUser|requireAuth|requireUser|ensureAuthenticated|verifyToken|verifyIdToken|authenticate|withAuth|getAuth)\s*\(/,
  /\b(?:req|ctx|request|c)\.(?:user|isAuthenticated)\b/, /\bpassport\.authenticate\b/, /\bawait\s+auth\s*\(/, /\bjwt\.verify\s*\(/, /@UseGuards\s*\(/, /\bAuthGuard\s*\(/,
  /\bsupabase\.auth\.getUser\b/, /\bclerkMiddleware\b/,
  // Python
  /\bDepends\s*\(\s*(?:get_current_user|get_current_active_user|require_auth|verify_token|oauth2_scheme|\w*[Bb]earer\w*)/, /\bSecurity\s*\(\s*\w+/,
  /@(?:login_required|jwt_required|permission_required|requires_auth|auth_required|token_required|user_passes_test)\b/, /\bpermission_classes\s*=\s*[\[(][^\])]*\bIs(?:Authenticated|AdminUser)/,
  /\bLoginRequiredMixin\b/, /\brequest\.user\.is_authenticated\b/, /\bcurrent_user\b/,
  // Go
  /\b(?:Require|Ensure|Must)Auth\w*\s*\(/, /\b\w*Auth(?:enticate|Middleware|Required)\w*\s*[\(,)]/, /\bjwtauth\.(?:Verifier|Authenticator)\b/,
  // Java / Kotlin
  /@(?:PreAuthorize|Secured|RolesAllowed|Authenticated|PostAuthorize)\b/, /\bSecurityContextHolder\b/, /@AuthenticationPrincipal\b/, /\.authenticated\s*\(\s*\)/, /\bauthenticate\s*\(\s*["'\w-]*\s*\)\s*\{/,
  // C#
  /\[Authorize\b/, /\.RequireAuthorization\s*\(/, /\bUser\.Identity\??\.IsAuthenticated\b/,
  // Ruby
  /\b(?:before_action|before_filter)\s+:(?:authenticate\w*!?|require_login|require_user|authorize\w*)/, /\bauthenticate_user!/, /\bhttp_basic_authenticate_with\b/,
  // PHP
  /->middleware\(\s*\[?\s*['"](?:auth|verified|can:|role:)/, /\bmiddleware\(\s*\[?\s*['"]auth/, /\bAuth::(?:check|user|id)\s*\(/, /\bauth\(\)\s*->\s*(?:user|check|id)\b/, /#\[IsGranted\b/, /@IsGranted\b/, /\bdenyAccessUnlessGranted\b/,
  // Rust
  /\b(?:AuthenticatedUser|AuthUser|BearerAuth|HttpAuthentication|RequireAuth)\b/, /\brequire_auth\b/,
  // Elixir
  /\bplug\s+:(?:authenticate|require_authenticated\w*|ensure_auth\w*)/, /:require_authenticated_user\b/, /\bpipe_through\s+\[[^\]]*:(?:auth|authenticated|api_auth)\b/,
  // Swift
  /\breq\.auth\.(?:require|get)\b/, /\bGuardMiddleware\b/,
];

function hasAuthSignal(source = '', extra = []) {
  return AUTH_SIGNALS.some((re) => re.test(source)) || extra.some((re) => re.test(source));
}

function classifyMethod(route, method, adminPaths = [], authSignal = false) {
  const s = segs(route);
  const isApi = s[0] === 'api' || s.includes('api');
  if (has(INTERNAL_SEGMENTS, s)) {
    return { exposure: 'internal', cache: { policy: 'no-store' } , confidence: 'high', rule: 'path-internal' };
  }
  if (R.isAdminRoute(route, adminPaths)) {
    const configured = !has(['admin'], s);
    return { exposure: 'authenticated', cache: { policy: 'no-store' }, indexing: 'noindex', confidence: 'high', rule: configured ? 'config-admin-path' : 'path-admin' };
  }
  if (has(AUTH_SEGMENTS, s)) {
    const p = { exposure: 'authenticated', cache: { policy: 'no-store' }, confidence: 'high', rule: `path-${(AUTH_SEGMENTS.find((a) => s.includes(a)))}` };
    if (!isApi) p.indexing = 'noindex';
    return p;
  }
  if (MUTATING.has(method)) return { exposure: 'authenticated', cache: { policy: 'no-store' }, confidence: 'high', rule: 'method-mutating' };
  if (authSignal) {
    const p = { exposure: 'authenticated', cache: { policy: 'no-store' }, confidence: 'high', rule: 'source-auth-signal' };
    if (!isApi) p.indexing = 'noindex';
    return p;
  }
  if (s.length === 0 || has(PUBLIC_SEGMENTS, s)) {
    return { exposure: 'public', ...(isApi ? {} : { indexing: 'index' }), confidence: 'high', rule: s.length === 0 ? 'path-root' : 'path-public-content' };
  }
  return { exposure: 'authenticated', confidence: 'low', rule: 'unsure-default' };
}

const RANK = { unclassified: 0, public: 1, authenticated: 2, internal: 3 };

function analyzeSource({ relPath, source = '', methods, adminPaths = [], authRegexes = [], include = [] }) {
  // Routes registered in code (Spring, Go, Rails, Laravel...): one entry per "METHOD /path" found in the file.
  const endpoints = methods && methods.length ? [] : (R.isLegacy(relPath, { include }) ? [] : extractEndpoints(source, relPath));
  const route = endpoints.length ? commonRoute(endpoints) : R.routeFromPath(relPath);
  const detected = endpoints.length ? endpoints.map(keyOf) : methods && methods.length ? methods : R.detectMethods(source, relPath);
  const ms = detected.length ? detected : ['*'];
  const authSignal = hasAuthSignal(source, authRegexes);
  const per = Object.fromEntries(ms.map((m) => {
    const e = parseKey(m);
    return [m, classifyMethod(e.path || route, e.method === '*' ? 'GET' : e.method, adminPaths, authSignal)];
  }));

  // Summary suggestion takes the most restrictive method; per-method policies are preserved in policy.methods.
  const strongest = Object.values(per).sort((a, b) => RANK[b.exposure] - RANK[a.exposure])[0];
  const confidence = Object.values(per).every((p) => p.confidence === 'high') ? 'high' : 'low';
  const { confidence: _c, rule, ...suggestion } = strongest;

  const stripMeta = ({ confidence: _mc, rule: _mr, ...mp }) => mp;
  const perMethodPolicy = Object.fromEntries(ms.map((m) => [m, stripMeta(per[m])]));
  const policyFor = (exposure) => ({
    route,
    methods: Object.fromEntries(ms.map((m) => [m, exposure === 'unclassified' ? { exposure } : { ...suggestion, exposure }])),
  });
  const reasonRule = rule;
  const isAdmin = R.isAdminRoute(route, adminPaths) || ms.some((m) => { const e = parseKey(m); return e.path && R.isAdminRoute(e.path, adminPaths); });
  const options = [];
  if (confidence === 'low') {
    options.push({ label: 'Secured: login required, not indexed (recommended)', policy: policyFor('authenticated') });
    options.push({ label: 'Public: open to everyone and indexable by search engines (SEO)', policy: policyFor('public') });
    options.push({ label: 'Leave unclassified', policy: policyFor('unclassified') });
  }
  return {
    route, methods: ms, suggestion, confidence, needsUserInput: confidence === 'low', options,
    hasAuthSignal: authSignal,
    policy: { route, methods: confidence === 'high' ? perMethodPolicy : policyFor(suggestion.exposure).methods, reason: { source: 'heuristic', rule: reasonRule } },
    isAdmin,
    guidance: guidance({ exposure: suggestion.exposure, relPath, isAdmin, route }),
    ...(isAdmin ? {
      needsGate: true,
      gateOptions: [
        { label: 'Passphrase of 8+ characters from an env var (16+ recommended)', gate: { type: 'passphrase', minLength: 8 } },
        { label: 'SSO / MFA', gate: { type: 'sso' } },
        { label: 'No extra gate (not recommended)', gate: null },
      ],
    } : {}),
  };
}

function analyze(file, { root = process.cwd(), methods } = {}) {
  const abs = path.resolve(root, file);
  const relPath = R.toPosix(path.relative(root, abs));
  let source = '';
  try { source = fs.readFileSync(abs, 'utf8'); } catch (e) { throw new Error(`cannot read ${file}: ${e.code || e.message}`); }
  const config = R.loadConfig(root);
  const out = analyzeSource({ relPath, source, methods, adminPaths: config.adminPaths, authRegexes: config.authRegexes, include: config.include });
  out.quiet = config.quiet;
  const sidecar = R.sidecarPathFor(relPath);
  out.sidecar = sidecar;
  out.saveDir = path.posix.dirname(sidecar) === '.' ? '.' : path.posix.dirname(sidecar);
  out.saveFile = path.posix.basename(sidecar);
  try {
    const ex = JSON.parse(fs.readFileSync(path.join(root, sidecar), 'utf8'));
    out.existing = { mode: ex.mode || 'annotate', reasonSource: ex.reason && ex.reason.source, hasNotes: !!ex.notes, gate: ex.gate, linkable: ex.linkable };
    if (ex.gate) out.needsGate = false;
  } catch { /* none yet */ }
  return out;
}

module.exports = { analyze, analyzeSource, classifyMethod, hasAuthSignal };
