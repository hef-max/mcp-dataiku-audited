// GET-only by two independent guards. No write-enabled option exists.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [reportPath, deployedClientPath] = process.argv.slice(2);
assert.ok(reportPath && deployedClientPath, 'Supply report path and deployed dist/dataiku-client.js');
const { DataikuClient } = await import(pathToFileURL(deployedClientPath).href);
const requests = [], originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  assert.equal(method, 'GET', 'No DSS writes are permitted by this script');
  const response = await originalFetch(url, init);
  requests.push({ method, endpoint: new URL(url).pathname, status: response.status });
  return response;
};
const client = new DataikuClient({ readOnly: true }), project = 'FCR_010';
const input = 'silver_alert_trade_candidates_windowed';
// candidate_rank is the output COLUMN. The dataset below is a plan-only name.
const output = 'silver_alert_trade_candidates_ranked_mcp_dryrun';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  return { datasets: hash(await client.listDatasets(project)), recipes: hash(await client.listRecipes(project)),
    input: hash(await client.getDataset(project, input)) };
}
const before = await snapshot();
const definition = { name: 'compute_' + output, type: 'window', inputs: [input],
  outputs: [{ name: output, new: true, clone_settings_from: input, path: '/dataiku/mcp_window_dryrun_20260927/' + output }],
  config: { kind: 'window', partition_by: ['alert_record_key'],
    order_by: ['time_gap_seconds', 'trade_timestamp', 'globaltransid'].map(column => ({ column, direction: 'ASC', nulls: 'LAST' })),
    functions: [{ function: 'row_number', alias: 'candidate_rank' }] }, dry_run: true };
const result = await client.createRecipe(project, definition);
assert.equal(result.writes, 0);
assert.deepEqual(result.schema_diff[0].schema_after.columns.at(-1), { name: 'candidate_rank', type: 'bigint' });
const after = await snapshot(); assert.deepEqual(after, before, 'Visible FCR inventory or input metadata changed during dry-run');
const report = { project, request: definition, result, requests, before, after, writes: 0,
  source: deployedClientPath, engine_executed: false, note: 'Output dataset/recipe names are proposals only; no objects were created.' };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: reportPath, requests: requests.length, writes: 0, inventory_unchanged: true,
  output_columns: result.schema_diff[0].schema_after.columns.length, candidate_rank: 'bigint', engine_executed: false }));
