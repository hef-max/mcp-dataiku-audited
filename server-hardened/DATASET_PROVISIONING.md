# Managed dataset provisioning

Implemented in TypeScript; compile with `npm run build`. No manual `dist` edits.

## Tool schema

The strict Zod contract in `src/dataset-config.ts` generates the MCP JSON Schema and validates requests. Unknown fields, including the former arbitrary `params`, are rejected.

```ts
interface CreateDatasetRequest {
  project_key: string;
  dataset_name: string;
  dataset_type?: 'Filesystem' | 'S3';
  managed?: boolean; // only true is supported; defaults true
  connection?: string;
  path?: string; // required by preflight, including clones
  bucket?: string; // required for S3, forbidden for Filesystem
  format_type?: string;
  format_params?: Record<string, unknown>;
  schema?: { columns: { name: string; type: string; meaning?: string }[] };
  clone_settings_from?: string; // same project
  dry_run?: boolean; // default false
}
type RecipeOutput = {name: string; new?: boolean}
  & Omit<CreateDatasetRequest, 'project_key' | 'dataset_name' | 'dry_run'>;
```

Schema types: string, boolean, tinyint, smallint, int, bigint, float, double, date, dateonly, datetimenotz, array, map, object. Duplicate columns are rejected. Without a supplied schema, clone uses the source schema; explicit storage creation uses an empty schema until configured. Complex nested schema descriptors are outside this minimal contract.

`create_recipe.outputs` accepts `{name}` for existing, unowned output datasets, or `{name,new:true,clone_settings_from,path,schema}` for new outputs. Explicit storage settings also work with `new:true`. The same schema/preflight/service is shared with `create_dataset`. All output plans and recipe config are checked before any writes. Every output is provisioned before the recipe POST. Explicit requested output schemas are then reapplied and verified after saving recipe configuration; see [SCHEMA_SYNC.md](SCHEMA_SYNC.md). `update_recipe` does not provision outputs.

## DSS request and clone behavior

POST `/projects/FCR_010/datasets/` uses this root structure (formatParams shown abbreviated):

```json
{
  "projectKey": "FCR_010",
  "name": "silver_alert_investor_evidence_v2",
  "type": "S3",
  "managed": true,
  "params": {
    "connection": "dataiku-managed-storage",
    "bucket": "idx-catalyst",
    "path": "/dataiku/dataikusilver_alert_investor_evidence_v2",
    "notReadyIfEmpty": false
  },
  "formatType": "csv",
  "formatParams": {"compress": "gz", "separator": "\t"},
  "schema": {"columns": [
    {"name":"entity_type","type":"string"},
    {"name":"entity_id","type":"string"},
    {"name":"security_code","type":"string"},
    {"name":"evidence_date","type":"dateonly"},
    {"name":"evidence_type","type":"string"},
    {"name":"evidence_value","type":"string"},
    {"name":"group_id","type":"string"},
    {"name":"source_reference","type":"string"}
  ]}
}
```

Clone preserves the full source format parameters, partitioning and readWriteOptions. Partitioning/read-write settings are applied with GET/PUT after creation when necessary, preserving DSS-generated fields. A final GET verifies requested settings. Creation supports a 204/no-body response. It never reads/copies source data.

The new name and explicit path replace source identity. Source creation/version tags, tags, metrics/history, ownership, metastore table identity, explicit file selectors, variable expansion and credentials are not copied. An explicit schema replaces the old schema. Changing clone storage type is rejected. Referenced connections must appear in `/connections/get-names?type=all`; storage permissions and connector-specific format compatibility remain DSS validations at creation time.

The old implementation sent only name/type/params and discarded DSS error bodies. That omitted managed/format/schema fields required by this storage workflow. **The exact historical HTTP 400 cause is unknown** because its response body was not retained. No live POST was attempted merely to reproduce the error.

HTTP errors now contain status, method, endpoint, sanitized JSON/text response body and extracted DSS type/message. Response headers are never included. Known API key variants, credential keys, authorization values and common text credential assignments are redacted. Error bodies over 64 KiB are omitted; success responses are bounded at 5 MiB.

## Safety and limitations

- `dry_run:true` performs GET only and returns `creation_request`, `post_create_settings`, validation scope and `writes:0`.
- Project/input/source/connection existence, dataset names, explicit literal paths and storage overlaps are checked. All visible project inventories are inspected; unreadable inventories fail preflight. Equal, ancestor and descendant paths conflict. Connection aliases are conservatively treated as potentially identical storage. Hidden projects and unregistered physical objects cannot be checked with this API identity.
- Preflight is repeated immediately before dataset POST. DSS has no transactional storage reservation or conditional delete here: concurrent external writers remain a limitation. Serialize provisioning for a given project/storage prefix and inspect DSS after ambiguous network outcomes.
- On failure, only confirmed successful POST receipts can be considered for rollback. Checks require matching creation identity/storage, no visible recipe producer or consumer, no partition dimensions, an unsampled empty data response and unchanged version through recheck. Missing permissions, missing storage/read failures, nonempty data, owners or uncertain identities retain the dataset and return a rollback report.
- Cleanup uses `dropData=false`, deleting metadata only. Existing datasets and unconfirmed POST outcomes are never deleted. Recipe creation/configuration failure never triggers recipe deletion; if the new recipe owns outputs, cleanup retains them. Physical storage is never removed.
- There are no automatic builds, recipe runs or existing schema mutations. Window/Distinct support remains template-based as described in VISUAL_RECIPES.md.

## Validation and deployment

```powershell
npm.cmd run check
npm.cmd run lint
npm.cmd test
npm.cmd run build
node scripts/check-dataset-readonly.mjs
```

The live script uses both a read-only HTTP client and a fetch guard rejecting all non-GET methods. On 2026-09-27, the FCR_010 dry-run passed with 87 GET requests, zero writes, target absent, and identical dataset/recipe inventory hashes before and after. This verifies planning against live configuration; real creation and storage write permissions remain untested.

Final validation: TypeScript check passed, ESLint passed, and all 56 tests passed. `npm test` invokes `npm run build` (`tsc`) before the suite. A fresh stdio MCP process launched from the deployment directory also passed schema discovery/validation. Existing long-lived plugin processes still need reload to load the updated JavaScript and tool schemas.

Canonical source: `D:\Documents\Kerja\PT All Data International\mcp-dataiku-audited\server-hardened\src`.
Mirror: `D:\Documents\Kerja\PT All Data International\project\plugins\dataiku\server-hardened`.
Active deployment: `C:\Users\HEFRY ANESTI\plugins\dataiku\server-hardened`.
The plugin launches `C:\nvm4w\nodejs\node.exe` with `C:\Users\HEFRY ANESTI\plugins\dataiku\server-hardened\dist\mcp-server.js`.

Backup before edits: `D:\Documents\Kerja\PT All Data International\project\artifacts\mcp_dataset_provisioning_backup_20260927.zip`; branch `codex/dataset-provisioning`, preserving prior uncommitted work. Do not reinstall from the obsolete uvx marketplace source. Reload the plugin connection or restart Codex to refresh tool schemas in already-running chats; a fresh stdio client can verify the compiled tool schema without modifying DSS.

References: [DSS REST API](https://doc.dataiku.com/dss/api/latest/rest/), [official Python client API](https://developer.dataiku.com/latest/api-reference/python/client.html).
