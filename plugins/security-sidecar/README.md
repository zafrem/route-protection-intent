# security-sidecar (Claude Code plugin)

**Documents the protection intent of each web route, so that even if the AI misses something, it can still be caught.** Each route gets a `.route.json` sidecar; `check` flags code that drifts from it, such as an authentication check removed from a route that is meant to be protected. It is not a secure-coding rule set or a linter: use `/security-review` and your own scanners for that.

> **Annotation is not protection.** By default the plugin only records intent. It blocks nothing, and `check` only warns.

## Install

```
/plugin marketplace add zafrem/security-sidecar
/plugin install security-sidecar --marketplace zafrem/security-sidecar
```

This plugin is installed straight from the `zafrem/security-sidecar` GitHub repository (it is its own marketplace). It is not listed in Anthropic's official plugin directory, so Claude Code treats it like any third-party plugin: read the code before you install it. Current release: `v0.1.0`.

Requires Node 18 or newer. The CLI is bundled in this plugin; nothing else is installed.

## What it adds

| Part | What it does |
| --- | --- |
| Hook (`PostToolUse` on `Write` and `Edit`) | Runs route analysis on route files, and warns about links to admin routes in any edited file |
| Skill `route-policy` | Saves clear classifications silently; asks you when unsure, for an admin gate, and before any link to a protected route is kept |
| `/security-sidecar:check` | Finds missing, orphan, invalid and unclassified sidecars, exposed admin paths, and code that drifted from the recorded intent (`--base <git-ref>` also catches removed auth checks and downgrades) |
| `/security-sidecar:compile` | Opt-in: builds `routes-manifest.json` and an Nginx config from `mode: enforce` sidecars |

## What it does not do

- It does not enforce anything in `annotate` mode, and it never writes authentication code into your route source.
- It does not store secrets. An admin gate records only a type and a minimum length.
- It detects file-based routes (Next.js, and Express or FastAPI by file path). Routes registered only in code are not found.

## More

Full documentation, configuration and security policy: https://github.com/zafrem/security-sidecar
