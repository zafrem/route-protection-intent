---
description: Probe a running app without credentials and compare each route's answer with its recorded protection
argument-hint: "--base-url http://localhost:3000 [--include-mutating] [--strict]"
allowed-tools: Bash(node:*)
---

This sends real HTTP requests, so first make sure of the target. If `$ARGUMENTS` has no `--base-url`, ask the user for it. Only use a system the user owns and may test (a local or staging app). If the host is not local, tell the user you will add `--allow-remote` only after they confirm they own it. Never add `--include-mutating` unless the user explicitly asks and says the target is a test system: POST, PUT, PATCH and DELETE can change data.

Run: `node "${CLAUDE_PLUGIN_ROOT}/cli/bin/security-sidecar.js" verify . $ARGUMENTS`

Explain the result: `pass` means the answer matched the recorded intent, `gap` means an anonymous request was treated differently than recorded (most important: a protected route that answered 2xx), `inconclusive` means no clear answer (404, 5xx, no response; never treat these as a pass), `skipped` means nothing was sent (a route needing a sample value, set under `verify.samples` in `.security-sidecar.config.json`, or a method that changes data). Remind the user that this only shows anonymous callers are refused; it does not show that one user cannot read another user's data.
