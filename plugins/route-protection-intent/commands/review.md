---
description: Record that a person reviewed a route's sidecar (who and when)
argument-hint: "<route or path> --by <name> [--date YYYY-MM-DD]"
allowed-tools: Bash(node:*)
---

Record a review. The reviewer is a person, so if `$ARGUMENTS` has no `--by <name>`, ask the user who reviewed it and wait. Never invent a name, and do not reuse a name or date from an earlier review. The date defaults to today. Then run:

!`node "${CLAUDE_PLUGIN_ROOT}/cli/bin/route-protection-intent.js" review $ARGUMENTS`

Confirm in one line who reviewed which route and on what date. Remind the user that the name is only text in a committed file, so it is a record for reviewers, not proof, and that `check` reports `review-stale` if the route code changes after that day.
