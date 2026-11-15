---
description: List every route with its recorded protection (public or authenticated), who decided it, and the gaps
argument-hint: "[--format table|md|json|csv] [--strict]"
allowed-tools: Bash(node:*)
---

Print the route inventory for the current project:

!`node "${CLAUDE_PLUGIN_ROOT}/cli/bin/security-sidecar.js" report . $ARGUMENTS`

Summarize it for the user: how many routes are public, authenticated and internal, and how many were confirmed by a person (`DECIDED BY` = `user`) versus only guessed by the heuristic. Then go through the GAPS column and explain each gap in one line with the fix: `no-sidecar` (classify the route), `unclassified` (choose public or secured), `orphan` (delete the stale sidecar), `schema` (fix the invalid file), `protected-no-auth-check` (the sidecar says protected but no authentication check is visible: add one, or record where it is enforced in `enforcement.via`), `public-with-auth-check` (confirm the route is really public). Remind the user that `AUTH CHECK` is a text match for common patterns and not proof that a route is protected; it does not test the running app.
