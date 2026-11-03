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
const request = { project_key: 'FCR_010', recipe_name: 'compute_silver_evidence_unified',
  old_input: 'silver_surveillance_evidence_normalized', new_input: 'SURVEILLANCE_EVIDENCE',
  require_identical_schema: true, dry_run: true };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  return { recipe: hash((await c.getRecipeInfo(request.project_key, request.recipe_name)).raw),
    datasets: hash(await c.listDatasets(request.project_key)), recipes: hash(await c.listRecipes(request.project_key)),
    old_dataset: hash(await c.getDataset(request.project_key, request.old_input)),
    new_dataset: hash(await c.getDataset(request.project_key, request.new_input)), jobs: hash(await c.getJobs(request.project_key, 1000)) };
}
const before = await snapshot(), original = await c.getRecipeInfo(request.project_key, request.recipe_name);
const result = await c.replaceVisualRecipeInput(request);
assert.equal(result.writes, 0); assert.equal(result.schema_comparison.identical, true);
assert.equal(result.slot.index, 2); assert.equal(result.slot.position, 3);
assert.equal(result.proposed.payload.virtualInputs[2].originLabel, request.new_input);
assert.deepEqual(result.proposed.payload.virtualInputs.map(v => v.columnsMatch), original.config.virtualInputs.map(v => v.columnsMatch));
assert.deepEqual(result.proposed.payload.selectedColumns, original.config.selectedColumns);
assert.ok(!JSON.stringify(result.proposed.payload).includes(request.old_input));
const after = await snapshot(); assert.deepEqual(after, before, 'Inventory/recipe/dataset/job snapshot changed during validation');
writeFileSync(reportPath, JSON.stringify({ request, result, before, after, requests, writes: 0,
  acceptance: { identical_schema: true, replaced_slot: 3, columnsMatch_preserved: true,
    selectedColumns_preserved: true, no_stale_payload_reference: true, unchanged_recipe_datasets_jobs: true },
  executed: false, canonical_data_rechecked: false }, null, 2) + '\n');
console.log(JSON.stringify({ report: reportPath, requests: requests.length, writes: 0,
  identical_schema: true, slot: 3, native_mappings_preserved: true, inventory_unchanged: true }));
