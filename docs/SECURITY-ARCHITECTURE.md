# Security architecture guidance

A sidecar records what a route is meant to be, and `check` notices when the code drifts from it. That is not enough to make a system secure. This page describes the architecture that makes the recorded intent hold, and where each sidecar field fits into it.

It is guidance, not a standard, and it does not replace a threat model of your own system. For rules about writing code safely, use Claude Code's `/security-review` and your own scanners. For a deeper catalogue of requirements, see the OWASP Application Security Verification Standard (ASVS) and the OWASP Top 10.

## 1. Principles

1. **Deny by default.** A route nobody classified should be private, not open. Put authentication in one central place (middleware or a gateway) so a forgotten check in a handler becomes a 401, not an open door. Then `public` becomes a short, explicit allowlist. This mirrors the tool's own default: when unsure, treat the route as secured.
2. **Several layers, none trusted alone.** A request should have to pass edge, network, authentication, authorization and data-level controls. Any one of them can be misconfigured or removed.
3. **Authentication is not authorization.** `exposure: authenticated` says a login is required. It does not say which user may see which record. Most serious access-control bugs are the second kind: a logged-in user reading someone else's data.
4. **Separate the planes.** Admin and internal functions should not share the public surface. A hidden URL is noise reduction, not a control.
5. **Least privilege.** Give every service, token and database role only what it needs, so a mistake in one route reaches as little as possible.
6. **Fail closed.** When a check cannot run (a session store is down, a config is missing), refuse the request.

## 2. Where each kind of intent is enforced

| Recorded intent | Enforce it at | Typical `enforcement.via` |
| --- | --- | --- |
| `public` | CDN or edge cache, rate limiting, optionally a WAF. No per-user data in the response. | `waf` (optional) |
| `authenticated` | Central middleware or gateway for the login check, plus authorization in the handler or data layer (role, ownership, tenant). | `app-middleware`, `api-gateway` |
| `internal` | Network: IP allowlist, VPN or mTLS. Service-to-service authentication on top. Webhooks: verify a shared signature. | `ip-allowlist`, `mtls` |
| Admin pages | A separate surface (own host, port or network), SSO with MFA or a strong passphrase, a network restriction, and an audit log. | `ip-allowlist` plus `app-middleware` |

Record only controls that really exist. `enforcement.via` is not verified by the tool, and recording any external control silences `auth-not-found` for that route.

## 3. Patterns that make intent hold

### 3.1 Central authentication with an explicit public list
Mount authentication before routes are registered, and list the public routes explicitly:

- Next.js: a middleware whose matcher covers everything except the listed public paths.
- Express: `app.use(requireAuth)` first, then mount public routers above it on purpose.
- FastAPI: an application-wide dependency, with public routes opting out explicitly.

Keep the public list short and reviewed. It should match the routes your sidecars record as `public`.

### 3.2 Close the loop with a test the tool does not provide
When authentication lives in middleware, the sidecar's `auth-removed` check cannot see the middleware being weakened, because it only reads the route file. Cover that gap with:

- an automated test that calls every route recorded as `authenticated` without credentials and expects 401 or 403, and a different user's credentials for object-level routes and expects 403 or 404;
- code review rules on the middleware, matcher and gateway files (for example `CODEOWNERS`), so changes there get a second reader;
- a check in CI that the set of public routes has not grown unnoticed.

### 3.3 Object-level authorization in one place
Put "may this user touch this record" in a shared policy function or the repository layer, not scattered through handlers. Take the tenant or user id from the session, never from the request body or URL. Where your database supports it, add row-level security as a second line.

### 3.4 Separate the admin and internal planes
- Serve them from a separate host, port or private network where you can.
- Require SSO with MFA, or at least a long passphrase, and restrict by network. Do not rely on an unguessable path.
- Log every administrative action with who, what and when, and send the log somewhere an attacker with the app's credentials cannot edit.
- Keep admin routes out of the sitemap, `robots.txt` and navigation. `check` warns about references, but the real control is underneath.

### 3.5 Secrets and configuration
- Secrets come from the environment or a secret manager, never the repository or a sidecar.
- Use separate secrets per environment, rotate them, and scope tokens narrowly.
- Treat `routes-manifest.json` as sensitive: it lists admin and internal paths.

### 3.6 Outbound traffic and data flow
- Restrict where the server may connect (an egress allowlist at the network level) so a server-side request forgery bug cannot reach internal services or cloud metadata.
- Know where personal data flows and make sure the routes that touch it are the ones you recorded as protected.

### 3.7 Detection and response
- Log authentication failures, authorization denials and admin actions. Do not log secrets or full tokens.
- Alert on unusual patterns, such as a spike in 401/403 responses or an admin login from a new place.
- Decide in advance who gets paged and how a leaked secret is rotated.

## 4. What the sidecar cannot tell you

- Whether a check is correct. `check` sees that an authentication check is present, not that it is right.
- Whether authorization (ownership, role, tenant) is correct. It only looks for authentication.
- Whether the recorded `enforcement.via` control exists or is deployed.
- Routes registered in code instead of by file, and anything outside the web routes it detects.
- Whether the intent itself was the right decision. A route wrongly recorded as `public` is a faithful record of a mistake.

## 5. Review checklist

For each new route:
1. Is it public on purpose? Who decided, and does the sidecar say so?
2. Which layer authenticates it, and which layer authorizes access to the specific record?
3. What happens when authentication or the session store fails?
4. Does it touch personal data or money, and does it need extra controls such as rate limits or audit logging?
5. Is there a test that fails if the protection is removed?

For each release:
1. Has the set of `public` routes changed, and was each addition intended?
2. Did any `policy-downgrade` or `auth-removed` finding appear, and how was it resolved?
3. Are the middleware, gateway and network rules reviewed as carefully as route code?
4. Did you run `/security-review` and your own scanners?
