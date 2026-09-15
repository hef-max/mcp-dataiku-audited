# Hardened Dataiku MCP fork

This directory is an auditable local fork. Read [SECURITY.md](SECURITY.md) for the applied controls and [UPSTREAM.md](UPSTREAM.md) for source provenance.

> The remainder of this document is the upstream README and may describe the original npm package rather than this hardened build.
# Dataiku DSS MCP Server

A comprehensive Model Context Protocol (MCP) server for Dataiku DSS integration. This project provides Claude Code with direct access to Dataiku DSS for managing recipes, datasets, and scenarios.

## 🚀 Quick Start

### Prerequisites

- Node.js 18.0.0+
- Dataiku DSS instance with API access
- Valid DSS API key

### Installation

```bash
# Install globally
npm install -g @zhangzichao2008/mcp-dataiku

# Or use with npx
npx @zhangzichao2008/mcp-dataiku
```

### Configuration

1. Copy environment template:
```bash
cp .env.sample .env
```

2. Configure your DSS connection in `.env`:
```bash
DSS_HOST=https://your-dss-instance.com:10000
DSS_API_KEY=your-api-key-here
DSS_INSECURE_TLS=true  # Only if using self-signed certificates
```

### Claude Code Integration

Register the MCP server with Claude Code:

```bash
claude mcp add dataiku-dss \
    -e DSS_HOST=https://your-dss-instance.com:10000 \
    -e DSS_API_KEY=your-api-key-here \
    -e DSS_INSECURE_TLS=true \
    -- npx @zhangzichao2008/mcp-dataiku
```

## 📚 MCP Tool Catalog

### Core Recipe Management Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `create_recipe` | Create new recipe | `project_key`, `recipe_type`, `recipe_name`, `inputs`, `outputs`, `code` |
| `update_recipe` | Update existing recipe | `project_key`, `recipe_name`, `**kwargs` |
| `delete_recipe` | Delete recipe | `project_key`, `recipe_name` |
| `run_recipe` | Execute recipe | `project_key`, `recipe_name`, `build_mode` |

### Core Dataset Management Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `create_dataset` | Create new dataset | `project_key`, `dataset_name`, `dataset_type`, `params` |
| `update_dataset` | Update dataset settings | `project_key`, `dataset_name`, `**kwargs` |
| `delete_dataset` | Delete dataset | `project_key`, `dataset_name`, `drop_data` |
| `build_dataset` | Build dataset | `project_key`, `dataset_name`, `mode`, `partition` |
| `inspect_dataset_schema` | Get dataset schema | `project_key`, `dataset_name` |
| `check_dataset_metrics` | Get dataset metrics | `project_key`, `dataset_name` |

### Core Scenario Management Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `create_scenario` | Create new scenario | `project_key`, `scenario_name`, `scenario_type`, `definition` |
| `update_scenario` | Update scenario settings | `project_key`, `scenario_id`, `**kwargs` |
| `delete_scenario` | Delete scenario | `project_key`, `scenario_id` |
| `run_scenario` | Execute scenario | `project_key`, `scenario_id` |

### 🔧 Advanced Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_scenario_logs` | Get detailed run logs and error messages | `project_key`, `scenario_id`, `run_id` |
| `get_recipe_code` | Extract actual Python/SQL code from recipes | `project_key`, `recipe_name` |
| `get_project_flow` | Get complete data flow/pipeline structure | `project_key` |
| `get_dataset_sample` | Get sample data from datasets | `project_key`, `dataset_name`, `rows`, `columns` |
| `get_recent_runs` | Get recent run history across scenarios/recipes | `project_key`, `limit`, `status_filter` |
| `list_projects` | List all available Dataiku projects | - |

### Additional Dataset Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_datasets` | List all datasets in a project | `project_key`, `dataset_type` (optional) |
| `get_dataset_info` | Get detailed information about a dataset | `project_key`, `dataset_name` |
| `clear_dataset` | Clear data from a dataset | `project_key`, `dataset_name`, `partition` (optional) |

### Additional Recipe Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_recipes` | List all recipes in a project | `project_key`, `recipe_type` (optional) |
| `get_recipe_info` | Get detailed information about a recipe | `project_key`, `recipe_name` |
| `validate_recipe_syntax` | Validate Python/SQL syntax of a recipe | `project_key`, `recipe_name`, `code` (optional) |
| `test_recipe_dry_run` | Test recipe logic without actual execution | `project_key`, `recipe_name`, `sample_rows` |

### Additional Scenario Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_scenarios` | List all scenarios in a project | `project_key`, `scenario_type`, `active_only` |
| `get_scenario_info` | Get detailed information about a scenario | `project_key`, `scenario_id` |
| `add_scenario_trigger` | Add a trigger to a scenario | `project_key`, `scenario_id`, `trigger_type`, trigger params |
| `remove_scenario_trigger` | Remove a trigger from a scenario | `project_key`, `scenario_id`, `trigger_idx` |
| `get_scenario_run_history` | Get run history for a scenario | `project_key`, `scenario_id`, `limit` |
| `get_scenario_steps` | Get step configuration including Python code | `project_key`, `scenario_id` |
| `clone_scenario` | Clone an existing scenario with modifications | `project_key`, `source_scenario_id`, `new_scenario_name`, `modifications` |

### Advanced Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search_project_objects` | Search for datasets, recipes, scenarios by name/pattern | `project_key`, `search_term`, `object_types` |
| `get_code_environments` | List available Python/R environments | `project_key` (optional) |
| `get_project_variables` | Get project-level variables and configuration | `project_key` |
| `get_connections` | List available data connections | `project_key` (optional) |
| `get_job_details` | Get detailed job execution information | `project_key`, `job_id` |
| `cancel_running_jobs` | Cancel running jobs/scenarios | `project_key`, `job_ids` |
| `batch_update_objects` | Update multiple objects with similar changes | `project_key`, `object_type`, `pattern`, `updates` |
| `get_project_flow` | Get complete data flow/pipeline structure | `project_key` |
| `export_project_config` | Export project configuration as JSON/YAML | `project_key`, `format` |
| `duplicate_project_structure` | Copy project structure to new project | `source_project_key`, `target_project_key`, `include_data` |

**Total: 46 Tools**

## 🔧 Usage Examples

### Core Operations

#### Creating a Python Recipe

```json
{
  "project_key": "ANALYTICS_PROJECT",
  "recipe_type": "python",
  "recipe_name": "data_cleaner",
  "inputs": ["raw_data"],
  "outputs": [{"name": "clean_data", "new": true, "connection": "filesystem_managed"}],
  "code": "import pandas as pd\ndf = dataiku.Dataset(\"raw_data\").get_dataframe()\ndf_clean = df.dropna()\ndataiku.Dataset(\"clean_data\").write_with_schema(df_clean)"
}
```

#### Building a Dataset

```json
{
  "project_key": "BI",
  "dataset_name": "user_analytics",
  "mode": "RECURSIVE_BUILD"
}
```

#### Getting Dataset Sample

```json
{
  "project_key": "FINANCE_PROJECT",
  "dataset_name": "transactions",
  "rows": 500,
  "columns": ["customer_id", "amount"]
}
```

#### Getting Scenario Logs

```json
{
  "project_key": "ANALYTICS_PROJECT",
  "scenario_id": "data_processing"
}
```

#### Exploring Project Structure

```json
{
  "project_key": "SALES_ANALYTICS"
}
```

## 🏗️ Architecture

```
mcp-dataiku/
├── src/
│   ├── dataiku-client.ts   # Dataiku API client
│   └── mcp-server.ts       # MCP server implementation
├── package.json
├── tsconfig.json
├── .env.sample
└── README.md
```

## 🔒 Security

- **API Key Protection**: Store API keys in environment variables, never in code
- **SSL Configuration**: Support for self-signed certificates with `DSS_INSECURE_TLS=true`
- **Permission Validation**: All operations respect DSS user permissions
- **Error Handling**: Sensitive information is not exposed in error messages

## 📈 Monitoring

The MCP server provides logging for monitoring:

```bash
# Check logs for debugging
tail -f dataiku_mcp.log
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Development Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run basic validation tests (no actual API calls)
npm test

# Run comprehensive tests (requires Dataiku DSS)
node test-comprehensive.js

# Clean build artifacts
npm run clean

# Publish new version (patch version)
npm run publish:patch
```

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🔗 Links

- [GitHub Repository](https://github.com/steven0lisa/mcp-dataiku)
- [npm Package](https://www.npmjs.com/package/@zhangzichao2008/mcp-dataiku)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Claude Code](https://claude.ai/code)
- [Dataiku DSS](https://www.dataiku.com/)

## 📞 Support

If you encounter any issues or have questions, please [open an issue](https://github.com/steven0lisa/mcp-dataiku/issues) on GitHub.

---

**Ready to enhance your Dataiku workflows with AI assistance!** 🚀
