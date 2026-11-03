# Join creation and partial-recipe recovery

## Confirmed cause

Before repair, GET `/projects/FCR_010/recipes/compute_silver_alert_trade_parties_v2` returned a valid JSON envelope with `recipe.type="join"`, `recipe.inputs={}`, the expected output, and `payload=""`. The unguarded `JSON.parse(envelope.payload)` caused `Unexpected end of JSON input`. It was an empty embedded recipe payload, not a demonstrated truncated HTTP response.

The old creator omitted `creationSettings.virtualInputs`. The official Python client's `VirtualInputsSingleOutputRecipeCreator._finish_creation_settings` supplies that list, and `JoinRecipeCreator` inherits it. Merely supplying `recipePrototype.inputs` was insufficient for this Join creation workflow. The fix sends virtualInputs explicitly (also for Stack, which uses the same official creator pattern), disables implicit output provisioning in that creator, saves typed payload and verifies final metadata/payload/schema before success.

Local authoritative SDK: `project/artifacts/fcr010_silver_ldm/dataiku_api_client/dataikuapi/dss/recipe.py`, `VirtualInputsSingleOutputRecipeCreator`, `JoinRecipeCreator`, `JoinRecipeSettings.add_join/add_condition_to_join`, `DSSRecipeSettings.save`. Existing working Join configuration was inspected read-only to confirm the native `rightLimit.enabled=false` structure.

## Endpoints and response parsing

The official recipe settings envelope uses **GET and PUT `/projects/{project}/recipes/{recipe}`**. PUT sends an application/json object containing recipe metadata and `payload` as a JSON-encoded string. This client does not require a separate `/payload` route. After PUT, a separate GET is authoritative for verification.

Actual target repair PUT: HTTP 200, content-type `application/json;charset=utf-8`, 70-byte response body. The job POST likewise returned HTTP 200 JSON. No live recipe was created just to reproduce the original failure.

Successful response parsing now distinguishes JSON content types (including +json), text and empty/whitespace bodies. Empty 200/204 is accepted; recipe creation can resolve the expected recipe by a separate GET when POST provides no name. JSON parse failures report status, method, endpoint, content-type, byte length and a sanitized excerpt. Text is sanitized; successful MCP responses are also sanitized. No authorization headers or API key values are emitted in diagnostics.

`get_recipe_info` distinguishes `recipe_metadata`, `recipe_settings` (non-payload params), and `recipe_payload`. Empty visual payload returns `configuration_format: "EMPTY"`, `config:null`, and `diagnostic: "Recipe exists but visual payload is empty"`. Malformed/non-object visual JSON returns INVALID with a contextual sanitized diagnostic. Python code is not parsed as JSON.

## Update and repair contracts

```ts
repair_recipe_configuration({
  project_key: string,
  recipe_name: string,
  config: RecipeConfig,
  dry_run?: boolean
})
```

Only existing recipes can be repaired. Complete typed config replaces the known visual settings, retaining parseable unrelated settings such as engine configuration. Empty/malformed payload can be replaced with typed configuration. Repair cannot create objects, alter I/O, change schemas or build. A recipe with missing inputs needs `update_recipe` with explicit intended inputs; repair will never infer wiring silently. `update_recipe.inputs` and `.outputs` remain optional and preserve existing metadata unless explicitly supplied.

Join config requires two distinct input datasets, one output, one or more equality keys, and selected columns with unique output aliases. No Cartesian option is exposed. Native conditions are AND, rightLimit is explicitly disabled, and selection is MANUAL. Read-back validates recipe type, ordered inputs/outputs, Join type, both sides of every condition, selected columns and output aliases, virtual inputs, filters and absence of a right-side row limit. Existing dataset schemas are untouched by update/repair.

Creation validates all datasets/columns and output ownership before mutations; provisions outputs; creates metadata with virtualInputs; writes typed payload; applies explicitly requested new-output schemas last; reads back and verifies. A configuration failure reports `partial_creation`, recipe identity and recovery instructions. It never claims success or deletes a partial recipe. Guarded dataset cleanup retains outputs owned by a recipe and any ambiguous creations. There is no transactional DSS rollback; operators must use inspect/repair rather than blindly retry create.

## Authorized live repair, 2026-09-27

Only target recipe `FCR_010.compute_silver_alert_trade_parties_v2` was updated, supplying the two explicitly authorized inputs because metadata initially had none:

- silver_alert_event_v2
- silver_trade_clean

Output remained silver_alert_trade_parties_v2. Config: INNER; globaltransid = globaltransid and security_code = securitycode; eight selected columns exactly as requested; no aliases changed; no right-side limit. Dry-run performed zero writes. Read-back verified configuration and confirmed output schema unchanged. Exactly one recipe PUT and one job POST were submitted.

Job: `Build_silver_alert_trade_parties_v2__NP__2026-09-27T05-15-21.573`.
Mode: NON_RECURSIVE_FORCED_BUILD. Status: SUCCESS / DSS DONE.
One activity targeted only FCR_010.silver_alert_trade_parties_v2.

Full unsampled TSV validation passed:

- 236 rows, 236 distinct alert_record_key, zero duplicate keys.
- askclientcode and bidclientcode nonempty in every row.
- security_code matches silver_alert_event_v2 by alert_record_key; native read-back verifies the second equality condition against silver_trade_clean.securitycode.
- time_gap_seconds in [0,60], observed minimum 0 and maximum 60.

All dataset configuration hashes were unchanged. The target recipe was the only changed recipe/configuration fingerprint. Target dataset contents and DSS job/runtime history were updated by the explicitly authorized build. No new datasets/recipes, no deletes, no edits to other recipes/grouping/Infomap, no recursive build and no Gold work.

## Files, tests and deployment

Changed source: `src/dss-error.ts`, `src/dataiku-client.ts`, `src/recipe-config.ts`, `src/recipe-service.ts`, `src/mcp-server.ts`. Tests: recipes/mcp and new http-response tests. Scripts: check-join-fcr010.mjs and validate-join-output.py. Documentation: this guide, README and VISUAL_RECIPES.md. Dist is generated with TypeScript, never edited manually.

Commands: `npm.cmd run check`, `npm.cmd run lint`, `npm.cmd test` (runs `npm run build` / `tsc`). Regression tests include empty/text/JSON HTTP responses, safe JSON diagnostics, empty partial recipe metadata, explicit I/O recovery, multi-key joins, creation responses without names, strict limit read-back, dry-run and failure recovery. Existing Python, Shaker, Grouping, schema and job tests remain enabled.

Final verification: TypeScript and ESLint passed; all **107/107 tests passed**. A fresh stdio MCP process from the deployment directory successfully exposed the repair tool and updated schemas.

Canonical source: `D:\Documents\Kerja\PT All Data International\mcp-dataiku-audited\server-hardened`.
Mirror: `D:\Documents\Kerja\PT All Data International\project\plugins\dataiku\server-hardened`.
Deployment: `C:\Users\HEFRY ANESTI\plugins\dataiku\server-hardened\dist\mcp-server.js` (Node.js).
Backup: `project/artifacts/mcp_join_repair_backup_20260927.zip`; branch `codex/join-repair`, preserving earlier uncommitted work. Reload older MCP sessions to load the new repair tool.

Evidence under project/artifacts: join_repair_live_20260927.json (HTTP response metadata, dry-run/read-back, job and configuration fingerprints), join_repair_validation_20260927.json, join_repair_tests_20260927.txt and join_repair_changes_20260927.json. The integration harness only permits the named recipe PUT and one non-recursive target job POST; intent checkpoints prevent accidental resubmission.
