# Dataiku Codex plugin

This plugin connects Codex to Dataiku DSS using [hhobin/dataiku_factory](https://github.com/hhobin/dataiku_factory).

Requirements: Dataiku DSS API access, Python 3.11+, `uv`, and the `DSS_HOST` and `DSS_API_KEY` environment variables available to Codex. `DSS_INSECURE_TLS=true` is optional and should be used only for a trusted self-signed certificate. Restart Codex after setting variables. On first use, `uvx` downloads and caches the upstream server.

Dataiku Factory is active (Python, 34 documented tools). [steven0lisa/mcp-dataiku](https://github.com/steven0lisa/mcp-dataiku) documents 46 tools and an `npx` entry point, but remains an explicit fallback to avoid duplicate tool names.

The plugin stores no DSS credentials; it passes only the named variables inherited from Codex.
