# Flow Zone API

The TypeScript server uses the public DSS API. Local official reference: `dataikuapi/dss/flow.py`, `DSSProjectFlow.get_graph`, `list_zones`, `get_zone_of_object`, `_to_smart_ref`, and `DSSFlowZone.add_items`.

| Operation | Official route | Body |
| --- | --- | --- |
| Graph | GET `/projects/{project}/flow/graph/` | none |
| Zones | GET `/projects/{project}/flow/zones` | none |
| Batch assignment | POST `/projects/{project}/flow/zones/{zone}/add-items` | array of smart references |

Smart reference: `{ "objectId": "my_dataset", "objectType": "DATASET" }`; recipes use `RECIPE`. Foreign references include `projectKey`. The former `/flow/` route is not the SDK graph endpoint.

`list_flow_zones({project_key})` returns zone IDs, names, colors, default status and owned-object counts. `get_flow_object_zone({project_key,object_type,object_id,object_project_key?})` resolves typed identities and verifies existence against the graph. `object_id` accepts a local ID or fully qualified reference. Supported graph types are dataset, recipe, managed_folder, saved_model, streaming_endpoint, labeling_task, knowledge_bank. Unrecognized graph types are reported and cannot be moved. Model evaluation store graph tags are not guessed.

The SDK defines the `default` zone as objects not explicitly assigned elsewhere. Counts therefore combine graph objects and zone ownership; the default zone's empty `items` does not mean zero objects. `shared` appearances are visibility, not ownership, and are not removed by moving ownership.

```json
{
  "project_key": "MY_PROJECT",
  "target_zone_id": "actual-zone-id",
  "items": [
    {"object_type": "recipe", "object_id": "prepare_evidence"},
    {"object_type": "dataset", "object_id": "evidence"}
  ],
  "dry_run": true
}
```

`move_flow_items` defaults to dry-run, performs only GETs and returns source assignments, target, conflicts and proposed diff. Explicit `dry_run:false` is required for writes. Missing/unsupported/duplicate objects fail preflight before any POST. Because the SDK says add-items can implicitly move a dataset's producer, preflight requires the producer and sibling outputs to be requested or already at target. It never silently adds inputs. One batch POST is followed by verification of all supported graph ownership, detecting unintended collateral moves. The API does not promise atomicity. On failure, changed assignments are grouped by original zone, restored and read back; errors explicitly report whether rollback was verified. Concurrent writers can prevent rollback; no atomic guarantee is claimed. Graph topology/assignments are checked again before the POST.

## Creation

`create_recipe` and `create_dataset` accept mutually exclusive `zone_id` or `zone_name`; names match exactly, case-sensitively, and must be unique. Invalid selection fails before provisioning. Both now default to `dry_run:true`. Existing callers intending writes must pass `dry_run:false`; legacy payload shape remains accepted. As clarified by the user, defaults on other existing update/delete/job tools are unchanged.

Recipe and all `new:true` output datasets are assigned together, then verified. Existing input objects are never included. An existing output outside the requested zone is rejected unless `move_existing_outputs:true` is explicitly supplied. Without a zone selector there is no assignment POST: DSS retains its creation behavior, and responses report actual assigned zones from GET read-back. Dry-run's default zone is provisional, not a guarantee of DSS automatic placement.

If assignment fails, errors disclose partial creation. Only confirmed new, empty, unreferenced, unpartitioned datasets with matching creation/storage identity qualify for metadata-only cleanup (`dropData=false`). Emptiness uses a bounded one-row official TSV `/data/` stream and `/finish-streaming/`; unreadable/missing storage is not proof of emptiness. New recipes and referenced outputs are conservatively retained when safe deletion cannot be established. Existing resources and physical data are never cleanup targets. Inspect the diagnostic before retrying creation.

## Reading Flow/configuration

`get_project_flow` returns typed datasets/recipes/other objects, dependency edges, per-object zones, zone counts and unsupported/unassigned nodes. `detail` is `summary` or `detail`; `max_objects` defaults to 2000 (maximum 10000). Truncation is explicit. Transport responses are bounded to 5 MiB.

`export_project_config` now returns an explicitly labeled JSON Flow configuration snapshot, not a full project archive. YAML is rejected. Official project export is a POST producing ZIP; this tool does not call it. Binary content types and ZIP magic are rejected, never printed as archive text. Use a dedicated archive workflow for full exports.

## Validation

Run `npm run check`, `npm run lint`, `npm test`, `npm run build`. Mutation tests use mocked transport. `scripts/check-flow-zones-fcr010-readonly.mjs` installs an independent GET-only fetch guard and uses a read-only client; it reports request counts, actual zones/mapping, dry-run plans and before/after inventory hashes. It never moves objects, provisions resources, or runs jobs in FCR_010.
