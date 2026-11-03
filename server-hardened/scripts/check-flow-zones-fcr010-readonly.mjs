import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [reportPath, clientPath, serverPath] = process.argv.slice(2);
assert.ok(reportPath && clientPath && serverPath, 'Supply report, deployed client and server paths');
const { DataikuClient } = await import(pathToFileURL(clientPath).href);
const requests = [], originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  assert.equal(init.method ?? 'GET', 'GET', 'FCR validation rejects every non-GET request');
  const response = await originalFetch(url, init);
  requests.push({ method: 'GET', endpoint: new URL(url).pathname, status: response.status });
  return response;
};
const c = new DataikuClient({ readOnly: true }), project_key = 'FCR_010';
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function snapshot() {
  return { graph: hash((await c.client.get(`/projects/${project_key}/flow/graph/`)).data),
    zones: hash((await c.client.get(`/projects/${project_key}/flow/zones`)).data),
    datasets: hash(await c.listDatasets(project_key)), recipes: hash(await c.listRecipes(project_key)), jobs: hash(await c.getJobs(project_key, 1000)) };
}
const before = await snapshot();
const zones = await c.listFlowZones({ project_key });
const target = zones.zones.filter(z => z.name === 'Silver'); assert.equal(target.length, 1);
const names = ['PREPARE_SURVEILLANCE_EVIDENCE', 'SURVEILLANCE_EVIDENCE', 'JOIN_SURVEILLANCE_GROUP', 'SURVEILLANCE_ENRICHED',
  'PREPARE_INVESTIGATION_CLEAN', 'INVESTIGATION_CLEAN', 'JOIN_INVESTIGATION_SECURITY', 'INVESTIGATION_ENRICHED', 'PREPARE_INVESTIGATION_EVIDENCE', 'INVESTIGATION_EVIDENCE'];
const items = names.map((object_id, i) => ({ object_type: i % 2 === 0 ? 'recipe' : 'dataset', object_id }));
const mapping = [];
for (const item of items) mapping.push(await c.getFlowObjectZone({ project_key, ...item }));
const flow = await c.getProjectFlow(project_key, { max_objects: 10000 }); assert.equal(flow.truncated, false);
const move_request = { project_key, target_zone_id: target[0].zone_id, items, dry_run: true };
const move = await c.moveFlowItems(move_request); assert.equal(move.writes, 0);
const source = 'INVESTIGATION_EVIDENCE', dataset_name = 'MCP_ZONE_DRYRUN_20260928';
const dataset_request = { project_key, dataset_name, clone_settings_from: source,
  path: '/FCR_010/MCP_ZONE_DRYRUN_20260928', zone_name: 'Silver', dry_run: true };
const dataset = await c.createDataset(dataset_request); assert.equal(dataset.writes, 0);
const recipe_request = { name: 'MCP_ZONE_RECIPE_DRYRUN_20260928', type: 'python', inputs: [source],
  outputs: [{ name: dataset_name, new: true, clone_settings_from: source, path: dataset_request.path }],
  code: '# Dry-run only. No recipe is created or executed.', zone_name: 'Silver', dry_run: true };
const recipe = await c.createRecipe(project_key, recipe_request); assert.equal(recipe.writes, 0);
assert.deepEqual(recipe.proposed_zone_assignment.new_outputs, [dataset_name]);
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
  env: { ...process.env, DSS_READ_ONLY: 'true' }, stderr: 'pipe' });
const mcp = new Client({ name: 'flow-zone-readonly-validation', version: '1.0.0' });
let exposed;
try {
  await mcp.connect(transport); const { tools } = await mcp.listTools();
  exposed = tools.filter(t => ['list_flow_zones', 'get_flow_object_zone', 'move_flow_items', 'create_recipe', 'create_dataset', 'get_project_flow', 'export_project_config'].includes(t.name));
  assert.equal(exposed.length, 7);
  for (const name of ['create_recipe', 'create_dataset', 'move_flow_items']) assert.equal(exposed.find(t => t.name === name).inputSchema.properties.dry_run.default, true);
  for (const name of ['create_recipe', 'create_dataset']) assert.ok(exposed.find(t => t.name === name).inputSchema.properties.zone_name);
} finally { await mcp.close(); await transport.close(); }
const after = await snapshot();
const report = { project_key, zones, mapping, flow, move_request, move, dataset_request, dataset, recipe_request, recipe,
  exposed_tools: exposed, before, after, requests, method_counts: { GET: requests.length, POST: 0, PUT: 0, PATCH: 0, DELETE: 0 }, writes: 0,
  guards: ['DataikuClient readOnly=true', 'global fetch rejects all non-GET', 'new MCP process lists schemas only; no tool execution'],
  inventory_unchanged: JSON.stringify(before) === JSON.stringify(after) };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
assert.deepEqual(after, before, 'Flow/zones/inventory/jobs changed during validation');
console.log(JSON.stringify({ report: reportPath, method_counts: report.method_counts, inventory_unchanged: true, zones: zones.zones,
  mapping: mapping.map(o => ({ object_id: o.object_id, zone_id: o.zone_id, zone_name: o.zone_name })), move_conflicts: move.conflicts }));
