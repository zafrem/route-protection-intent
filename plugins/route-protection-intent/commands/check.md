---
description: Check that every route has a valid sidecar and summarize findings
argument-hint: "[--strict] [--base <git-ref>]"
allowed-tools: Bash(node:*)
---

Run the route-protection-intent check on the current project and summarize the result:

!`node "${CLAUDE_PLUGIN_ROOT}/cli/bin/route-protection-intent.js" check . --json $ARGUMENTS`

Group the findings by type (auth-removed and auth-not-found first, then policy-downgrade, intent-code-mismatch, admin-path-exposed, admin-no-gate, admin-no-network-restriction, linkable-not-approved, missing, orphan, schema, unclassified, static-served). For auth-not-found, ask whether the check lives in middleware or a gateway and, if so, offer to record it in enforcement.via. For each group give the files and the suggested fix. Offer to classify missing or unclassified routes using the route-policy skill. Remind the user that in annotate mode findings are warnings only and exit code 0 does not mean the routes are protected.
