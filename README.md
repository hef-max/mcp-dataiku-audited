# Audited Dataiku MCP server

This public repository contains the audited Dataiku DSS MCP integration used with Codex. It includes a hardened TypeScript server, the Codex plugin metadata, and the Dataiku operations skill.

## Scope

- Uses the Dataiku DSS REST API over HTTPS.
- Reads `DSS_HOST` and `DSS_API_KEY` from the environment; credentials are never committed.
- Validates the DSS host and rejects embedded credentials, query strings, and fragments.
- Uses a pinned MCP SDK dependency and includes an SBOM and security notes.
- Excludes `node_modules`, build output, caches, and local secrets.

## Build and audit

```powershell
cd server-hardened
npm ci
npm run check
npm run build
npm audit --omit=dev --audit-level=high
```

Set `DSS_HOST` and `DSS_API_KEY` in the host environment before starting the MCP server. Never put real values in `.mcp.json` or source files.

## Upstream

The plugin documentation references [hhobin/dataiku_factory](https://github.com/hhobin/dataiku_factory). This repository is an independently audited/hardened wrapper and is not an official Dataiku product.

## License

MIT. See `server-hardened/LICENSE`.
