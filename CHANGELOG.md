# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/). The plugin name `security-sidecar` is a fixed identifier and will not change.

## [Unreleased]

Refocused on recording protection intent and catching drift from it.

- `check`: `auth-removed` (an authentication check present at `--base` is gone from a route whose sidecar says it is protected) and `auth-not-found` (no check visible in the route code, unless `enforcement.via` names an external control).
- Optional per-method `note` (up to 300 characters): kept across re-saves and printed next to findings for that route.
- `check --base`: an invalid or unresolvable ref (typo, shallow clone) now reports `base-unresolved` and exits 1 instead of silently skipping the comparison; refs starting with `-` are refused.
- Repo hygiene: `.gitignore` (including `compile` output that lists admin paths) and `"private": true` so the repo cannot be published to npm by accident.
- `check --format github`: findings as pull-request annotations. New `examples/github-action/security-sidecar.yml`.
- New positioning: a tool for documenting protection intent per route, so that even if the AI misses something it can still be caught.
- Removed, in favour of Claude Code's `/security-review` and your own scanners: the secure-coding guidelines (`guidelines/`, `adapters/`, the `secure-functions` skill, the session-start reminder and the `guidelines` config option), the risky-code lint and its suppressions, and the per-handler `Input:` guidance lines.

- `analyze`: detect in-handler authentication signals (`getServerSession`, `await auth()`, `req.user`, `Depends`, `@login_required`) to boost confidence (`source-auth-signal`), and preserve distinct per-method policies in multi-method route files.
- `check`: detect `intent-code-mismatch` when route source caching (`force-static`, `revalidate > 0`) or `robots` metadata contradicts the sidecar.
- `check`: add `--base <git-ref>` and `policy-downgrade` findings to catch weakened exposure, removed gates, removed rate limits, or removed network restrictions against a git ref.
- `compile`: add `nextjs` (`security-sidecar.nextjs.js`) and `cloudflare` (`security-sidecar._headers` + WAF expressions) targets alongside `nginx`.
- `lint`: add Go (`.go`) and Java (`.java`) support for shell execution and SQL string formatting, plus `xss-raw-html` (`dangerouslySetInnerHTML`, `innerHTML`) for JS/TS.

## [0.1.0]

First version. Not yet tagged or released.

- Core CLI: `analyze`, `save`, `check`, `compile` (Nginx target).
- Claude Code plugin: PostToolUse hook, `route-policy` and `secure-functions` skills, `check` and `compile` commands.
- Admin protection: `adminPaths`, extra gate prompt, link detection with user approval for `linkable`.
- Risky-code lint for `eval`, exec and string-built SQL, with reviewable suppressions.
- `quiet` option for the save confirmation.
- Session-start hook that reminds the agent of the secure-coding rules for all code; opt out with `"guidelines": false`.
- Common secure-coding guidelines (SG-1 to SG-14, TypeScript, Python, Go and Java notes) generated into the `secure-functions` skill and `adapters/` for `AGENTS.md`, Cursor and Gemini.
