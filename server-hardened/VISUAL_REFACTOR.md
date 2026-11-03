# Prepare refactoring and bounded dataset reads

## DateParser

```json
{"kind":"shaker","steps":[
  {"op":"parse_date","column":"raw_date",
   "formats":["yyyy-MM-dd","MM/dd/yy"],"timezone":"Asia/Jakarta",
   "output_type":"dateonly","output_column":"parsed_date"}
]}
```

`output_type` accepts `date`, `dateonly`, `datetimenotz`. `timezone` defaults to
UTC and is validated as an IANA zone. `output_column` is optional; omitting it
replaces the source column. A new output cannot shadow another column.
Subsequent explicit steps can use the parsed column. Formats are native DSS/Java
date patterns, not Python strptime patterns. Actual parsing and compatibility of
a pattern with the source data require a separately authorized execution.

The adapter emits `DateParser` with `appliesTo: SINGLE_COLUMN`, `columns`,
`formats`, `timezone_id`, `lang: auto`, `outCol`, and `outType: {name: out, type}`.
Evidence: GET of FCR_010.compute_silver_alert_evidence_normalized and the shipped
DSS processor UI; sanitized processor fixture is in
`test/fixtures/dateparser-dss-evidence.json`. Other observed DSS recipes use
`outCol` for a separate parsed column. No processor fields or REST routes were
invented. A processor's output type is configured here; existing Prepare output
dataset schema is not manually overwritten by this change.

## Prepare templates and complete updates

```json
{"kind":"shaker","template":{"recipe_name":"approved_prepare"}}
```

Exactly one of `steps` or `template` is required. A template must be a same-project
shaker with one input/output and identical input column names, storage types and
order. Comments/meanings do not affect compatibility. Native payload is copied;
physical engine settings are retained from the destination, not the template.

Complete explicit configurations replace previous transformation payload fields,
retaining destination engine parameters only when input names and order are unchanged. This prevents stale steps, filters,
indices or mappings from surviving a refactor. Metadata is rebuilt from resolved
inputs/outputs, preserving existing per-item dependency/append settings. Supply
`inputs` and `outputs` to rewire a recipe. A Join config can resolve missing or
different input metadata from its explicit left/right pair. Repair preserves I/O
and still rejects configurations inconsistent with those references. Vstack REMAP
maps by input name and regenerates its indexed mapping in the metadata order;
unlisted source datasets are rejected, not silently added.

GET read-back verifies type, metadata I/O, Join indices/virtual inputs/selections,
Vstack mode/mappings/virtual inputs, and Prepare native steps and projection.
Dry-run produces the proposed recipe/configuration without any mutation.

## Dataset reads

- Metrics: GET `/projects/{project}/datasets/{dataset}/metrics/last/NP`.
- Sample: GET `/projects/{project}/datasets/{dataset}/data/` with
  `format=tsv-excel-noheader` and `readSessionId`.
- Endpoint and TSV quoting/session behavior follow the locally installed official
  `dataikuapi.dss.dataset.DSSDataset.iter_rows` and `dataikuapi.utils` reader.
  Exhausted streams are checked with GET `finish-streaming/` as in that client.
- Read schema first; validate requested columns before reading data. Projection is
  local because this official endpoint does not document a column projection
  parameter. Rows are HEAD rows, not a randomized sample; cells remain strings to
  preserve identifiers and bigint precision.
- Strict integer row bound: 1–1000 (default 100). Byte bound: 1 MiB before projection.
  UTF-8 streaming handles quoted tabs/newlines/doubled quotes. It cancels at the row
  limit; oversized, malformed or schema-width-mismatched streams fail with
  data-free diagnostics. Early cancellation cannot certify unconsumed stream data.
- Response: `columns`, `rows`, `row_count`, `limit_reached`, `complete`,
  `bytes_read`, `sampling`, `values_format`, `max_rows`, `max_bytes`.

No new functionality runs recipes or builds datasets. Live FCR_010 checks are
GET-only and store only sample counts/schema, not sample data, in their report.

## Existing storage paths and input-bound engine settings

New request paths remain literal-only: variables, including `${projectKey}`, are
rejected. Existing dataset paths resolve `${projectKey}` from the owning dataset
project before overlap comparison. The project is taken from DSS metadata or the
project inventory being read, never from the new dataset request for a different
project. Clone-source comparisons use the same rule. Other unresolved variables
fail closed with an existing-path diagnostic; no environment/project variables
are evaluated and no stored dataset path is rewritten.

When visual input names or order change, the entire optional `engineParams` block
is removed from both native payload and recipe metadata params. This includes
Spark/SparkSQL read maps, repartitioning, and future engine-specific caches.
Other metadata params fields containing retired input references are discarded.
Complete explicit payloads already replace old transformation/cached fields.
The dry-run response exposes `input_settings_reset: true` and the proposed payload.

Pre-write and GET read-back checks scan payload and metadata params recursively,
including object keys, arrays, string values, and project-qualified references.
References to retired datasets cause failure; retained inputs remain valid.
Names prefixed by an old name (such as output `old_enriched`) are not mistaken
for that old dataset. Rewiring intentionally resets previous engine tuning;
DSS will use defaults until engine options are configured again. No build is run.
