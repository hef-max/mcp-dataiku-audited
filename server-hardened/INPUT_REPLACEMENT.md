# Schema-compatible native input replacement

`replace_visual_recipe_input` replaces one input slot without rebuilding a visual
recipe from typed config. It supports native Vstack, Join, Prepare/shaker,
Grouping, Window, and Distinct.

```json
{"project_key":"FCR_010","recipe_name":"compute_silver_evidence_unified",
 "old_input":"silver_surveillance_evidence_normalized","new_input":"SURVEILLANCE_EVIDENCE",
 "require_identical_schema":true,"dry_run":true}
```

Both booleans default to true. Schema checks cannot be disabled: false for
`require_identical_schema` is rejected. Column name, order, storage type and
meaning must match; comments and other descriptive metadata are not compared.
Missing meaning and null meaning are equivalent. Old input must occur exactly
once; new input must exist and must not already be an input or output.

This API bypasses the full `buildVisualPayload` adapter intentionally. Vstack
REMAP may already contain type conflicts between other inputs that DSS handles
in its native configuration. Schema equivalence of the replaced slot means those
existing conditions are unchanged. Vstack reads only old/new schemas; Join reads
each virtual slot to report and validate effective schemas. Blank
`columnsMatch` entries, arrays, ordering, selected columns, filters, aliases that
are not dataset labels, join limits and other transformations remain intact.

The adapter operates on the official GET/PUT recipe settings envelope already
used by the SDK. It changes metadata input `ref` and matching virtual-input
origin/alias/labels at the same index. Exact dataset reference keys/values in
engine/read/cache settings are renamed while their tuning values are preserved.
Dataset keys in native mapping dictionaries are renamed; column values are not
reconstructed. `copySchemaFromDatasetWithName` changes only when it references
the old input. Engine settings may exist in payload and recipe.params; both are
handled. No broad text substitution is performed. Unknown remaining old-input
references or key collisions fail closed and require a verified adapter update.

Virtual-input adapters require main-role metadata and a matching indexed native
virtualInputs list. Join column references on the replaced index are checked
against the identical schema. Single-input adapters require one metadata input;
their transformation payload remains unchanged except explicit dataset references.
Metadata role/item fields and outputs are retained.

Dry-run performs GET only and returns slot/index, schema comparison, changed
native reference paths, sanitized before/after diff, proposed payload, writes=0,
executed=false, and read_back_verification.performed=false. It does not validate
data equivalence or execute the recipe.

With dry_run=false the service rechecks recipe and old/new schemas against
concurrent changes and sends one recipe PUT. GET read-back must match the entire
proposed native payload and recipe metadata structurally, excluding DSS's
versionTag. It must contain the new input in exactly the same slot and no retired
input references. A mismatch is a failure with partial-write diagnostics, not a
successful replacement. Failed PUT/read-back now triggers a PUT of the original
envelope and GET verification; diagnostics report rollback.verified and both write
attempts. Failed preflight remains zero-write. DSS has no atomic compare-and-swap;
preflight cannot exclude all concurrent changes after its last GET. A rollback
failure requires inspection before retrying. Schema writes, dataset provisioning,
and builds are never performed.

Join replacement validates an effective schema for each virtual input: physical
columns plus that slot's computedColumns. Computed definitions are copied intact,
including unknown fields, order, mode and expression; nothing is materialized into
a dataset. Dependencies are checked in declaration order, allowing a later computed
column to use an earlier one. Selected columns, join conditions and enabled
pre/post filters use the effective schema; post filters can use selected aliases.
Dry-run returns effective_schemas with physical_columns, computed_columns and
effective_columns separately. Missing references report recipe, slot/alias,
column, native location and both searched schema sources.

Expression validation recognizes SQL quoted/bare identifiers, function calls,
common SQL keywords/types and formula identifiers/val() references. It is a
conservative reference check, not a full DSS/SQL compiler: dialect constructs not
recognized may be rejected. Expressions are never rewritten. A dataset-named alias
embedded in an expression therefore fails the existing stale-reference guard
rather than silently changing Join logic. Other slots are read for Join schema
validation; the Vstack replacement remains slot-local.

Native payload evidence for Vstack comes from the GET of
FCR_010.compute_silver_evidence_unified: mode REMAP, six indexed virtualInputs,
blank columnsMatch entries, copySchemaFromDatasetWithName, and SparkSQL read map.
Live validation is restricted to dry-run. Unit/HTTP integration tests verify
write and read-back behavior using mocks; no live FCR_010 mutation is authorized.
