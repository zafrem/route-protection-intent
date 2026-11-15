# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/). The plugin name `security-sidecar` is a fixed identifier and will not change.

## [Unreleased]

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
