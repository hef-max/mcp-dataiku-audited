---
name: dataiku-operations
description: Use Dataiku DSS MCP tools to explore projects, inspect flows and datasets, develop or run recipes, manage scenarios, and diagnose jobs. Trigger for Dataiku, DSS, projects, recipes, datasets, scenarios, jobs, flows, or Dataiku automation.
---

# Dataiku DSS Operations

Use the `dataiku_factory` MCP server. Before the first operation, confirm it is available. If unavailable, explain that `uv`, Python 3.11+, `DSS_HOST`, and `DSS_API_KEY` are required. Never print or repeat `DSS_API_KEY`. Use `DSS_INSECURE_TLS=true` only for a trusted self-signed endpoint.

Start read-only unless the user clearly requests a mutation. Discover the project and object first; inspect flow, configuration, schema, or recent runs before changes. Preserve identifiers exactly. Read recipe code before updating it and validate changed Python or SQL before running when possible. Inspect dataset dependencies before builds or schema-changing operations. For failures, inspect recent runs, logs, steps, and job details before diagnosing.

Ask for confirmation immediately before destructive or broad operations unless the current request already names the exact action and targets. This includes deleting objects, clearing data, cancelling multiple jobs, batch updates, duplicating projects with data, and changing production schedules. Redact secret-like project variables and connection details.

After mutations, report the project, affected objects, operation, and returned status.

The related TypeScript server at `steven0lisa/mcp-dataiku` offers additional list/info helpers and can run with `npx -y @zhangzichao2008/mcp-dataiku`. Do not activate both implementations by default because overlapping tool names cause ambiguity. Switch only on explicit request or if the Python server lacks a required operation.
