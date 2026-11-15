# security-sidecar

**Documents the protection intent of each web route, so that even if the AI misses something, it can still be caught.**

Each route gets a small `.route.json` sidecar next to its code that says what the route is meant to be: public, login-only, or internal. `check` then compares that intent with the actual code, and warns, for example in a pull request, when an authentication check disappears from a route that is supposed to be protected.

This is not a collection of secure-coding rules or a linter. For those, use Claude Code's built-in `/security-review` and the linters and scanners you already run (for example Semgrep, ESLint security rules, Bandit). security-sidecar adds the one thing they lack: a written record of what each route is *supposed* to do.

> **Annotation is not protection.** By default (`mode: annotate`) this tool only records intent. It blocks nothing, and `check` only warns. A route with a sidecar is not thereby protected.

## The idea

1. **Record.** When a route is written, a sidecar next to it says what the route should be.
2. **Compare.** `check` compares that intent with the route code.
3. **Catch.** On a pull request it flags a removed authentication check or a weakened sidecar, even when nobody noticed.

A sidecar is a small JSON file (`app/api/orders/.route.json`):

```json
{
  "version": 1,
  "mode": "annotate",
  "route": "/api/orders",
  "methods": {
    "GET": {
      "exposure": "authenticated",
      "cache": {
        "policy": "no-store"
      },
      "indexing": "noindex"
    }
  },
  "reason": {
    "source": "heuristic",
    "rule": "path-api"
  }
}
```

A method can carry a short `note` (up to 300 characters) saying why it is set that way; it is kept on re-save and printed next to any finding for the route.

More on the [showcase site](https://zafrem.github.io/security-sidecar/).

## What it catches

`check` flags a route when its code and its recorded intent disagree:

| Finding | Meaning |
| --- | --- |
| `auth-removed` | An authentication check present at `--base` is gone from a route whose sidecar says it is protected |
| `auth-not-found` | The sidecar says protected, but no authentication check is visible in the route code |
| `base-unresolved` | `--base` was given but the ref cannot be used (typo, shallow clone), so no comparison was made. Always fails the run |
| `policy-downgrade` | A pull request weakened the intent itself: exposure lowered, gate, rate limit or network restriction removed |
| `intent-code-mismatch` | The route code's caching or `robots` metadata contradicts the sidecar |
| `admin-path-exposed` | A link, sitemap entry or `robots.txt` line points at an admin, gated or internal route |
| `admin-no-gate`, `admin-no-network-restriction` | An admin or internal route lacks the recorded extra gate or network restriction |
| `missing`, `orphan`, `unclassified`, `schema` | A route has no sidecar, a sidecar has no route, a value is undecided, or the file is invalid |

Authentication detection is a text match for common patterns (`getServerSession`, `await auth()`, `req.user`, `Depends(get_current_user)`, `@login_required`, and similar), so expect misses. If a check lives in middleware or a gateway, record that in `enforcement.via` and the route is not flagged.

## Use it on pull requests

Copy [`examples/github-action/security-sidecar.yml`](examples/github-action/security-sidecar.yml) into `.github/workflows/`. It runs `check --base origin/<target branch> --format github --strict`, so findings appear as annotations on the changed files and the job fails. The workflow clones this repo at the release in `SECURITY_SIDECAR_REF` (`v0.1.0`), so it works in any project. Move it to a newer tag on purpose. A tag can in principle be moved by the repo owner, so pin a full commit hash if you want the strictest setting. It was verified by running its steps against a separate test repository, not yet on a live pull request in another repo.

Locally, from a clone of this repo: `node bin/security-sidecar.js check <your-app> --base main`.

## How the intent gets recorded

1. You or the agent write a route file (`app/**/route.ts`, `pages/**`, `routers/**`, `routes/**`, `urls.py`, Go and Java handlers).
2. A PostToolUse hook runs `analyze` and gives Claude a classification suggestion (public or secured, with a conservative default).
3. Clear cases are saved silently. Unclear ones ask you, always including "leave unclassified".
4. Admin pages (`/admin` and your `adminPaths`) ask for an extra gate (SSO, MFA or a passphrase of 8+ characters; only the type and length are recorded) and are never linked from elsewhere unless you approve.
5. `save` validates against a schema, refuses secrets, and keeps your own edits.

Optional: `/security-sidecar:compile nginx|nextjs|cloudflare` turns `mode: enforce` sidecars into a manifest and config. Off by default.

## Install (Claude Code)

```
/plugin marketplace add zafrem/security-sidecar
/plugin install security-sidecar --marketplace zafrem/security-sidecar
```

Local testing: `/plugin marketplace add ./security-sidecar`.

Sidecar naming: `.route.json` where the directory is the route (Next.js app router); `<name>.route.json` where one directory holds many route files.

## Quiet mode

By default Claude mentions in one line when it saves a sidecar. To turn that off, set `"quiet": true` in `.security-sidecar.config.json`. Quiet mode silences only the success confirmation. Questions, refusals, `check` findings, link warnings and security problems in the code are always reported.

## Admin pages

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

## Security notes

- Keep `.route.json` out of statically served directories (`public/`, `static/`). `check` warns about this.
- `routes-manifest.json` lists admin and internal paths. Keep it out of public build output and deploy artifacts.
- `save` refuses secret-like values (keys, tokens, connection strings).

## Development

```
npm test          # core + hook tests
npm run bundle    # copy the CLI into plugins/security-sidecar/cli (commit the result)
```

Zero runtime dependencies; Node 18+.

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/zafrem)
