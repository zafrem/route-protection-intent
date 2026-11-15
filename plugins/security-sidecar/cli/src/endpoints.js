'use strict';
// Finds the routes a source file registers in code, for frameworks where the URL is a string in the
// file rather than the file's own path (Spring, ASP.NET, Go routers, Rails, Laravel, Flask, Express...).
// Text matching only (no parser): paths are taken as written in the file. A prefix added where a router
// is mounted elsewhere, or by a nested group, is not known and is not added.
const VERBS = 'get|post|put|patch|delete|head|options';
const norm = (m) => (m === 'all' || m === 'any' || m === 'ALL' || m === 'ANY' ? '*' : m.toUpperCase());
const slash = (p) => '/' + String(p).replace(/^\/+/, '').replace(/\/+$/, '');
const join = (prefix, p) => {
  const a = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const b = String(p || '').replace(/^\/+|\/+$/g, '');
  return '/' + [a, b].filter(Boolean).join('/');
};
const list = (s) => [...String(s).matchAll(/['"]?([A-Za-z]+)['"]?/g)].map((m) => m[1].toUpperCase()).filter((m) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(m));
const CLIENTS = new Set(['axios', 'got', 'ky', 'superagent', 'http', 'https', 'fetch', 'client', 'request', 'supertest', 'agent', 'jquery', '$', 'cy', 'page', 'browser', 'session', 'requests', 'httpx', 'urllib']);

// Standard actions of a resource route (Rails resources, Laravel resource, Phoenix resources).
function resource(base, opts = '', kind = 'resources') {
  const p = slash(base);
  const all = { index: ['GET', p], create: ['POST', p], show: ['GET', `${p}/:id`], update: ['PATCH', `${p}/:id`], destroy: ['DELETE', `${p}/:id`] };
  let actions = Object.keys(all);
  if (kind === 'apiResource') actions = actions.filter((a) => a !== 'new');
  const only = /only\s*(?::|=>)\s*(?:\[([^\]]*)\]|%i\[([^\]]*)\]|\[([^\]]*)\])/.exec(opts);
  const except = /except\s*(?::|=>)\s*(?:\[([^\]]*)\]|%i\[([^\]]*)\])/.exec(opts);
  const names = (m) => (m ? [...String(m[1] || m[2] || m[3]).matchAll(/\w+/g)].map((x) => x[0]) : null);
  if (names(only)) actions = actions.filter((a) => names(only).includes(a));
  if (names(except)) actions = actions.filter((a) => !names(except).includes(a));
  const out = actions.map((a) => ({ method: all[a][0], path: all[a][1] }));
  if (actions.includes('update')) out.push({ method: 'PUT', path: `${p}/:id` });
  return out;
}

function matchAll(re, source, fn, out) {
  for (const m of source.matchAll(re)) { const r = fn(m); if (r) out.push(...(Array.isArray(r) ? r : [r])); }
}

const js = (source) => {
  const out = [];
  const nest = /@Controller\(\s*(?:\{[^}]*path\s*:\s*)?['"]([^'"]*)['"]/.exec(source);
  const prefix = nest ? nest[1] : '';
  matchAll(/\b([\w$]+)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*(['"`])(\/[^'"`]*)\3/g, source, (m) => (CLIENTS.has(m[1].toLowerCase()) ? null : { method: norm(m[2]), path: m[4] }), out);
  matchAll(/\.route\(\s*['"](\/[^'"]*)['"]\s*\)((?:\s*\.\s*(?:get|post|put|patch|delete|all)\s*\([^)]*\))+)/g, source, (m) => [...m[2].matchAll(/\.\s*(get|post|put|patch|delete|all)\s*\(/g)].map((x) => ({ method: norm(x[1]), path: m[1] })), out);
  matchAll(/@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:['"]([^'"]*)['"])?\s*\)/g, source, (m) => ({ method: norm(m[1]), path: join(prefix, m[2]) }), out);
  return out;
};

const python = (source) => {
  const out = [];
  const pre = /(?:APIRouter|Blueprint)\([^)]*?(?:prefix|url_prefix)\s*=\s*['"]([^'"]*)['"]/.exec(source);
  const prefix = pre ? pre[1] : '';
  matchAll(/@[\w.]+\.(get|post|put|patch|delete|head|options)\(\s*['"]([^'"]*)['"]/g, source, (m) => ({ method: norm(m[1]), path: join(prefix, m[2]) }), out);
  matchAll(/@[\w.]+\.route\(\s*['"]([^'"]+)['"]([^)]*)\)/g, source, (m) => {
    const ms = /methods\s*=\s*[\[({]([^\])}]*)[\])}]/.exec(m[2]);
    return (ms ? list(ms[1]) : ['GET']).map((method) => ({ method, path: join(prefix, m[1]) }));
  }, out);
  matchAll(/\b(?:re_)?path\(\s*['"]([^'"]*)['"]/g, source, (m) => ({ method: '*', path: join('', m[1].replace(/^\^|\$$/g, '')) }), out);
  return out;
};

const go = (source) => {
  const out = [];
  matchAll(/\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*"(\/[^"]*)"/g, source, (m) => ({ method: norm(m[1]), path: m[2] }), out);
  matchAll(/\.\s*(?:HandleFunc|Handle)\s*\(\s*"(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+)?(\/[^"]*)"([^\n]*)/g, source, (m) => {
    const ms = /\.Methods\(([^)]*)\)/.exec(m[3]);
    const methods = m[1] ? [m[1]] : ms ? list(ms[1]) : ['*'];
    return methods.map((method) => ({ method, path: m[2] }));
  }, out);
  return out;
};

const jvm = (source) => {
  const out = [];
  let prefix = '';
  const cls = /@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|open\s+|abstract\s+|data\s+)*(?:class|interface)\b/.exec(source);
  if (cls) prefix = cls[1];
  const jaxPrefix = /@Path\(\s*"([^"]*)"\s*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|open\s+)*(?:class|interface)\b/.exec(source);
  if (jaxPrefix) prefix = jaxPrefix[1];
  matchAll(/@(Get|Post|Put|Patch|Delete)Mapping\b(?:\s*\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"[^)]*\))?/g, source, (m) => ({ method: norm(m[1]), path: join(prefix, m[2]) }), out);
  matchAll(/@RequestMapping\s*\(([^)]*method\s*=[^)]*)\)/g, source, (m) => {
    const p = /(?:(?:value|path)\s*=\s*)?\{?\s*"([^"]*)"/.exec(m[1]);
    const ms = [...m[1].matchAll(/RequestMethod\.(\w+)/g)].map((x) => x[1].toUpperCase());
    return (ms.length ? ms : ['*']).map((method) => ({ method, path: join(prefix, p ? p[1] : '') }));
  }, out);
  // JAX-RS: @GET with an @Path on the same method, written before or after it.
  for (const m of source.matchAll(/@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
    const after = /^[^{;]{0,160}?@Path\(\s*"([^"]*)"/.exec(source.slice(m.index + m[0].length));
    const before = /@Path\(\s*"([^"]*)"\s*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*$/.exec(source.slice(Math.max(0, m.index - 120), m.index));
    out.push({ method: m[1], path: join(prefix, (after && after[1]) || (before && before[1]) || '') });
  }
  matchAll(/(?:^|\n)\s*(get|post|put|patch|delete)\(\s*"(\/[^"]*)"/g, source, (m) => ({ method: norm(m[1]), path: m[2] }), out);
  return out;
};

const csharp = (source) => {
  const out = [];
  const cls = /\[Route\(\s*"([^"]*)"\s*\)\]\s*(?:\[[^\]]*\]\s*)*(?:public\s+)?(?:abstract\s+)?class\s+(\w+?)(?:Controller)?\b/.exec(source);
  const prefix = cls ? cls[1].replace(/\[controller\]/gi, cls[2].toLowerCase()) : '';
  matchAll(/\[Http(Get|Post|Put|Patch|Delete|Head|Options)(?:\(\s*"([^"]*)"\s*\))?\]/g, source, (m) => ({ method: norm(m[1]), path: join(prefix, m[2]) }), out);
  matchAll(/\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]*)"/g, source, (m) => ({ method: norm(m[1]), path: slash(m[2]) }), out);
  return out;
};

const ruby = (source) => {
  const out = [];
  matchAll(/^\s*(get|post|put|patch|delete)\s+['"]\/?([^'"]+)['"]/gm, source, (m) => ({ method: norm(m[1]), path: slash(m[2]) }), out);
  matchAll(/^\s*resources?\s+:(\w+)([^\n]*)/gm, source, (m) => resource(m[1], m[2], 'resources'), out);
  return out;
};

const php = (source) => {
  const out = [];
  matchAll(/Route::(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]*)['"]/g, source, (m) => ({ method: norm(m[1]), path: slash(m[2]) }), out);
  matchAll(/Route::match\(\s*\[([^\]]*)\]\s*,\s*['"]([^'"]*)['"]/g, source, (m) => list(m[1]).map((method) => ({ method, path: slash(m[2]) })), out);
  matchAll(/Route::(resource|apiResource)\(\s*['"]([^'"]+)['"]/g, source, (m) => resource(m[2], '', m[1]), out);
  matchAll(/#\[Route\(\s*['"]([^'"]*)['"]([^\]]*)\]/g, source, (m) => {
    const ms = /methods\s*:\s*\[([^\]]*)\]/.exec(m[2]);
    return (ms ? list(ms[1]) : ['*']).map((method) => ({ method, path: slash(m[1]) }));
  }, out);
  matchAll(/@Route\(\s*"([^"]*)"([^)]*)\)/g, source, (m) => {
    const ms = /methods\s*=\s*\{([^}]*)\}/.exec(m[2]);
    return (ms ? list(ms[1]) : ['*']).map((method) => ({ method, path: slash(m[1]) }));
  }, out);
  matchAll(/\$\w+\s*->\s*(get|post|put|patch|delete|options|any)\(\s*['"]([^'"]*)['"]/g, source, (m) => ({ method: norm(m[1]), path: slash(m[2]) }), out);
  return out;
};

const rust = (source) => {
  const out = [];
  matchAll(/#\[(get|post|put|patch|delete|head|options)\(\s*"([^"]*)"/g, source, (m) => ({ method: norm(m[1]), path: slash(m[2]) }), out);
  matchAll(/\.route\(\s*"([^"]*)"\s*,\s*((?:(?:get|post|put|patch|delete|head|options)\s*\([^)]*\)\s*\.?\s*)+)/g, source, (m) => [...m[2].matchAll(/\b(get|post|put|patch|delete|head|options)\s*\(/g)].map((x) => ({ method: norm(x[1]), path: slash(m[1]) })), out);
  return out;
};

const elixir = (source) => {
  const out = [];
  matchAll(/^\s*(get|post|put|patch|delete)\s+"([^"]*)"/gm, source, (m) => ({ method: norm(m[1]), path: slash(m[2]) }), out);
  matchAll(/^\s*resources\s+"([^"]+)"([^\n]*)/gm, source, (m) => resource(m[1], m[2].replace(/only:\s*\[([^\]]*)\]/, 'only: [$1]'), 'resources'), out);
  return out;
};

const swift = (source) => {
  const out = [];
  matchAll(/\.(get|post|put|patch|delete)\(\s*((?:"[^"]*"|:\w+)(?:\s*,\s*(?:"[^"]*"|:\w+))*)\s*[,)]/g, source, (m) => ({
    method: norm(m[1]),
    path: '/' + [...m[2].matchAll(/"([^"]*)"|:(\w+)/g)].map((x) => (x[1] !== undefined ? x[1] : `:${x[2]}`)).filter(Boolean).join('/'),
  }), out);
  return out;
};

const dart = (source) => {
  const out = [];
  matchAll(/\b(?!axios|http|client)\w+\.(get|post|put|patch|delete|head|options)\(\s*'(\/[^']*)'/g, source, (m) => ({ method: norm(m[1]), path: m[2] }), out);
  return out;
};

// ext: file extensions; marker: a file must look like it uses a web framework before its calls count.
const DIALECTS = [
  { id: 'js', ext: /\.(?:[cm]?[jt]sx?)$/, marker: /['"](?:express|fastify|koa|@koa\/router|koa-router|hono|elysia|restify|@hapi\/hapi|@nestjs\/common|polka|itty-router|next-connect)['"]/, extract: js },
  { id: 'python', ext: /\.py$/, marker: /(?:^|\n)\s*(?:from|import)\s+(?:flask|fastapi|starlette|django|sanic|bottle|aiohttp|tornado|quart|falcon|pyramid)\b/, extract: python },
  { id: 'go', ext: /\.go$/, marker: /"(?:net\/http|github\.com\/(?:gin-gonic|labstack|go-chi|gorilla|gofiber|julienschmidt|beego|emicklei|ant0ine)[^"]*)"/, extract: go },
  { id: 'jvm', ext: /\.(?:java|kt|kts)$/, marker: /@(?:RestController|Controller|RequestMapping|GetMapping|PostMapping|Path)\b|io\.ktor|\brouting\s*\{/, extract: jvm },
  { id: 'csharp', ext: /\.cs$/, marker: /\[ApiController\]|:\s*(?:Controller|ControllerBase)\b|\.Map(?:Get|Post|Put|Patch|Delete)\(/, extract: csharp },
  { id: 'ruby', ext: /\.rb$/, marker: /Rails\.application\.routes|\bSinatra\b|<\s*Sinatra::|(?:^|\/)routes\.rb$/, extract: ruby, markerOnPath: true },
  { id: 'php', ext: /\.php$/, marker: /Route::|\$\w+\s*->\s*(?:get|post|put|patch|delete)\(|#\[Route|@Route\(/, extract: php },
  { id: 'rust', ext: /\.rs$/, marker: /\b(?:actix_web|axum|rocket|warp|poem|tide)\b/, extract: rust },
  { id: 'elixir', ext: /\.exs?$/, marker: /use\s+\w+(?:Web)?\.Router|use\s+Phoenix\.Router/, extract: elixir },
  { id: 'swift', ext: /\.swift$/, marker: /import\s+Vapor/, extract: swift },
  { id: 'dart', ext: /\.dart$/, marker: /shelf_router/, extract: dart },
];

const CODE_EXT = new RegExp(DIALECTS.map((d) => d.ext.source).join('|'));
const dialectFor = (relPath) => DIALECTS.find((d) => d.ext.test(relPath));

// Returns [{ method, path }] sorted and de-duplicated; [] when the file does not look like a router.
function extractEndpoints(source, relPath) {
  const d = dialectFor(relPath);
  if (!d || !(d.marker.test(source) || (d.markerOnPath && d.marker.test(relPath)))) return [];
  const seen = new Set();
  const out = [];
  for (const e of d.extract(source)) {
    const p = e.path && e.path.startsWith('/') ? e.path : slash(e.path || '/');
    const key = `${e.method} ${p}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: e.method, path: p });
  }
  const order = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', '*'];
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : order.indexOf(a.method) - order.indexOf(b.method)));
}

// The sidecar `route` for a file: the longest path prefix shared by all its endpoints.
function commonRoute(endpoints) {
  if (!endpoints.length) return '/';
  const parts = endpoints.map((e) => e.path.split('/').filter(Boolean));
  const shared = [];
  for (let i = 0; i < parts[0].length; i++) {
    if (parts.every((p) => p[i] === parts[0][i] && !/^[:{[<]/.test(p[i]))) shared.push(parts[0][i]); else break;
  }
  return '/' + shared.join('/');
}

// Method keys may carry a path: "GET /orders/:id". A bare method ("GET") uses the sidecar's `route`.
const keyOf = (e) => `${e.method} ${e.path}`;
function parseKey(key) {
  const i = key.indexOf(' ');
  return i === -1 ? { method: key, path: null } : { method: key.slice(0, i), path: key.slice(i + 1) };
}

module.exports = { extractEndpoints, commonRoute, keyOf, parseKey, dialectFor, CODE_EXT, DIALECTS };
