import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [reportPath, clientPath] = process.argv.slice(2);
assert.ok(reportPath && clientPath, 'Supply report path and deployed dist/dataiku-client.js');
const { DataikuClient } = await import(pathToFileURL(clientPath).href);
const originalFetch = globalThis.fetch, requests = [];
globalThis.fetch = async (url, init = {}) => {
  assert.equal(init.method ?? 'GET', 'GET', 'No write is allowed');
  const response = await originalFetch(url, init);
  requests.push({ method: 'GET', endpoint: new URL(url).pathname, status: response.status });
  return response;
};
const c = new DataikuClient({ readOnly: true }), project = 'FCR_010';
const recipe = 'compute_silver_surveillance_enriched', left = 'dmSurveillanceAction_new_dummy', right = 'silver_investor_group';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  return { datasets: hash(await c.listDatasets(project)), recipes: hash(await c.listRecipes(project)),
    target_recipe: hash((await c.getRecipeInfo(project, recipe)).raw) };
}
const before = await snapshot(), original = await c.getRecipeInfo(project, recipe);
assert.equal(original.recipe_type, 'join');
assert.deepEqual(original.inputs.main.items.map(i => i.ref), ['silver_surveillance_evidence', right]);
assert.equal(original.config.joins.length, 1);
const native = original.config.joins[0];
assert.equal(native.table1, 0); assert.equal(native.table2, 1);
assert.equal(original.config.postFilter.enabled, false);
const config = { kind: 'join', join_type: native.type, left, right,
  keys: native.on.map(k => { assert.equal(k.type, 'EQ'); return { left: k.column1.name, right: k.column2.name }; }),
  selected_columns: original.config.selectedColumns.map(col => {
    assert.ok([0, 1].includes(col.table));
    return { dataset: col.table === 0 ? left : right, column: col.name, ...(col.alias ? { alias: col.alias } : {}) };
  }) };
const rewire = await c.updateRecipe(project, recipe, { inputs: [left, right], config, dry_run: true });
assert.equal(rewire.input_settings_reset, true);
assert.equal(rewire.proposed.config.engineParams, undefined);
assert.equal(rewire.proposed.recipe_settings.engineParams, undefined);
assert.ok(!JSON.stringify(rewire.proposed.config).includes('silver_surveillance_evidence'));
assert.ok(!JSON.stringify(rewire.proposed.recipe_settings).includes('silver_surveillance_evidence'));
const provisioning = await c.createDataset({ project_key: project, dataset_name: 'mcp_path_rewire_dryrun_20260927',
  clone_settings_from: left, path: '/dataiku/FCR_010/mcp_path_rewire_dryrun_20260927', dry_run: true });
const after = await snapshot(); assert.deepEqual(before, after);
writeFileSync(reportPath, JSON.stringify({ project, recipe, before, after, requests, rewire, provisioning,
  writes: 0, engine_executed: false, note: 'Dataset name/path and Join changes are proposals only; nothing was created or updated.' }, null, 2) + '\n');
console.log(JSON.stringify({ report: reportPath, requests: requests.length, writes: 0, unchanged: true,
  retired_input_absent: true, engine_settings_reset: true, provisioning_dry_run: true }));
