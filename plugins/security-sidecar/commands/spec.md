---
description: Compare an OpenAPI (JSON) document with the recorded route protection
argument-hint: "<openapi.json> [--prefix /api] [--format table|md|json|csv] [--strict]"
allowed-tools: Bash(node:*)
---

Compare the API spec with the recorded sidecars:

!`node "${CLAUDE_PLUGIN_ROOT}/cli/bin/security-sidecar.js" spec $ARGUMENTS`

Explain each non-`match` row in one line: `mismatch` (the spec and the sidecar disagree on whether authentication is required: decide which is right and fix the other), `not-recorded` (in the spec, no sidecar: classify it), `unclassified` (the sidecar has not decided), `not-in-spec` (recorded, but the spec may be partial). Remind the user that the spec is a document, not proof: it does not test the running app (use `verify`), and YAML specs must be converted to JSON first.
