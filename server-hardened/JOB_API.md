# Dataset and recipe builds through DSS jobs

Authoritative route/payload references are the official Python client checked into this workspace:

- `project/artifacts/fcr010_silver_ldm/dataiku_api_client/dataikuapi/dss/project.py`: `DSSProject.new_job` (line 1561), `JobDefinitionBuilder.__init__` (4067), `with_output` (4091), `start` (4119).
- `project/artifacts/fcr010_silver_ldm/dataiku_api_client/dataikuapi/dss/job.py`: `DSSJob.get_status` (29), `get_log` (39), `DSSJobWaiter.wait` (66).

This installed client uses `DSSJobWaiter.wait()` / builder `start_and_wait()`, rather than a `job.wait_for_completion()` method. It polls `baseStatus.state` until DONE, FAILED or ABORTED. No REST routes were inferred from action names.

The previous dataset/recipe `actions/build` routes return 404 on this DSS; builds are submitted as project jobs. The old job-details URL also omitted a required trailing slash: read-only comparison confirmed 404 without the slash and success with it.

## Contract

`build_dataset`: project_key, dataset_name, mode (NON_RECURSIVE_FORCED_BUILD by default or explicitly RECURSIVE_FORCED_BUILD), wait (false by default), timeout_seconds (integer 1–3600; default 60), dry_run (false by default).

`run_recipe`: same options with recipe_name instead of dataset_name. Resolves the unique output and verifies the requested recipe is its only producer. Refuses missing/ambiguous/multiple/non-dataset outputs, append outputs, cross-project outputs, and partitioned targets. This first implementation intentionally builds one explicit dataset and does not silently broaden scope to other outputs.

Both tools use:

```json
{
  "type": "NON_RECURSIVE_FORCED_BUILD",
  "refreshHiveMetastore": false,
  "autoUpdateSchemaBeforeEachRecipeRun": false,
  "outputs": [{"type":"DATASET","id":"DATASET_NAME","projectKey":"PROJECT_KEY","partition":null}]
}
```

POST `/projects/{project}/jobs/` returns `id`. An ambiguous POST outcome is never retried automatically.

`get_job_status` reads GET `/projects/{project}/jobs/{encodedId}/`; `get_job_details` uses the same endpoint and retains the sanitized native response. `wait_for_job` polls using bounded backoff. `get_job_log` reads GET `/projects/{project}/jobs/{encodedId}/log`, optionally `?activity={encodedActivity}`. Log excerpts are sanitized before truncation (default last 8000 characters, maximum 20000; response body capped at 5 MiB).

```ts
interface BuildResult {
  project_key: string;
  dataset_name: string; // empty for an external multi-output job or unavailable status
  job_id: string;
  state: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ABORTED';
  started_at?: string;
  finished_at?: string;
  outputs: string[];
  error?: { message: string; activity_id?: string; log_excerpt?: string };
  timed_out?: boolean;
  monitoring_error?: unknown;
  dss_state?: string;
}
```

DSS DONE maps to SUCCESS; nonterminal DSS states map to RUNNING. A wait deadline does not fail, abort or restart the job: it returns timed_out with the job ID for subsequent polling. A monitoring failure after submission preserves the ID and last known state. Async returns immediately after successful submission. A dry-run makes GET requests only and returns the exact planned job definition, not a fictitious job ID.

Success means engine execution completed. It does not mean business validation passed or that missing output columns were automatically added. No recipe/config/schema edits are performed by these tools. Existing HTTP error status/body diagnostics and secret redaction are retained; successful job details and logs are sanitized too.

## Authorized FCR_010 integration, 2026-09-27

Exactly one POST was sent, with NON_RECURSIVE_FORCED_BUILD and the single target `silver_alert_investor_evidence_v2`.

- Job ID: `Build_silver_alert_investor_evidence_v2__NP__2026-09-27T04-20-34.158`.
- Status: SUCCESS / DSS DONE, 04:20:34.170–04:20:40.530 UTC.
- One activity: `compute_silver_alert_investor_evidence_v2_NP`, targeting only `FCR_010.silver_alert_investor_evidence_v2`.
- Full TSV export: 275 rows, 236 distinct alert_record_key, time_gap_seconds min 0 / max 60; all range checks passed.
- Four checks did not pass: entity_id nonempty, entity_type INVESTOR, evidence_type ALERT, source_reference equals alert_record_key. The output schema/export lacks those four columns. The recipe defines these computations, but the output schema remains the source's 15-column schema. No schema or recipe modification was attempted under this build-only authorization.
- Hashes of all dataset configurations and all recipe configurations/payloads are unchanged before/after. No object was created/deleted. No other recipe or dataset was built, no recursive build, and no Gold work. Normal DSS job history, target data and runtime timestamps were updated by the authorized build.

Next pipeline step, separately authorized: synchronize the target output schema with the Prepare recipe's derived columns, then repeat the same non-recursive build and all seven data checks. Do not enable recursive builds or schema updates across the project to fix this target.

`scripts/check-job-fcr010.mjs REPORT --submit` is the explicit one-shot integration harness. It persists a checkpoint before submission and rejects a second submission using the same report path. Without `--submit` it resumes read-only monitoring. `scripts/validate-job-output.py REPORT` performs two GET requests and computes aggregates without printing row data.

## Verification and deployment

Run `npm.cmd run check`, `npm.cmd run lint`, and `npm.cmd test` (which invokes `npm run build` / `tsc`). Source is authoritative; do not manually edit dist JavaScript.

Final result: TypeScript check and ESLint passed; 79/79 tests passed, including job dry-run, code/visual producers, output lookup, missing dataset/producer, success/failure/abort, async, timeout (including first-poll timeout), both allowed modes and sanitized HTTP/log handling. No live recursive test was performed.

Changed files in this task: `src/job-service.ts`, `src/dataiku-client.ts`, `src/mcp-server.ts`, `test/jobs.test.mjs`, `test/mcp.test.mjs`, `scripts/check-job-fcr010.mjs`, `scripts/validate-job-output.py`, `JOB_API.md`, `README.md`, and generated dist files. Backup: `project/artifacts/mcp_job_api_backup_20260927.zip`; branch `codex/job-api-build`. Prior uncommitted work was retained.

Canonical repository: `D:\Documents\Kerja\PT All Data International\mcp-dataiku-audited\server-hardened`.
Deployment entry: `C:\Users\HEFRY ANESTI\plugins\dataiku\server-hardened\dist\mcp-server.js`, launched by `C:\nvm4w\nodejs\node.exe`.
Mirror: `D:\Documents\Kerja\PT All Data International\project\plugins\dataiku\server-hardened`.
Reload existing MCP connections to load new tools; fresh stdio processes load the rebuilt code. Do not reinstall from the obsolete uvx marketplace source.
