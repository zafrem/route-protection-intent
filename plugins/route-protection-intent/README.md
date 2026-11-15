# route-protection-intent (Claude Code plugin)

**Documents the protection intent of each web route, so that even if the AI misses something, it can still be caught.** Each route gets a `.route.json` sidecar; `check` flags code that drifts from it, such as an authentication check removed from a route that is meant to be protected. It is not a secure-coding rule set or a linter: use `/security-review` and your own scanners for that.

> **Annotation is not protection.** By default the plugin only records intent. It blocks nothing, and `check` only warns.

## Install

```
/plugin marketplace add zafrem/route-protection-intent
/plugin install route-protection-intent --marketplace zafrem/route-protection-intent
```

This plugin is installed straight from the `zafrem/route-protection-intent` GitHub repository (it is its own marketplace). It is not listed in Anthropic's official plugin directory, so Claude Code treats it like any third-party plugin: read the code before you install it. Current release: `v0.1.6`.

Requires Node 18 or newer. The CLI is bundled in this plugin; nothing else is installed.

## What it adds

| Part | What it does |
| --- | --- |
| Hook (`PostToolUse` on `Write` and `Edit`) | Runs route analysis on route files, and warns about links to admin routes in any edited file |
| Skill `route-policy` | Saves clear classifications silently; asks you when unsure, for an admin gate, and before any link to a protected route is kept |
| `/route-protection-intent:set` | Create or change what a route is meant to be: `set /api/orders authenticated` (`--method GET,POST` for some methods only) |
| `/route-protection-intent:review` | Record that a person reviewed a route: `review /api/orders --by Dana` (date defaults to today) |
| `/route-protection-intent:note` | Add or clear a short reason on a route: `note /api/orders "login only for billing"` or `--clear` |
| `/route-protection-intent:unset` | Remove a sidecar, after asking you to confirm |
| `/route-protection-intent:check` | Finds missing, orphan, invalid and unclassified sidecars, exposed admin paths, and code that drifted from the recorded intent (`--base <git-ref>` also catches removed auth checks and downgrades) |
| `/route-protection-intent:report` | The route inventory: each route and method with its recorded protection, who decided it, whether an authentication check is visible in the code, and the gaps |
| `/route-protection-intent:verify` | Sends requests without credentials to a running local or staging app and compares each answer with the recorded protection (a protected route answering 200 is a gap) |
| `/route-protection-intent:spec` | Compares an OpenAPI (JSON) document with the recorded protection and lists mismatches |
| `/route-protection-intent:compile` | Opt-in: builds `routes-manifest.json` and an Nginx config from `mode: enforce` sidecars |

## What it does not do

- It does not enforce anything in `annotate` mode, and it never writes authentication code into your route source.
- It does not store secrets. An admin gate records only a type and a minimum length.
- It finds routes by file path (Next.js, SvelteKit, Nuxt, `routes/`) and by reading route strings in code for many languages (see the main README). Only Next.js is tested end to end; the others are untested on real projects, and router mount prefixes are not resolved.

## More

Full documentation, configuration and security policy: https://github.com/zafrem/route-protection-intent
