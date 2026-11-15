# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/). The plugin name `security-sidecar` is a fixed identifier and will not change.

## [Unreleased]

## [0.1.2] - 2026-11-15

- `action.yml`: shortened the description to meet the GitHub Marketplace limit (125 characters). No other change from 0.1.1.

## [0.1.1] - 2026-11-15

- `verify`: probes a running app without credentials and compares each answer with the recorded intent (a protected route answering 2xx is a gap). Safe methods only by default (`--include-mutating` opts in), non-local targets need `--allow-remote`, no credentials are ever sent, and 404/5xx are inconclusive. New `/security-sidecar:verify` command and `verify.samples` config.
- `report`: a route inventory (one row per route and method: recorded exposure, gate, `enforcement.via`, who decided it, whether an authentication check is visible in the code) with gaps, as table, Markdown, JSON or CSV. New `/security-sidecar:report` command.
- `docs/SECURITY-ARCHITECTURE.md`: guidance on the architecture that makes recorded intent hold, how each sidecar field maps to a layer, what the tool cannot tell you, and a review checklist.

- Many more languages: routes registered in code are now read for JS/TS (Express-style, NestJS), Python (Flask, FastAPI, Django), Go, Java/Kotlin (Spring, JAX-RS, Ktor), C#, Ruby, PHP, Rust, Elixir, Swift and Dart, plus SvelteKit and Nuxt file routes. A sidecar can list many endpoints with `METHOD /path` keys. A broader authentication-pattern list, and `authPatterns` in the config for your own. Tested on small snippets only, not real projects; router mount prefixes are not resolved.
- `spec`: compares an OpenAPI JSON document with the recorded sidecars (`mismatch`, `not-recorded`, `unclassified`, `not-in-spec`). New `/security-sidecar:spec` command. YAML is not read.
- `action.yml`: a composite GitHub Action (`uses: zafrem/security-sidecar@<tag>`) that runs `check` on a pull request. Available from this tag.
- `examples/sample-api` and a sample report in the README and the site.

## [0.1.0] - 2026-11-15

First release. A tool for documenting protection intent per route, so that even if the AI misses something, it can still be caught.

- **Intent sidecars:** `analyze`, `save` and `check` for a `.route.json` per route (per-method `exposure`, `cache`, `indexing`, `rateLimit`, optional `note`; per-route `gate`, `linkable`, `enforcement.via`, `reason`, `notes`). Schema-validated, secrets refused, your edits kept on re-save.
- **Drift checks:** `auth-removed` and `auth-not-found` (authentication check missing from a route recorded as protected), `intent-code-mismatch` (caching or `robots` metadata contradicts the sidecar), and `policy-downgrade` (exposure lowered, gate, rate limit or network restriction removed) with `check --base <git-ref>`. An unusable `--base` reports `base-unresolved` and exits 1.
- **Pull requests:** `check --format github` prints annotations; `examples/github-action/security-sidecar.yml` is a copyable workflow that pins a commit of this tool.
- **Admin pages:** `adminPaths`, an extra gate prompt (SSO, MFA or a passphrase of 8+ characters; only type and length recorded), network-restriction warnings, and link detection with explicit user approval for `linkable`.
- **Claude Code plugin:** a PostToolUse hook, the `route-policy` skill, and `/security-sidecar:check` and `/security-sidecar:compile`. The CLI is bundled in the plugin. `quiet` option for the save confirmation.
- **Optional enforcement output:** `compile` renders `mode: enforce` sidecars to Nginx, Next.js or Cloudflare config. Off by default.
- Annotate mode records intent and blocks nothing. Secure-coding rules and code linting are left to `/security-review` and your own scanners.
- Known limits: authentication detection is one text pattern; only file-based routes are detected; Next.js is the tested framework.
