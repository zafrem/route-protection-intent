# route-protection-intent Playbook

Practical steps for using route-protection-intent. For how it works inside see [ARCHITECTURE.md](ARCHITECTURE.md).

> **A sidecar records intent. It blocks nothing.** Annotate mode never protects a route by itself.

## 1. Set up

1. Install the plugin in Claude Code:
   ```
   /plugin marketplace add zafrem/route-protection-intent
   /plugin install route-protection-intent --marketplace zafrem/route-protection-intent
   ```
2. Optional, in the project root, `.route-protection-intent.config.json`:
   ```json
   {
     "adminPaths": ["/ops-k7Qx92mVbT4nLw", "/backoffice-*"],
     "include": ["**/handlers/**"],
     "exclude": ["**/legacy/**"],
     "quiet": false,
     "authPatterns": ["requireTenantUser\\("]
   }
   ```
   - `adminPaths`: route prefixes treated like `/admin` (`*` matches within one segment).
   - `include` / `exclude`: extra or removed route-file globs.
   - `authPatterns`: extra regular expressions (strings, up to 200 characters) that count as an authentication check, for helpers the built-in list does not know.
   - `quiet`: `true` stops Claude mentioning successful sidecar saves. Questions, refusals, findings and security warnings still appear.
3. Commit the `.route.json` files with the code. Never put them in `public/` or `static/`.

## 2. Everyday flow

1. You or the agent add or edit a route.
2. The plugin classifies it. **Clear cases are saved silently.** Unclear ones ask you to choose secured, public, or leave unclassified.
3. Review the new `.route.json` in the diff like any other file.
4. Run `/route-protection-intent:check` before you merge.

## 3. Scenarios

### A. New public page (SEO)
1. Add the page, for example `app/blog/page.tsx`.
2. Expect a silent save: `public`, `indexing: index`.
3. Follow the guidance: static generation or caching, page metadata, add to the sitemap, no per-user data.

### B. New API or account route
1. Add it, for example `app/api/orders/route.ts`.
2. Expect `authenticated`, `no-store`.
3. Follow the guidance: check the session inside the handler (not only middleware), check role or ownership, rate limit, CSRF for cookie sessions. Keep that check: `check --base` flags a pull request that removes it.
4. For input validation and other secure-coding rules, use Claude Code's `/security-review` and your own linters; this tool does not cover them.

### C. A route the tool is unsure about
1. You are asked. Pick **Secured** unless the page is meant for search engines.
2. Your choice is saved with `reason.source: user` and is never overwritten by later heuristic saves.
3. Choose "Leave unclassified" only temporarily. `check` will keep warning.

### D. Admin page
1. If the path is not `/admin`, add it to `adminPaths` first.
2. Create the route. You are asked for the extra gate:
   - SSO or MFA (best),
   - a passphrase of 8 or more characters (16+ recommended),
   - or none (not recommended).
3. Implement it: the passphrase comes from an environment variable or secret store, is compared in constant time, is rate limited with lockout, and is never committed. Visitors who fail the gate should get the same 404 as an unknown URL.
4. Restrict by network as well (IP allowlist, VPN or mTLS) and record it:
   ```json
   "enforcement": { "via": ["ip-allowlist"] }
   ```
5. Do **not** link to the page from nav, footer, sitemap or `robots.txt`. The plugin warns if anything does.
6. Run `check`. A clean admin route has no `admin-no-gate`, `admin-no-network-restriction` or `admin-path-exposed` finding.

### E. Allowing a link to an admin page on purpose
1. Ask for the link. The plugin asks you to confirm, because the link reveals the hidden URL to every visitor.
2. If you confirm, it saves `"linkable": true` with `reason.source: user`.
3. To undo: remove the link and delete `linkable` from the sidecar.

### F. Renamed or deleted route
1. Move the sidecar with the route (`git mv`), and update its `route` field.
2. A deleted route leaves an `orphan` finding. Delete the sidecar.

### G. Turning on enforcement (optional: Nginx, Next.js, Cloudflare)
1. Classify everything first. `compile` refuses `unclassified` in enforce sidecars.
2. Set `"mode": "enforce"` and `enforcement.via` (`api-gateway` or `ip-allowlist` for Nginx; `app-middleware` or `api-gateway` for Next.js; `waf`, `ip-allowlist` or `api-gateway` for Cloudflare) on the sidecars you want compiled.
3. Run `/route-protection-intent:compile <nginx|nextjs|cloudflare>`. Review the generated config (`route-protection-intent.nginx.conf`, `route-protection-intent.nextjs.js`, or `route-protection-intent._headers`) before use; where methods differ, the strictest applies to the path.
4. Add `routes-manifest.json` and the generated config to `.gitignore` and to your deploy exclusions. The manifest lists admin paths.

## 4a. Audit: the route inventory

`/route-protection-intent:report` (or `route-protection-intent report .`) lists every route and method with its recorded protection:

```
ROUTE       METHOD  EXPOSURE       GATE  VIA  DECIDED BY  AUTH CHECK  GAPS
/api/login  POST    authenticated  -     -    heuristic   no          -
/products   GET     public         -     -    heuristic   no          -
/reports    GET     (none)         -     -    -           n/a         no-sidecar
```

- **Decided by:** `user` means a person confirmed it. `heuristic` or `agent` means it was only guessed, so review those first.
- **Auth check:** whether the route code shows an authentication check (a text match for common patterns). It is not proof, and it is the same for every method of a route.
- **Gaps:** `no-sidecar`, `unclassified`, `orphan`, `schema`, `protected-no-auth-check` (recorded as protected, no check visible) and `public-with-auth-check` (recorded as public, but the code checks authentication: is it really public?).
- **Audit trail:** commit the output (`route-protection-intent report . --format md > docs/route-inventory.md`). Rows are sorted and have no timestamps, so a pull request's diff shows exactly which route changed exposure.
- **Formats:** `--format table|md|json|csv`. `--strict` exits 1 when any gap exists.
- **Limit:** this is static. It does not contact the running app. To test that a protected route really refuses anonymous callers, use `verify` (next section).

## 4b. Verify a running app

`/route-protection-intent:verify --base-url http://localhost:3000` (or `route-protection-intent verify . --base-url ...`) sends requests without credentials and compares the answers with the recorded intent.

1. Start the app locally or use a staging environment you own. Non-local addresses are refused unless you pass `--allow-remote`.
2. Run it. Read the RESULT column: `pass` (as recorded), `gap` (an anonymous request was treated differently than recorded, most importantly a protected route answering 2xx), `inconclusive` (404, 5xx or no response: fix the URL or the server and run again) and `skipped`.
3. Routes with parameters need sample values in `.route-protection-intent.config.json`: `{ "verify": { "samples": { "id": "42" } } }`. Use values that exist in the test data, otherwise you get 404s.
4. Only GET, HEAD and OPTIONS are sent. `--include-mutating` also sends POST, PUT, PATCH and DELETE with no body; use it only on a test system, because a route that is wrongly open could act on the request.
5. No cookies or tokens are ever sent. A protected route that answers 400 or 422 is `inconclusive`: it was rejected before any authentication decision, which is itself worth checking.
6. `--strict` fails on `inconclusive` as well; `--format md|json|csv` and `--delay <ms>` are available. In CI, start the app, run `verify` against it, and keep it separate from the pull-request check.
7. It proves that anonymous callers are refused. It does not prove that user A cannot read user B's data; test that with accounts in your own test suite.

## 4c. Compare with an OpenAPI spec

`/route-protection-intent:spec openapi.json` (or `route-protection-intent spec openapi.json .`) compares each operation's `security` with the sidecars.

1. Export your spec as JSON (YAML is not read).
2. Run it. Rows: `match`, `mismatch` (the two disagree on whether authentication is required), `not-recorded`, `unclassified`, `not-in-spec`. An operation with `security: []` or an empty alternative `{}` counts as public.
3. Decide for each mismatch which side is wrong and fix it: the spec is often the incomplete one.
4. `--prefix /api` sets the base path when `servers` does not give it. `--strict` also fails on unrecorded and unclassified routes. Exit 1 on a mismatch.
5. It reads documents only. It does not prove the running app behaves that way; use `verify` for that.

## 4d. Languages and frameworks

Next.js, SvelteKit and Nuxt are found by file path. For Express, NestJS, Flask, FastAPI, Django, Go routers, Spring, JAX-RS, Ktor, ASP.NET, Rails, Laravel, Symfony, Phoenix, Vapor, actix, axum, Rocket and shelf_router the tool reads the route strings in the code, and one sidecar lists many endpoints under keys like `"GET /api/orders"`. Notes:

- Only Next.js is tested end to end; the rest were checked against small snippets. Treat results as a starting point and review the `report`.
- Paths are taken as written. A router mount prefix is not known, so `verify` may report `inconclusive` for those.
- When routing and authentication are in different files (Rails, Django, Phoenix), record `enforcement.via` so `auth-not-found` does not fire, or add your helper to `authPatterns`.

## 4. Checking and CI

Exit codes for `check`: **0** in annotate mode (warnings only), **1** with `--strict` or for violations in `enforce` sidecars.

Local or CI (from a checkout; the CLI needs only Node 18+):
```bash
node plugins/route-protection-intent/cli/bin/route-protection-intent.js check . --strict
node plugins/route-protection-intent/cli/bin/route-protection-intent.js check . --strict --base origin/main  # also flag policy downgrades
node plugins/route-protection-intent/cli/bin/route-protection-intent.js check . --json   # machine-readable
```

Git pre-commit hook (`.git/hooks/pre-commit`, make it executable):
```bash
#!/bin/sh
node plugins/route-protection-intent/cli/bin/route-protection-intent.js check . --strict || exit 1
```

GitHub Actions on pull requests: copy `examples/github-action/route-protection-intent.yml` into your own project. It checks out full history, clones route-protection-intent at the release in `ROUTE_PROTECTION_INTENT_REF` (`v0.1.3`), and runs
```bash
node "$RUNNER_TEMP/route-protection-intent/bin/route-protection-intent.js" check . --base "origin/$BASE_BRANCH" --format github --strict
```
so each finding shows as an annotation on the changed file (`auth-removed` and `policy-downgrade` as errors, the rest as warnings). Move the pin to a newer tag on purpose; a tag can in principle be moved, so use a full commit hash for the strictest setting. If the app is in a subfolder, replace `.` with that folder.

`--base` needs the base commit available locally. A shallow clone (`fetch-depth: 1`) or a mistyped ref cannot compare, so `check` reports `base-unresolved` and exits 1 instead of passing without a comparison. Keep `fetch-depth: 0`.

## 5. Finding reference

| Finding | Fix |
| --- | --- |
| `missing` | Edit the route to retrigger the plugin, or run `analyze` then `save` |
| `orphan` | Delete or move the sidecar to match the route |
| `schema` | Fix the JSON; unknown fields are not allowed |
| `unclassified` | Choose secured or public and re-save |
| `static-served` | Move the sidecar out of `public/` or `static/` |
| `admin-no-network-restriction` | Add an IP allowlist, VPN or mTLS, then record it in `enforcement.via` |
| `admin-no-gate` | Add SSO/MFA or a passphrase gate and record it in `gate` |
| `admin-path-exposed` | Remove the link, sitemap or `robots.txt` entry, or approve it as in scenario E |
| `auth-removed` | Restore the authentication check, or change the sidecar on purpose (and review that change) |
| `auth-not-found` | Add the check in the route, or, if middleware or a gateway does it, record that in `enforcement.via` |
| `base-unresolved` | The `--base` ref is invalid or not available. Fetch full history (`fetch-depth: 0`) or fix the ref name |
| `policy-downgrade` | Confirm the weaker policy is intended; otherwise restore the previous sidecar value |
| `intent-code-mismatch` | Align the route's caching or `robots` metadata with the sidecar, or update the sidecar |
| `linkable-not-approved` | Confirm with the owner, then re-save with `reason.source: user`, or remove `linkable` |
| `intent-code-mismatch` | Remove `force-static` / `revalidate` on `no-store` routes, or align `robots` metadata with the sidecar's `indexing` |
| `policy-downgrade` | Restore the previous exposure, `gate`, `rateLimit`, `mode` or network restriction, or get explicit review approval |

`save` exits 2 on a schema error, a secret-like value, a sidecar name that is not allowed, or an unapproved `linkable`. Nothing is written in that case.

## 6. Rules of thumb

- The sidecar is one layer. For the architecture that makes the recorded intent hold (central authentication, object-level authorization, separate admin plane, a test that fails when protection is removed), read [SECURITY-ARCHITECTURE.md](SECURITY-ARCHITECTURE.md).
- When unsure, secure it. Wrongly public costs more than wrongly secured.
- Hide admin URLs for noise reduction only. The real controls are the network restriction, the gate and server-side role checks.
- Never put passwords, keys, tokens or connection strings in a sidecar, including `notes`. `save` will refuse them.
- Let the tool write sidecars. Hand edits are fine for `notes` and a method's `note`, but not for `linkable`.
- Use a method's `note` to say why it is set that way ("creates an order, needs a session"). `check` prints it next to any finding for that route, so a reviewer sees the intent without opening the sidecar.
- Review sidecar changes in pull requests. A change from `authenticated` to `public` deserves a second pair of eyes; consider CODEOWNERS for `*.route.json`.

## 7. Maintaining the tool itself

```bash
npm test           # unit, hook and bundle-freshness tests
npm run bundle     # after changing src/ or schema/, copy into the plugin; commit the result
claude plugin validate plugins/route-protection-intent   # CI runs this and `claude plugin validate .` with a pinned Claude Code version
claude plugin validate .
```
