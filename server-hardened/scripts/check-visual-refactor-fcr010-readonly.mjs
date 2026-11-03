import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [reportPath, clientPath] = process.argv.slice(2);
assert.ok(reportPath && clientPath, 'Supply report path and deployment dist/dataiku-client.js');
const { DataikuClient } = await import(pathToFileURL(clientPath).href);
const requests = [], originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  assert.equal(init.method ?? 'GET', 'GET', 'This script never allows writes');
  const response = await originalFetch(url, init);
  requests.push({ method: 'GET', endpoint: new URL(url).pathname, status: response.status });
  return response;
};
const c = new DataikuClient({ readOnly: true });
const project = 'FCR_010', recipe = 'compute_silver_alert_evidence_normalized', dataset = 'silver_alert_evidence_normalized';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  return { datasets: hash(await c.listDatasets(project)), recipes: hash(await c.listRecipes(project)),
    target_recipe: hash((await c.getRecipeInfo(project, recipe)).raw), target_dataset: hash(await c.getDataset(project, dataset)) };
}
const before = await snapshot();
const info = await c.getRecipeInfo(project, recipe);
const input = info.inputs.main.items[0].ref;
const schema = await c.getDatasetSchema(project, input);
assert.ok(schema.columns.some(col => col.name === 'Date'), 'Expected source Date column missing');
const explicit = await c.updateRecipe(project, recipe, { dry_run: true, config: { kind: 'shaker', steps: [{
  op: 'parse_date', column: 'Date', output_column: 'mcp_parsed_date_dryrun',
  formats: ['MM/dd/yy', 'yyyy-MM-dd'], timezone: 'Asia/Jakarta', output_type: 'dateonly',
}] } });
const template = await c.updateRecipe(project, recipe, { dry_run: true, config: { kind: 'shaker', template: { recipe_name: recipe } } });
assert.equal(explicit.writes, 0); assert.equal(template.writes, 0);
const metrics = await c.getDatasetMetrics(project, dataset);
const sample = await c.getDatasetSample(project, dataset, 3, ['alert_id', 'evidence_date']);
assert.ok(sample.row_count <= 3);
const after = await snapshot(); assert.deepEqual(after, before);
const report = { project, recipe, dataset, explicit, template, before, after, requests, writes: 0, engine_executed: false,
  metrics: { available: metrics !== null, keys: Object.keys(metrics ?? {}) },
  sample: { row_count: sample.row_count, columns: sample.columns, bytes_read: sample.bytes_read,
    limit_reached: sample.limit_reached, complete: sample.complete, values_format: sample.values_format },
  note: 'Both configurations are proposals only. No recipe, dataset, schema, or data was changed. Sample values intentionally omitted.' };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: reportPath, requests: requests.length, writes: 0, unchanged: true,
  dateparser: explicit.proposed.config.steps[0], sample_rows: sample.row_count }));
