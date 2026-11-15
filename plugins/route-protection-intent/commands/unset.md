---
description: Remove a route's sidecar (asks for confirmation first)
argument-hint: "<route or path>"
allowed-tools: Bash(node:*)
---

Removing a sidecar deletes a recorded decision. First see what would be removed (this deletes nothing without `--yes`):

!`node "${CLAUDE_PLUGIN_ROOT}/cli/bin/route-protection-intent.js" unset $ARGUMENTS`

If the result has `needsConfirmation`, tell the user which sidecar and route it is, who decided it and any recorded review, then ask with AskUserQuestion whether to remove it. Only if they confirm, run the same command again with `--yes` added. If the route's code still exists, say it will show as `missing` in `check` until it is classified again. If the route no longer exists, this is the right fix for an `orphan`.
