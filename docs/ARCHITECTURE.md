# security-sidecar Architecture

How the pieces fit together. For requirements see [SRS.md](SRS.md); for day-to-day use see [PLAYBOOK.md](PLAYBOOK.md).

## 1. Big picture

All logic lives in one dependency-free Node CLI plus one JSON schema. The Claude Code plugin is a thin adapter that decides *when* to call the CLI. Nothing runs as a server, and nothing leaves the machine.

```text
 Claude Code session
 ┌──────────────────────────────────────────────────────────────┐
 │  agent writes/edits a file                                   │
 │        │                                                     │
 │        ▼  PostToolUse (Write|Edit)                           │
 │  hooks/post-tool-use.js ──► route file?  yes ─► analyze ──┐  │
 │                              │                            │  │
 │                              no ─► link scan ─► warning   │  │
 │                                                           ▼  │
 │  skills/route-policy ◄──── additionalContext (JSON) ──────┘  │
 │        │  high confidence: save silently                     │
 │        │  low confidence / admin gate / linkable: ask user   │
 │        ▼                                                     │
 │  cli/bin/security-sidecar.js save ──► .route.json            │
 └──────────────────────────────────────────────────────────────┘
        later, locally / pre-commit / CI:   check   ·   compile (opt-in)
```

## 2. Repository layout

| Path | Role |
| --- | --- |
| `schema/route.schema.json` | Single source of truth for the sidecar format |
| `src/` | Core library and CLI (CommonJS, no dependencies) |
| `bin/security-sidecar.js` | CLI entry point |
| `plugins/security-sidecar/` | The Claude Code plugin (what users install) |
| `plugins/security-sidecar/cli/` | **Generated copy** of `bin/`, `src/`, `schema/` (see 7) |
| `.claude-plugin/marketplace.json` | Lets users run `/plugin marketplace add` |
| `scripts/bundle.js` | Copies the core into the plugin |
| `examples/github-action/` | Ready-to-copy pull-request workflow that runs `check --base` |
| `test/core.test.js` | Unit tests, plus hook and bundle-freshness tests |
| `examples/nextjs/` | Sample app with generated sidecars |

## 3. Core modules (`src/`)

| Module | Responsibility |
| --- | --- |
| `routes.js` | Which files are routes (globs), the URL a file serves, HTTP methods in source, sidecar file naming, directory walk, `adminPaths` matching, config loading |
| `endpoints.js` | Per-language extractors (JS/TS, Python, Go, JVM, C#, Ruby, PHP, Rust, Elixir, Swift, Dart) that read route strings from code behind a framework marker; `METHOD /path` key helpers |
| `spec.js` | Compares an OpenAPI JSON document with the recorded sidecars (path-parameter normalization, `servers` prefix) |
| `analyze.js` | Classification: exposure, cache, indexing, confidence, options, `needsGate`, `existing` sidecar info |
| `guidance.js` | Framework-specific implementation text for each exposure, (text only) |
| `validate.js` | Minimal JSON Schema validator for the subset the schema uses |
| `secrets.js` | Secret-pattern detection for every string value and key |
| `save.js` | Merge with existing sidecar, validate, secret scan, canonical key order, write |
| `check.js` | Repo-wide findings and exit code |
| `verify.js` | Live probe: sends credential-free requests to a running app (safe methods by default, local targets unless `--allow-remote`) and compares each status with the recorded intent |
| `report.js` | Route inventory: one row per route and method (recorded exposure, gate, `enforcement.via`, who decided it, whether the code shows an auth check) with gaps; table, Markdown, JSON or CSV |
| `links.js` | Finds references to protected routes in other files |
| `compile.js` | Collects `mode: enforce` sidecars into the manifest and calls a target |
| `targets/nginx.js` | Renders the Nginx config |
| `targets/nextjs.js` | Renders Next.js `headers()` and `routePolicies` module |
| `targets/cloudflare.js` | Renders Cloudflare `_headers` and WAF rule expressions |
| `cli.js` | Argument parsing and JSON output for the subcommands |

## 4. Data model

A sidecar describes one route, per HTTP method. Exposure, caching and enforcement are separate fields, so protection is never equated with CDN caching.

- **Per method:** `exposure` (`public`, `authenticated`, `internal`, `unclassified`), `cache`, `indexing`, `rateLimit`, and an optional `note` (one comment, up to 300 characters, kept across re-saves and shown next to findings for that route).
- **Per route:** `mode` (`annotate` default, `enforce`), `enforcement.via`, `gate`, `linkable`, `reason`, `notes`.
- `additionalProperties: false` everywhere, so unknown fields are rejected.

**Naming.** Where the directory *is* the route (Next.js `app/**/route.ts` and `page.tsx`) the file is `.route.json`. Where one directory holds many route files (`pages/`, `routes/`, `routers/`) each gets `<name>.route.json`. `save` accepts only these names and no path separators.

## 5. Key flows

### 5.1 analyze

1. Derive the URL from the path (route groups `(x)` and slots `@x` dropped; `[id]` kept).
2. Detect methods from `export function GET`, `router.post(`, `@router.get(` and similar. Unknown means `*`.
3. Classify each method (first match wins): internal segments, then admin (literal or `adminPaths`), then auth segments (`api`, `user`, `cart`, `login` ...), then mutating methods, then public content paths. Anything else is **low confidence and suggests the secured side**.
4. The whole file takes the most restrictive method. Confidence is `low` if any method is low.
5. Output includes `quiet` (from config), `policy` (ready to save), `options` (only when low), `guidance`, and for admin routes `needsGate` and `gateOptions`.

### 5.2 save

1. Reject bad file names and non-directories.
2. If a sidecar exists, merge: keep `notes`; keep `enforcement`, `gate`, `linkable` unless supplied; keep user-chosen methods and reason unless the new data is also from the user.
3. Refuse `linkable: true` without `reason.source: user` (unless already set).
4. Validate against the schema, then scan every string for secrets. Any failure exits 2 and writes nothing.
5. Write with canonical key order. Identical content is not rewritten, so diffs stay small.

### 5.2a report

`report.js` walks the repo once and builds one row per route and method: the recorded exposure, gate, `enforcement.via`, `reason.source` (who decided), and whether any route file shows an authentication check (`hasAuthSignal`; per file, so every method of a route shares the value). Routes with no sidecar, orphan sidecars and invalid sidecars get rows too. Gaps: `no-sidecar`, `orphan`, `schema`, `unclassified`, `protected-no-auth-check` (same exemptions as `auth-not-found`) and `public-with-auth-check`. Rows are sorted by route and method and carry no timestamps, so the output can be committed and diffed. Exit code is 0 unless `--strict` is given and there are gaps. It is static: it never contacts a running app.

### 5.2c Route detection models

Legacy files (Next.js, SvelteKit, Nuxt, and `routes/`, `routers/`, `urls.py` in JS/TS, Python, Go, Java) take their URL from the file path (`isLegacy`). Any other source file is sniffed (up to 512 KB, outside vendor and build directories): it is a route file only if `endpoints.js` finds a framework marker and at least one endpoint. Endpoint files get one sidecar whose method keys are `METHOD /path`; the sidecar `route` is the common prefix. Authentication is judged per file with the built-in `AUTH_SIGNALS` list plus the project's `authPatterns`.

### 5.2d spec

`spec.js` reads an OpenAPI JSON file, takes each operation's effective `security` (operation overrides root; none or an empty alternative means public) and matches it with the report rows by method and normalized path (`{id}`, `:id`, `[id]`, `<id>` all become one placeholder; the first `servers` path is tried as a prefix). Output: `match`, `mismatch`, `not-recorded`, `unclassified`, `not-in-spec`. Exit 1 on a mismatch, or with `--strict` on any unrecorded or unclassified route.

### 5.2b verify

`verify.js` takes the rows from `report` for routes recorded as `public`, `authenticated` or `internal`, fills dynamic segments from `verify.samples`, and sends one request per route and method with `fetch`, no credentials and `redirect: 'manual'`. Judgement: for protected routes 401/403 and a redirect elsewhere pass, 2xx is a `gap`, and 404/405/400/422/5xx or a network error is `inconclusive`; for public routes 2xx passes and 401/403 is a `gap`. Guards: only `GET`/`HEAD`/`OPTIONS` unless `--include-mutating`; non-loopback hosts need `--allow-remote`; a timeout per request and an optional delay. It is the only part of the tool that makes network requests, and it never sends cookies, tokens or a body. Because the CLI entry waits on a promise, `verify` is the one async command.

### 5.3 check

Walk the repo once, then compare the set of *expected* sidecars (from route files) with those on disk. Findings:

| Type | Meaning |
| --- | --- |
| `missing` | Route has no sidecar |
| `orphan` | Sidecar has no matching route source |
| `schema` | Invalid JSON or schema violation |
| `unclassified` | A method is still `unclassified` |
| `static-served` | Sidecar sits under `public/` or `static/` |
| `admin-no-network-restriction` | Admin or internal route without `ip-allowlist` or `mtls` |
| `admin-no-gate` | Admin route without a `gate` |
| `admin-path-exposed` | Another file references an admin, gated or internal route |
| `linkable-not-approved` | `linkable: true` without `reason.source: user` |
| `intent-code-mismatch` | Route caching or `robots` metadata contradicts the sidecar |
| `auth-not-found` | Sidecar says protected but no auth signal is in the route code, and `enforcement.via` names no external control |
| `auth-removed` | With `--base`: an auth signal present at the base ref is gone from the route code (reported instead of `auth-not-found`) |
| `base-unresolved` | `--base` was given but the ref is invalid or cannot be resolved (typo, shallow clone). Always exits 1, so a pipeline never passes without the comparison |
| `policy-downgrade` | With `--base`: the sidecar's exposure, gate, rate limit, mode or network restriction was weakened since the base ref |

Exit code: 0 in annotate mode; 1 if `--strict` is given or the finding belongs to an `enforce` sidecar. `--format github` prints one `::error` (`auth-removed`, `policy-downgrade`) or `::warning` line per finding, which GitHub shows as annotations on the pull request.

Auth detection reuses `hasAuthSignal` from `analyze.js`: one regular expression over the route source. That is deliberately small. It misses auth done in middleware or helper modules, which is why `enforcement.via` can declare an external control, and it cannot tell a check that is correct from one that is merely present.

### 5.4 compile (opt-in)

Only `mode: enforce` sidecars are used. Compile stops (exit 1) if any still has `unclassified`. It always writes `routes-manifest.json`, then renders the target config for sidecars whose `enforcement.via` the target accepts (Nginx: `api-gateway`, `ip-allowlist`); the rest are reported as skipped. Output is sorted and has no timestamps, so it is deterministic.

### 5.5 Link guard

`links.js` builds the protected set (admin, gated, or internal, and not `linkable`). A file is excluded if it belongs to that route itself, is a config file (`*.config.*`, `middleware.*`) or a test. Matching is textual: the route's static prefix as a whole path token, or a full URL ending in it. The hook runs it on any non-route file the agent writes; `check` runs it on the whole repo.

### 5.6 What this tool does not do

Secure-coding rules, input validation checks and code linting are left to Claude Code's built-in `/security-review` and your own scanners (Semgrep, ESLint security rules, Bandit). They were removed from this project to keep the code small and to avoid duplicating tools that do it better. `guidance.js` keeps only the route-level protection steps.

## 6. Security design

- **Intent is not enforcement.** Annotate mode blocks nothing, and the docs and `check` output say so.
- **Conservative defaults.** Unsure means secured or unclassified, never public.
- **No secrets, ever.** `save` rejects secret-like values. The gate records only a type and a minimum length.
- **Untrusted input.** File paths and source text are parsed in-process. No shell command is built from them. The CLI never edits route source (NFR-6).
- **Human decisions are protected.** `save` preserves `notes`, user-chosen values, `gate` and `linkable`. Removing a protection (`linkable`) needs `reason.source: user`.
- **Obscurity is not a control.** Admin routes get warnings until a network restriction and a gate are recorded.
- **Known limit.** The `user` source is a convention, not authentication: an agent could write it. `check` detects hand edits but cannot prove who made a choice.

## 7. Packaging

Plugin installs copy only `plugins/security-sidecar/`, so the CLI is bundled inside it (`cli/`). `npm run bundle` regenerates it from the root sources. A test fails if the copy is stale. Always edit `src/`, never `plugins/.../cli/`.

## 8. Extension points

| To add | Touch |
| --- | --- |
| A route pattern or framework | `routes.js` (`DEFAULT_PATTERNS`, `detectMethods`, `routeFromPath`), `guidance.js` |
| A classification rule | `analyze.js` (`classifyMethod`) |
| A schema field | `schema/route.schema.json`, `save.js` (`KEY_ORDER`, merge), docs |
| A compile target | New file in `src/targets/` exporting `accepts`, `outFile`, `render`; register in `compile.js` |
| Another agent (Codex, agy) | A new adapter that calls the same CLI; no core change (SRS 6.3) |
| More auth patterns | `AUTH_SIGNALS` in `analyze.js`, or `authPatterns` in the project config |
| Another language or framework | a dialect in `DIALECTS` in `endpoints.js` (extension, marker, extractor) |

## 9. Known limitations

- Routes registered in code are read by per-language patterns that were tested only on small snippets. Router mount prefixes and nested groups are not resolved, so paths are as written in the source.
- Specs: JSON only, no YAML; the spec is compared as a document.
- Compile targets (Nginx, Next.js, Cloudflare) are optional output only; none verifies that the config is deployed.
- No verification that the recorded enforcement exists.
- Link detection is text matching; paths built at runtime are missed.
- Auth detection is a single regular expression: a handler that checks auth through an unlisted helper reads as unprotected (`auth-not-found`), and a present-but-wrong check reads as fine.
