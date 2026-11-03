# Recipe configuration API

The TypeScript source is authoritative. `npm run build` generates `dist`; never edit JavaScript build output by hand.

## Request contract

```ts
interface CreateRecipeRequest {
  project_key: string;
  recipe_name: string;
  recipe_type: string;
  inputs: string[];
  outputs: RecipeOutput[]; // existing {name}, or new:true plus Dataset storage fields
  config?: RecipeConfig;
  code?: string;
  dry_run?: boolean; // default false; true permits GET only
}
```

The runtime schema is generated from the same Zod definitions used for validation in `src/recipe-config.ts`. Unknown fields are rejected. Aliases: `prepare` -> `shaker`, `stack` -> `vstack`, `sql` -> `sql_query`. `config.kind` uses the canonical name. Code recipes support `python`, `sql_query`, and `sql_script`.

Existing outputs must have no other producer. `create_recipe` accepts `new:true` with explicit storage settings or a clone source and a new path; see [DATASET_PROVISIONING.md](DATASET_PROVISIONING.md). All outputs are validated before writes and provisioned before recipe creation. `update_recipe` accepts existing outputs only. All visual recipes have one output; Join has two distinct inputs, Stack at least two, and the others one. Cross-project datasets, self-joins, non-main roles, managed folders and append mode are outside this adapter's contract.

## Visual configurations

### Join

See [JOIN_REPAIR.md](JOIN_REPAIR.md) for virtualInputs creation, empty-payload handling, repair, and read-back verification.

```json
{
  "kind": "join",
  "join_type": "LEFT",
  "left": "orders",
  "right": "trades",
  "keys": [{"left": "trade_id", "right": "id"}],
  "selected_columns": [
    {"dataset": "orders", "column": "trade_id"},
    {"dataset": "trades", "column": "quantity", "alias": "trade_quantity"}
  ],
  "post_filter": {"expression": "trade_quantity > 0", "language": "CUSTOM"}
}
```

Types: INNER, LEFT, RIGHT, FULL. Keys are equality conditions combined with AND. All columns are checked against input schemas and selected output names must be unique. Post-filter supports CUSTOM (DSS formula) or SQL; formula parsing/engine compatibility remains a DSS responsibility.

### Prepare

```json
{
  "kind": "shaker",
  "steps": [
    {"op": "filter", "expression": "amount > 0"},
    {"op": "compute", "column": "double_amount", "expression": "amount * 2"},
    {"op": "rename", "from": "label", "to": "name"},
    {"op": "cast", "column": "amount", "to": "double"},
    {"op": "trim", "column": "name"},
    {"op": "normalize", "column": "name", "mode": "lower"},
    {"op": "select", "columns": ["name", "amount", "double_amount"]}
  ]
}
```

`drop` accepts the same columns array as `select`; projection must be the last step. Cast supports string and double through DSS formulas, not arbitrary storage-type changes. Non-numeric values converted with numval become empty according to DSS semantics. Normalize supports lower/upper case, not Unicode normalization. Formula column references are not statically parsed; explicit operation columns are validated in step order. Output storage schemas are never silently changed.

### Stack

```json
{
  "kind": "vstack",
  "schema_alignment": "REMAP",
  "column_mapping": {"id": {"source_a": "client_id", "source_b": "investor_id"}}
}
```

UNION and INTERSECT use names. REMAP requires output-column -> input-dataset -> source-column mappings. Missing mappings become empty native mappings. Conflicting types are rejected; cast upstream explicitly first.

### Grouping

```json
{
  "kind": "grouping",
  "group_keys": ["alert_record_key"],
  "count_rows": true,
  "aggregations": [
    {"column": "investor_id", "operation": "count_distinct", "alias": "investor_count"},
    {"column": "time_gap", "operation": "min"},
    {"column": "time_gap", "operation": "max"},
    {"column": "amount", "operation": "sum"},
    {"column": "amount", "operation": "average"}
  ]
}
```

Empty group_keys means global aggregation. Count rows uses DSS's `count` column. Aliases for per-column aggregates are supported; duplicate outputs are rejected. This API adds capability only: existing grouping/Infomap recipes are not changed by installation.

### Window and Distinct

Window accepts explicit `partition_by`, `order_by`, and `functions` without a template.
See [WINDOW_RECIPES.md](WINDOW_RECIPES.md) for native payload evidence, null semantics,
output schema propagation, read-back checks and examples.

Legacy Window `{ "kind": "window", "template": { "recipe_name": "approved_window_template" } }`
and Distinct `{ "kind": "distinct", "template": { "recipe_name": "approved_distinct_template" } }`
remain supported. Templates require the same input schema and one input/output. Distinct
still has no explicit adapter. Template and explicit Window fields cannot be mixed.

## Create/update lifecycle

1. Validate typed request; GET project, dataset inventory, recipe inventory and input schemas.
2. Reject missing inputs/outputs, existing recipe names, output producer conflicts, missing columns and incompatible configurations.
3. With dry_run=true, return the proposed REST body/configuration; no POST, PUT, DELETE, job or schema operation.
4. Otherwise POST `{recipePrototype, creationSettings}`. Code is `creationSettings.payload`.
5. GET the created settings; merge only adapter-owned visual fields into its payload; PUT the full original envelope with the changed payload.
6. GET the result. Never run a job or apply an output schema automatically.

`update_recipe` accepts project_key/recipe_name and optional inputs, outputs, code, config, recipe_type, dry_run. It GETs current settings first, preserves unrelated recipe metadata and engine settings, and replaces the adapter-owned configuration. A complete config is required for visual updates; raw arbitrary patches and type changes are rejected. Omitted I/O is preserved, including partition dependencies. Explicit I/O changes replace main role items.

`get_recipe_info` uses GET recipe settings (not `/info`), returning recipe_type, structured inputs/outputs, the complete native config, join_keys, filters, selected_columns, aggregations, window_settings and the raw envelope. `configuration_format` identifies native payload vs code. Native config is an inspection format, not interchangeable with the typed request config.

Creation and configuration are not a DSS transaction. If creation succeeds and configuration fails, the error reports the created recipe name. It does not delete, retry creation, run, or silently claim success. Preflight cannot eliminate a race with another DSS writer; inspect conflicts again before using the API in shared production projects.

## Build and verification

```powershell
npm ci --ignore-scripts
npm run check
npm run lint
npm test
npm run build
```

`npm test` compiles and runs mock transport tests plus a real stdio MCP schema handshake against a fake DSS hostname. It does not call a live Dataiku project. To perform the explicitly read-only FCR_010 inspection:

```powershell
node scripts/check-fcr-readonly.mjs
```

The script uses a read-only HTTP client AND a fetch guard that rejects every method except GET. It checks information retrieval, a Join update dry-run, output conflict rejection, and before/after recipe metadata hashes. It does not call the older `test_recipe_dry_run` endpoint.

`DSS_READ_ONLY=true` can also force the HTTP client to reject all non-GET calls. Normal create/update behavior still requires an explicitly authorized tool invocation.

Output schema computation/application and write integration tests should be conducted separately in an approved disposable project. No dataset/recipe was created for the implementation verification.

## Contract provenance

- https://doc.dataiku.com/dss/api/latest/rest/ (recipePrototype/creationSettings and GET/PUT envelope)
- https://developer.dataiku.com/latest/api-reference/python/recipes.html (Join, Stack, Grouping, Prepare settings)
- https://doc.dataiku.com/dss/latest/formula/index.html (Prepare formulas)
- Read-only native payload inspection of existing Join, Prepare, Stack and Grouping recipes in FCR_010 on 2026-09-26; no raw project data or credentials are bundled in the tests.

See [VISUAL_REFACTOR.md](VISUAL_REFACTOR.md) for Prepare `parse_date`, schema-identical shaker templates, and full configuration read-back checks.
