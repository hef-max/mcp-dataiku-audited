import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [reportPath, clientPath] = process.argv.slice(2);
assert.ok(reportPath && clientPath, 'Supply report and deployed dist/dataiku-client.js paths');
const { DataikuClient } = await import(pathToFileURL(clientPath).href);
const requests = [], originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  assert.equal(init.method ?? 'GET', 'GET', 'This validation never permits a write');
  const response = await originalFetch(url, init);
  requests.push({ method: 'GET', endpoint: new URL(url).pathname, status: response.status });
  return response;
};
const c = new DataikuClient({ readOnly: true });
const request = { project_key: 'FCR_010', recipe_name: 'compute_silver_alert_enriched',
  old_input: 'silver_alert_evidence', new_input: 'ALERT_CLEAN',
  require_identical_schema: true, dry_run: true };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  const info = await c.getRecipeInfo(request.project_key, request.recipe_name);
  const outputSchemas = {};
  for (const role of Object.values(info.raw.recipe.outputs)) for (const item of role.items) outputSchemas[item.ref] = hash(await c.getDatasetSchema(request.project_key, item.ref));
  return { recipe: hash((await c.getRecipeInfo(request.project_key, request.recipe_name)).raw),
    output_schemas: outputSchemas,
    datasets: hash(await c.listDatasets(request.project_key)), recipes: hash(await c.listRecipes(request.project_key)),
    old_dataset: hash(await c.getDataset(request.project_key, request.old_input)),
    new_dataset: hash(await c.getDataset(request.project_key, request.new_input)), jobs: hash(await c.getJobs(request.project_key, 1000)) };
}
const before = await snapshot(), original = await c.getRecipeInfo(request.project_key, request.recipe_name);
const result = await c.replaceVisualRecipeInput(request);
assert.equal(result.writes, 0); assert.equal(result.schema_comparison.identical, true);
assert.equal(result.slot.index, 0);
assert.equal(result.schema_comparison.old.length, 81);
assert.equal(result.schema_comparison.new.length, 81);
const effective = result.effective_schemas[0];
assert.equal(effective.physical_columns.length, 81);
assert.equal(effective.effective_columns.length, 83);
assert.deepEqual(effective.computed_columns.map(c => c.name), ['alert_timestamp', 'alert_record_key']);
assert.deepEqual(result.proposed.payload.virtualInputs[0].computedColumns, original.config.virtualInputs[0].computedColumns);
for (const key of ['joins', 'selectedColumns', 'postFilter']) assert.deepEqual(result.proposed.payload[key], original.config[key]);
assert.deepEqual(result.proposed.recipe.outputs, original.raw.recipe.outputs);
assert.equal(result.proposed.payload.virtualInputs[0].originLabel, request.new_input);
assert.ok(!JSON.stringify(result.proposed.payload).includes(request.old_input));
const after = await snapshot(); assert.deepEqual(after, before, 'Inventory/recipe/dataset/job snapshot changed during validation');
writeFileSync(reportPath, JSON.stringify({ request, result, before, after, requests, writes: 0,
  method_counts: { GET: requests.length, POST: 0, PUT: 0, PATCH: 0, DELETE: 0 },
  acceptance: { identical_schema: true, replaced_slot: 1, computed_columns_preserved: true,
    selectedColumns_preserved: true, no_stale_payload_reference: true, unchanged_recipe_datasets_jobs: true },
  executed: false, canonical_data_rechecked: false }, null, 2) + '\n');
console.log(JSON.stringify({ report: reportPath, requests: requests.length, writes: 0,
  identical_schema: true, physical_columns: effective.physical_columns.length, computed_columns: effective.computed_columns.map(c => ({ name: c.name, type: c.type })),
  effective_columns: effective.effective_columns.length, slot: 1, native_mappings_preserved: true, inventory_unchanged: true }));

