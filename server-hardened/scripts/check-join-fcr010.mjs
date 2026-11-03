import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DataikuClient } from '../dist/dataiku-client.js';
const project = 'FCR_010', recipe = 'compute_silver_alert_trade_parties_v2', dataset = 'silver_alert_trade_parties_v2';
const inputs = ['silver_alert_event_v2', 'silver_trade_clean'];
const names = ['alert_record_key', 'globaltransid', 'security_code', 'alert_timestamp', 'trade_timestamp', 'time_gap_seconds', 'askclientcode', 'bidclientcode'];
const config = { kind: 'join', left: inputs[0], right: inputs[1], join_type: 'INNER',
  keys: [{ left: 'globaltransid', right: 'globaltransid' }, { left: 'security_code', right: 'securitycode' }],
  selected_columns: names.map((column, i) => ({ dataset: inputs[i < 6 ? 0 : 1], column })) };
const path = process.argv[2], apply = process.argv[3] === '--repair-and-build';
assert.ok(path, 'Supply a checkpoint/report file');
if (apply) assert.ok(!existsSync(path), 'Checkpoint exists: inspect rather than resubmit mutations');
const originalFetch = globalThis.fetch, requests = [];
let puts = 0, posts = 0, verified = false;
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET', endpoint = new URL(url).pathname;
  if (method !== 'GET') {
    assert.ok(apply, 'Read-only resume');
    const body = JSON.parse(init.body);
    if (method === 'PUT') {
      assert.equal(puts, 0); assert.equal(posts, 0);
      assert.ok(endpoint.endsWith(`/public/api/projects/${project}/recipes/${recipe}`));
      assert.deepEqual(body.recipe.inputs.main.items.map(i => i.ref), inputs);
      assert.deepEqual(body.recipe.outputs.main.items.map(i => i.ref), [dataset]);
      const payload = JSON.parse(body.payload);
      assert.equal(payload.joins[0].type, 'INNER'); assert.equal(payload.joins[0].on.length, 2);
      assert.equal(payload.joins[0].rightLimit.enabled, false); assert.equal(payload.selectedColumns.length, 8);
      puts++;
    } else {
      assert.equal(method, 'POST'); assert.equal(posts, 0); assert.ok(verified);
      assert.ok(endpoint.endsWith(`/public/api/projects/${project}/jobs/`));
      assert.deepEqual(body, { type: 'NON_RECURSIVE_FORCED_BUILD', refreshHiveMetastore: false, autoUpdateSchemaBeforeEachRecipeRun: false,
        outputs: [{ type: 'DATASET', id: dataset, projectKey: project, partition: null }] }); posts++;
    }
  }
  const response = await originalFetch(url, init);
  const text = await response.clone().text();
  requests.push({ method, endpoint, status: response.status, content_type: response.headers.get('content-type'), body_length: Buffer.byteLength(text) });
  return response;
};
const c = new DataikuClient({ readOnly: !apply });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  const ds = await c.listDatasets(project), rs = await c.listRecipes(project), result = {};
  for (const d of ds) result['dataset:' + d.name] = hash(d);
  for (const r of rs) result['recipe:' + r.name] = hash((await c.getRecipeInfo(project, r.name)).raw);
  return result;
}
let report;
if (apply) {
  const before = await snapshot(), info = await c.getRecipeInfo(project, recipe), schema = await c.getDatasetSchema(project, dataset);
  assert.deepEqual(schema.columns.map(c => c.name), names);
  // This partial recipe has missing metadata inputs; explicit user-named inputs repair that via update_recipe.
  const update = { inputs, config };
  const dry = await c.updateRecipe(project, recipe, { ...update, dry_run: true });
  assert.equal(dry.writes, 0); assert.equal(puts + posts, 0);
  report = { project, recipe, dataset, before, before_configuration_format: info.configuration_format, before_inputs: info.inputs,
    schema_before: schema, dry_run: dry, mutation_attempted: true };
  writeFileSync(path, JSON.stringify(report, null, 2));
  const repaired = await c.updateRecipe(project, recipe, update);
  assert.equal(repaired.verified, true);
  assert.deepEqual(repaired.inputs.main.items.map(i => i.ref), inputs);
  assert.deepEqual(repaired.outputs.main.items.map(i => i.ref), [dataset]);
  assert.equal(repaired.config.joins[0].type, 'INNER'); assert.equal(repaired.config.joins[0].on.length, 2);
  assert.equal(repaired.config.joins[0].rightLimit.enabled, false);
  assert.deepEqual(repaired.config.selectedColumns.map(c => c.alias || c.name), names);
  const afterSchema = await c.getDatasetSchema(project, dataset);
  assert.deepEqual(afterSchema, schema, 'Repair must not change output schema');
  report.repair = { inputs: repaired.inputs, outputs: repaired.outputs, config: repaired.config, verified: true };
  report.schema_unchanged = true; verified = true;
  report.job_submission_attempted = true;
  writeFileSync(path, JSON.stringify(report, null, 2));
  report.job = await c.buildDataset({ project_key: project, dataset_name: dataset, mode: 'NON_RECURSIVE_FORCED_BUILD', wait: false });
  report.writes = { recipe_put: puts, job_post: posts };
  report.requests = requests;
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ repaired: true, writes: report.writes, job: report.job }));
} else report = JSON.parse(readFileSync(path, 'utf8'));
assert.ok(report.job?.job_id, 'Unknown submission outcome: inspect DSS, do not retry creation');
report.job = await c.waitForJob({ project_key: project, job_id: report.job.job_id, timeout_seconds: 45 });
const details = await c.getJobDetails(project, report.job.job_id);
report.activities = Object.values(details.baseStatus.activities ?? {}).map(a => ({ activity: a.activityId, recipe: a.recipeName, state: a.state, targets: a.targets?.map(t => t.id) }));
report.after = await snapshot();
report.changed_objects = [...new Set([...Object.keys(report.before), ...Object.keys(report.after)])].filter(k => report.before[k] !== report.after[k]);
report.other_objects_unchanged = report.changed_objects.every(k => ['recipe:' + recipe, 'dataset:' + dataset].includes(k));
report.requests = [...(report.requests ?? []), ...requests.filter(r => !report.requests?.includes(r))];
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ job: report.job, activities: report.activities, changed_objects: report.changed_objects, other_objects_unchanged: report.other_objects_unchanged,
  mutation_responses: report.requests.filter(r => r.method !== 'GET') }, null, 2));
