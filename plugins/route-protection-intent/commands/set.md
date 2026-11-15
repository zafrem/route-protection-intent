---
description: Record (create or change) what a route is meant to be - public, authenticated or internal
argument-hint: "<route or path> <public|authenticated|internal> [--method GET,POST]"
allowed-tools: Bash(node:*)
---

Record the protection intent of one route as the user decided. If `$ARGUMENTS` lacks the route or the exposure, ask the user for them; never choose the exposure yourself. Then run:

!`node "${CLAUDE_PLUGIN_ROOT}/cli/bin/route-protection-intent.js" set $ARGUMENTS`

Tell the user in one or two lines what was created or updated. Repeat any `warnings` (a lowered protection shows up as a policy-downgrade in the pull request; a public admin route is rarely intended). Say that setting a route replaces an earlier review, because the review covered the old policy, and offer `/route-protection-intent:review` to record a new one. Remind the user that a sidecar only records intent and does not protect the route.
