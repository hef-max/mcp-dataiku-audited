# Explicit native Window recipes

`create_recipe`, `update_recipe`, and `repair_recipe_configuration` accept:

```json
{"kind":"window","partition_by":["alert_record_key"],"order_by":[
  {"column":"time_gap_seconds","direction":"ASC","nulls":"LAST"},
  {"column":"trade_timestamp","direction":"ASC","nulls":"LAST"},
  {"column":"globaltransid","direction":"ASC","nulls":"LAST"}
],"functions":[{"function":"row_number","alias":"candidate_rank"}]}
```

No template is read in explicit mode. An empty partition list means one global
partition; ordering and functions must be nonempty. Supported functions are
`row_number`, `rank`, `dense_rank`, `min`, `max`, `first`, `last`. The latter four
require `column`. Each native function/column can occur once. Aliases must be
unique and cannot shadow input columns or collide with native generated names.
All source columns are validated against the input schema before writes.

The legacy `{ "kind":"window", "template":{"recipe_name":"existing"} }`
mode remains unchanged. It requires exactly matching input schema and one
input/output. Explicit fields and a template cannot be mixed. Template mode
does not infer or propagate output schema.

## Native payload evidence

The adapter is grounded in GET responses from DSS on 2026-09-27, retained in
`test/fixtures/window-dss-evidence.json`:

- `SOL_NEXT_BEST_OFFER.compute_data_results_impact_ranked`: `rowNumber` flag and
  `outputColumnNameOverrides.rownumber` alias.
- `SOL_DKU_MONITORING.compute_logs_local_process_memory_rank`: `denseRank` flag,
  `denserank` bigint schema, explicit retrieval, DSS engine, ordering structure.
- `SAMPLE_007.compute_BEST_NEWS_KI_MATCH`: `windows`, `values`, min aggregation,
  `<column>_min` aliases, and disabled filters.
- The official UI served by this DSS (`flowpack.hashed.108e497dc5f1.js`) contains
  `WindowRecipeController` and `computedColumnStep`. The latter creates native
  computed-column objects with `name`, `type`, `expr`, `mode: "GREL"`. Asset hash
  and a short relevant excerpt are recorded in the fixture. Window controller
  explicitly allows computed columns as ordering columns and offers
  min/max/first/last operations. This is shipped DSS implementation evidence,
  not an invented REST or payload field.
- Local official `dataikuapi/dss/recipe.py`: Window settings helpers are empty;
  recipe settings save uses PUT `/projects/{project}/recipes/{recipe}` with
  `{recipe, payload}`. Output schema uses official dataset schema PUT endpoint.

## Ordering, nulls and frame semantics

The [Window documentation](https://doc.dataiku.com/dss/latest/other_recipes/window.html)
links to [DSS null ordering](https://doc.dataiku.com/dss/latest/other_recipes/sort.html).
Native ordering exposes only `column` and `desc`. The adapter does not invent a
`nulls` native property. Instead, each explicitly requested null placement adds
an internal bigint computed column using documented
[formula functions](https://doc.dataiku.com/dss/latest/formula/index.html):
`if(isBlank(val("column")), 1, 0)`. It orders this key descending for FIRST and
ascending for LAST, immediately before the original column's ASC/DESC key.
Names are collision-safe; explicit retrieval excludes these helper columns.
Null and empty string are equivalent according to DSS semantics; this API does
not promise SQL distinctions between them. Omitting `nulls` uses DSS defaults.

Explicit mode chooses `engineType: "DSS"` to avoid SQL dialect differences and
uses a full-partition ROWS frame (enabled frame, neither preceding nor following
limit). Thus first/last refer to the ordered whole partition, not a running
frame. Filters and computed settings from an old recipe are replaced; metadata
and I/O are preserved unless update explicitly rewires I/O. SQL/Spark selection,
bounded frames, lag/lead and custom functions are outside this API version.

## Schema, read-back and dry-run

Output schema contains the original columns plus requested function aliases.
Ranking functions are bigint; min/max/first/last retain source storage type.
Unsupported schema types fail before writes. Explicit Window owns the output
schema, including on update/repair: a supplied new-output schema must match the
inferred schema. Other recipe types retain their previous schema behavior.

After recipe PUT, GET verifies type, I/O, partition, ordering, functions, aliases,
computed null keys, retrieval, filters and frame. Only then is the output schema
applied through the schema-only endpoint, with its own GET verification. A
read-back mismatch is a failure; partial writes are not claimed to be rolled
back. No recipe execution occurs. Dry-run performs GET only and returns the
proposed payload and schema diff, including for planned new outputs.

Tests integrate the adapter, recipe service, schema service and mocked HTTP
transport. They do not certify live DSS engine execution. The permitted live
FCR_010 check is GET-only: no create/PUT/schema change/build is performed.
Actual execution, row-level rank correctness and engine output ordering still
require a separately authorized test. Existing MCP processes need reload to
load newly deployed JavaScript; syncing files alone does not replace loaded code.
