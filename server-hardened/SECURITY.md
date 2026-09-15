# Security baseline

This fork focuses on source, artifact, and dependency hardening. Tool-level authorization and enterprise deployment are intentionally out of scope for this phase.

## Controls applied

- Pinned `@modelcontextprotocol/sdk` to `1.30.0`.
- Removed Axios and dotenv.
- Uses the Node.js native `fetch` implementation.
- Requires HTTPS for `DSS_HOST`.
- Rejects insecure TLS mode, redirects, credentials in URLs, query strings, and fragments.
- Applies a 30 second request timeout.
- Limits API responses to 5 MiB.
- Returns sanitized transport and HTTP errors.
- Pins all direct dependencies and commits a lockfile.
- Disables npm lifecycle scripts through `.npmrc`.
- Uses only `https://registry.npmjs.org/`.

## Verification performed

- TypeScript typecheck: passed.
- Production build: passed.
- MCP initialize handshake: passed, protocol 2025-11-25.
- Tool discovery: passed, 44 tools.
- Read-only Dataiku `list_projects`: passed.
- Production npm audit: 0 known vulnerabilities.
- Registry signatures: 97 of 97 packages verified.
- Lockfile registry check: passed.
- Static scan found no Axios, dotenv, home-directory env loading, telemetry, analytics, or application-level command execution.

## Reproduce

```powershell
npm ci
npm run check
npm run build
npm audit --omit=dev --audit-level=high
npm audit signatures
```

Do not use `npx` or install dependencies at runtime. Build from the committed lockfile.
