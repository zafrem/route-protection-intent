# security-sidecar

**Documents the protection intent of each web route, so that even if the AI misses something, it can still be caught.**

Each route gets a small `.route.json` file next to its code that says what the route is meant to be: public, login-only, or internal. `check` compares that record with the actual code and warns, for example in a pull request, when an authentication check disappears from a route that is supposed to be protected.

> **Annotation is not protection.** By default (`mode: annotate`) this tool only records intent and warns. It blocks nothing, and a route with a sidecar is not thereby protected.

## The core in one example

1. The sidecar records the intent. This is the smallest valid one (`app/api/orders/.route.json`); the tool also adds `cache`, `indexing` and a `reason`:

   ```json
   { "version": 1, "route": "/api/orders", "methods": { "GET": { "exposure": "authenticated" } } }
   ```

2. Later, a change removes the session check from the route:

   ```diff
    export async function GET() {
   -  const session = await getServerSession();
   -  if (!session) return new Response('Unauthorized', { status: 401 });
      return Response.json(await listOrders());
    }
   ```

3. On the pull request, `check --base origin/main` reports:

   ```
   [auth-removed] app/api/orders/route.ts: an authentication check present at origin/main is gone from this route,
   but its sidecar (app/api/orders/.route.json) says it must be protected. Restore it, or change the recorded intent on purpose
   ```

That is the whole idea: a written record of what each route should do, and a check that notices when the code stops matching it.

## Try it

Install in Claude Code (needs Node 18+):

```
/plugin marketplace add zafrem/security-sidecar
/plugin install security-sidecar --marketplace zafrem/security-sidecar
```

This plugin is installed straight from this GitHub repository (it is its own marketplace). It is not listed in Anthropic's official plugin directory, so Claude Code treats it like any third-party plugin: read the code before you install it. Current release: `v0.1.2`.

Then run `/security-sidecar:check` in your project. Routes without a sidecar show up as `missing`; ask Claude to classify them. From then on, writing or editing a route file records its intent automatically: clear cases are saved silently, unclear ones ask you, and the default is the secured side.

## The three findings that matter most

| Finding | Meaning |
| --- | --- |
| `auth-removed` | An authentication check present at `--base` is gone from a route whose sidecar says it is protected |
| `auth-not-found` | The sidecar says protected, but no authentication check is visible in the route code |
| `policy-downgrade` | A pull request weakened the intent itself: exposure lowered, or a gate, rate limit or network restriction removed |

Authentication detection is a text match for common patterns (`getServerSession`, `await auth()`, `req.user`, `Depends(get_current_user)`, `@login_required`, and similar), so expect misses. If a check lives in middleware or a gateway, record that in `enforcement.via` and the route is not flagged. Other findings are listed in the [reference](#reference).

## See every route at a glance

`/security-sidecar:report` (or `security-sidecar report .`) prints an inventory of every route and method: what is recorded as public or authenticated, who decided it, whether an authentication check is visible in the code, and the gaps.

```
ROUTE       METHOD  EXPOSURE       GATE  VIA  DECIDED BY  AUTH CHECK  GAPS
/api/login  POST    authenticated  -     -    heuristic   no          -
/products   GET     public         -     -    heuristic   no          -
/reports    GET     (none)         -     -    -           n/a         no-sidecar
```

The output is sorted and has no timestamps, so you can commit it (`--format md > docs/route-inventory.md`) and a pull request's diff shows exactly which route changed exposure. It is static: it does not contact a running app, so it cannot prove that a protected route really refuses anonymous callers.

## Sample report

Generated from [`examples/sample-api`](examples/sample-api) (a small app with five routes): `security-sidecar report examples/sample-api`.

```
ROUTE              METHOD  EXPOSURE       GATE  VIA  DECIDED BY  AUTH CHECK  GAPS
/account/settings  GET     authenticated  -     -    user        yes         -
/api/exports       GET     authenticated  -     -    heuristic   no          protected-no-auth-check
/api/health        GET     public         -     -    user        no          -
/api/orders        GET     authenticated  -     -    user        yes         -
/api/orders        POST    authenticated  -     -    user        yes         -
/blog              GET     public         -     -    heuristic   no          -

5 route(s), 6 entries: 2 public, 4 authenticated, 0 internal, 0 without a recorded decision; 4 confirmed by a person; 1 with gaps
```

Read it like this: `/api/exports` is recorded as `authenticated` (guessed by the tool, not confirmed by a person) but its code shows no authentication check, so it is listed as a gap and `check` reports `auth-not-found` for it.

Add `--format md` to get a Markdown version you can commit. (Keep a committed inventory out of folders the link scan covers if it lists admin routes: `check` flags a file that mentions an admin route.)

## Verify a running app

`security-sidecar verify --base-url http://localhost:3000` sends requests **without credentials** to a running app and compares each answer with the recorded intent:

```
ROUTE         METHOD  RECORDED       STATUS  RESULT  NOTE
/api/exports  GET     authenticated  200     gap     answered 200 to an anonymous request, but the sidecar says this route is authenticated
/api/orders   GET     authenticated  401     pass    refused with 401
/blog         GET     public         200     pass    answered 200
```

A route recorded as protected that answers 200 is a real gap, found against the running system and not by reading code. This also covers the case static checks cannot see: authentication in middleware that was weakened.

- **Safe by default:** only GET, HEAD and OPTIONS are sent. POST, PUT, PATCH and DELETE are skipped unless you pass `--include-mutating`, because they can change data.
- **Only your own systems:** it refuses any non-local address unless you pass `--allow-remote`. Point it at a local or staging app you own.
- **No credentials, ever:** no cookies or tokens are sent. A 404, a 5xx or no response is reported as `inconclusive`, never as a pass, and `--strict` makes those fail too.
- **Routes with parameters** (`/orders/[id]`) need sample values: `{ "verify": { "samples": { "id": "42" } } }` in `.security-sidecar.config.json`. Without one the route is `skipped`.
- **Exit code:** 1 if any gap is found.
- **Limit:** it shows that an anonymous caller is refused. It does not show that one user cannot read another user's data; that needs test accounts, which this does not use.

## Compare with an API spec

`security-sidecar spec openapi.json` compares an OpenAPI document (JSON) with the recorded sidecars. The spec says which operations need authentication; the sidecars say what you decided. Differences are listed:

- `mismatch`: recorded public but the spec requires authentication, or the spec documents none but the sidecar says protected.
- `not-recorded`: in the spec, no sidecar. `not-in-spec`: recorded, but the spec does not list it.

Path parameters match across styles (`{id}`, `[id]`, `:id`), and the first `servers` path is tried as a prefix (override with `--prefix`). Formats: `--format table|md|json|csv`; exit 1 on a mismatch, or with `--strict` on any unrecorded or unclassified route. YAML specs are not read: convert them to JSON first. The spec is a document, not proof; use `verify` against the running app.

## Languages

Routes are found in two ways:

- **By file path** (the URL comes from where the file sits): Next.js (`app/`, `pages/`), SvelteKit (`+server`), Nuxt (`server/api`), and `routes/`, `routers/` or `urls.py` in JS/TS, Python, Go and Java.
- **By content** (routes are strings in the code): Express-style and NestJS, Flask, FastAPI and Django, Go (chi, gin, echo, net/http, gorilla), Spring, JAX-RS and Ktor, ASP.NET (controllers and minimal APIs), Rails and Sinatra, Laravel, Symfony and Slim, actix, Rocket and axum, Phoenix, Vapor, and Dart shelf_router. A file counts only if it looks like it uses one of these frameworks. One sidecar then lists many endpoints with keys such as `"GET /api/orders"`.

Authentication patterns are known for each ecosystem; add your own regular expressions with `"authPatterns"` in `.security-sidecar.config.json`.

**Honest limits.** Only Next.js is tested end to end. The other patterns were checked against small snippets, not real projects, so expect misses and some false positives. Paths are taken as written: a router mount prefix or nested group is not known, which can make `verify` inconclusive. Central routing files (Rails `routes.rb`, Django `urls.py`, Phoenix) usually have no authentication check in the same file, so record `enforcement.via`.

## Use it on pull requests

Use the action (pin a release tag; Node is preinstalled on GitHub-hosted runners):

```yaml
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: zafrem/security-sidecar@v0.1.2
```

Inputs: `path` (default `.`), `base` (default `origin/<target branch>`), `strict` (default `true`). The action exists from `v0.1.2` (`v0.1.1` has an `action.yml` that the Marketplace rejects); the copyable workflow below does the same without it.

Or copy [`examples/github-action/security-sidecar.yml`](examples/github-action/security-sidecar.yml) into `.github/workflows/`. It runs `check --base origin/<target branch> --format github --strict`, so findings appear as annotations on the changed files and the job fails. The workflow clones this repo at the release in `SECURITY_SIDECAR_REF` (`v0.1.2`), so it works in any project. Move it to a newer tag on purpose. A tag can in principle be moved by the repo owner, so pin a full commit hash if you want the strictest setting. It was verified by running its steps against a separate test repository, not yet on a live pull request in another repo.

`--base` needs full git history (`fetch-depth: 0`). If the ref cannot be used, `check` reports `base-unresolved` and fails instead of passing without a comparison.

Locally, from a clone of this repo: `node bin/security-sidecar.js check <your-app> --base main`.

## What this does not do

- It does not make a system secure. The protection has to exist in your architecture: central authentication, authorization on each record, network limits for admin and internal routes, and tests that fail when protection is removed. See the [security architecture guide](docs/SECURITY-ARCHITECTURE.md).
- It is not a secure-coding rule set or a linter. Use Claude Code's built-in `/security-review` and the scanners you already run (for example Semgrep, ESLint security rules, Bandit).
- It cannot tell whether an authentication check is correct, only that one is present, and it cannot verify that a recorded `enforcement.via` control exists.

## Reference

### More findings

| Finding | Meaning |
| --- | --- |
| `intent-code-mismatch` | The route code's caching or `robots` metadata contradicts the sidecar |
| `admin-path-exposed` | A link, sitemap entry or `robots.txt` line points at an admin, gated or internal route |
| `admin-no-gate`, `admin-no-network-restriction` | An admin or internal route lacks the recorded extra gate or network restriction |
| `base-unresolved` | `--base` was given but the ref cannot be used (typo, shallow clone) |
| `missing`, `orphan`, `unclassified`, `schema` | A route has no sidecar, a sidecar has no route, a value is undecided, or the file is invalid |

### How the intent gets recorded

1. You or the agent write a route file (see [Languages](#languages)).
2. A PostToolUse hook runs `analyze` and gives Claude a classification suggestion.
3. Clear cases are saved silently. Unclear ones ask you, always including "leave unclassified".
4. `save` validates against a schema, refuses secrets, and keeps your own edits.

Sidecar naming: `.route.json` where the directory is the route (Next.js app router); `<name>.route.json` where one directory holds many route files. A method can carry a short `note` (up to 300 characters) saying why it is set that way; it is kept on re-save and printed next to any finding for the route.

### Admin pages

A renamed admin path (for example `/ops-k7Qx92mVbT4nLw`) is not recognized as admin unless you list it in `.security-sidecar.config.json`:

```json
{ "adminPaths": ["/ops-k7Qx92mVbT4nLw", "/backoffice-*"] }
```

Routes under a listed prefix are suggested as `authenticated`, `no-store`, `noindex` without prompting. `*` matches within one path segment.

The plugin then asks which extra gate to use and records it in the sidecar:

```json
"gate": { "type": "passphrase", "minLength": 8 }
```

The passphrase itself must live in an environment variable or secret store. It is never written to a sidecar (`save` rejects it). To allow a link to an admin page on purpose, confirm it when the plugin asks. It then saves `"linkable": true` with `reason.source: user`.

A hidden path is not protection. `check` warns about any admin or `internal` route whose `enforcement.via` lacks `ip-allowlist` or `mtls`. Put the real control (network restriction, MFA, server-side role checks) underneath the hidden path.

### Quiet mode

By default Claude mentions in one line when it saves a sidecar. To turn that off, set `"quiet": true` in `.security-sidecar.config.json`. Quiet mode silences only the success confirmation. Questions, refusals, `check` findings, link warnings and security problems in the code are always reported.

### Optional enforcement output

`/security-sidecar:compile nginx|nextjs|cloudflare` turns `mode: enforce` sidecars into a manifest and config. Off by default.

### Security notes

- Keep `.route.json` out of statically served directories (`public/`, `static/`). `check` warns about this.
- `routes-manifest.json` lists admin and internal paths. Keep it out of public build output and deploy artifacts.
- `save` refuses secret-like values (keys, tokens, connection strings).

### Development

```
npm test          # core + hook tests
npm run bundle    # copy the CLI into plugins/security-sidecar/cli (commit the result)
```

Zero runtime dependencies; Node 18+. More on the [showcase site](https://zafrem.github.io/security-sidecar/).

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/zafrem)
