---
description: Add or clear a short note on why a route is set up the way it is
argument-hint: "<route or path> \"<text>\" [--method GET] | <route or path> --clear"
allowed-tools: Bash(node:*)
---

Add a note only with text the user gave you; never invent a reason, and never put a secret, key or password in it. If `$ARGUMENTS` has no text and no `--clear`, ask the user for it. Then run:

!`node "${CLAUDE_PLUGIN_ROOT}/cli/bin/route-protection-intent.js" note $ARGUMENTS`

Report which methods got the note. The note is shown next to any `check` finding for that route, so a reviewer sees the reason.
