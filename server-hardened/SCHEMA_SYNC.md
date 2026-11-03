# Explicit output schema application

## Cause and fix

Previously `create_recipe` provisioned and verified the dataset schema, then created the recipe and saved its configuration, but never verified/reapplied output schema after those operations. It could return `schema_applied:true` based only on provisioning, even if DSS initialized an output schema from the input. This ordering gap is confirmed in the old source; the exact historical DSS reset was not captured. A regression fixture now simulates the reset and verifies the final ordering.

For `new:true` outputs with an explicit `schema`, the order is now: validate all requests, provision outputs, create recipe, save typed configuration, apply requested output schemas, read back and verify, then return success. No automatic build occurs. Existing outputs are not modified automatically, and inferred clone schemas without an explicit requested schema do not claim final schema application. Errors after recipe creation retain the recipe and owned outputs; guarded provisioning cleanup will not delete them.

## Tool contract

```ts
interface UpdateDatasetRequest {
  project_key: string;
  dataset_name: string;
  schema?: { columns: Array<{
    name: string;
    type: 'string' | 'boolean' | 'tinyint' | 'smallint' | 'int' | 'bigint'
      | 'float' | 'double' | 'date' | 'dateonly' | 'datetimenotz' | 'array' | 'map' | 'object';
    meaning?: string;
  }> };
  dry_run?: boolean;
}
```

`update_dataset` accepts this strict contract. No supplied schema is a GET-only no-op. `apply_dataset_schema` uses the same contract but requires schema. Legacy arbitrary full-settings updates are rejected rather than silently ignored. Empty schemas, duplicate names, unknown fields and invalid types are rejected locally.

Both tools read current dataset settings and preserve schema-level metadata while replacing the columns. They return schema_before/schema_after, added/removed/changed/order_changed diff, writes, verified, executed:false, and data_deleted:false. `dry_run:true` performs GET only. Matching schemas are idempotent no-ops. Type/name/order and explicitly supplied meaning values are verified; DSS-added column metadata is allowed.

The write is the official `DSSDataset.set_schema` endpoint: **PUT `/projects/{project}/datasets/{dataset}/schema`**. Reference: `project/artifacts/fcr010_silver_ldm/dataiku_api_client/dataikuapi/dss/dataset.py`, lines 250–259. No full dataset settings are PUT, so storage fields, recipe, metrics or user metadata are not sent as updates. Settings are rechecked before PUT to detect concurrent changes, then schema is verified using both schema and settings GET endpoints.

Protected settings include all fields other than schema and DSS bookkeeping (`versionTag`, `typeSystemVersion`, derived `smartName`). Post-update differences in protected fields cause a diagnostic naming the keys. There is no atomic compare-and-swap in this client path; concurrent changes can still race. Failed or ambiguous PUT/read-back never triggers destructive rollback or a blind restoration of an old schema. Diagnostics include the previous/requested schema and PUT confirmation; inspect current DSS state before retrying. No DELETE, recipe update, data deletion or job submission occurs in this service.

## Tests and files

Type-check, ESLint and all 91 tests passed. Tests cover dry-run, storage/metadata preservation, duplicate/invalid columns, read-back mismatch, no-op, concurrent edits, no data/producer writes, and a simulated DSS schema reset during Prepare recipe creation. A final schema failure retains the created recipe and its owned output. `npm.cmd test` compiles via `npm run build` / `tsc`; dist is generated only.

Source changed: `src/dataset-config.ts`, new `src/schema-service.ts`, `src/dataiku-client.ts`, `src/recipe-service.ts`, `src/mcp-server.ts`. Tests: new `test/schema.test.mjs`, plus datasets/recipes/mcp tests. New integration script: `scripts/check-schema-fcr010.mjs`. Documentation: this file and README. Existing source changes were retained on branch `codex/output-schema-sync`; backup is `project/artifacts/mcp_schema_sync_backup_20260927.zip`.

Canonical: `D:\Documents\Kerja\PT All Data International\mcp-dataiku-audited\server-hardened`.
Mirror: `D:\Documents\Kerja\PT All Data International\project\plugins\dataiku\server-hardened`.
Deployment: `C:\Users\HEFRY ANESTI\plugins\dataiku\server-hardened\dist\mcp-server.js` (Node.js). Existing sessions require reload to discover `apply_dataset_schema`; fresh deployment processes were tested.

## Authorized FCR_010 result — 2026-09-27

The live preflight differed from the earlier 15-column snapshot: it already had 22 columns, but entity_id and evidence_value were double, and the order differed from the explicitly requested schema. Dry-run performed zero writes and reported those two type changes and the reordered columns. No assumption was made that the earlier snapshot was still current.

Exactly one schema PUT applied the requested 22 columns, followed later by exactly one NON_RECURSIVE_FORCED_BUILD job. First schema PUT/read-back succeeded, but the initial overly broad metadata comparison raised a diagnostic and correctly prevented job submission. That initial check did not retain per-field before values, so the exact metadata field difference cannot be established retrospectively; it must not be presented as proven harmless. The comparator now distinguishes schema bookkeeping and names protected field differences. A GET-only resume confirmed the exact requested schema and submitted the authorized build without repeating PUT. All other dataset/recipe configuration fingerprints match the original preflight; this does not retrospectively prove every non-schema field on the target was identical across the initial PUT.

Job: `Build_silver_alert_investor_evidence_v2__NP__2026-09-27T04-46-16.663`.
Status: SUCCESS / DSS DONE. One activity for `compute_silver_alert_investor_evidence_v2`, one target dataset. Schema read-back before and after rebuild: 22 columns with the requested names, order and types.

Full unsampled TSV export passed all checks:

- 275 rows.
- 236 distinct alert_record_key.
- entity_id present and nonempty for every row.
- entity_type = INVESTOR for every row.
- evidence_type = ALERT for every row.
- source_reference = alert_record_key for every row.
- time_gap_seconds in [0,60], observed min 0 and max 60.
- group_id is permitted to be empty.

No other object was created/deleted/modified by these requests; no recipe was edited. All other configuration fingerprints are identical. No recursive build, no Gold work, no DELETE or data-clearing request. The authorized rebuild rewrote target output data and DSS updated job/runtime history as expected.

Evidence under `project/artifacts`: `schema_sync_live_20260927.json`, `schema_sync_validation_20260927.json`, `schema_sync_tests_20260927.txt`, and the deployment hash manifest. The integration harness uses a write allowlist, an intent checkpoint before mutation, and separate schema verification before any job POST. Its explicit recovery mode allows no second schema PUT and rejects an already-attempted job submission.
