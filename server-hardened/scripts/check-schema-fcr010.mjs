import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DataikuClient } from '../dist/dataiku-client.js';

const project = 'FCR_010', dataset = 'silver_alert_investor_evidence_v2', recipe = 'compute_silver_alert_investor_evidence_v2';
const columns = [
  ['alert_record_key', 'string'], ['candidate_count_60s', 'bigint'], ['match_status', 'string'], ['alert_id', 'bigint'],
  ['Clientcode', 'string'], ['Housecode', 'string'], ['Securityrefinstrumentid', 'string'], ['alert_timestamp', 'datetimenotz'],
  ['security_code', 'string'], ['resolved_client_id', 'double'], ['globaltransid', 'double'], ['trade_timestamp', 'datetimenotz'],
  ['time_gap_seconds', 'double'], ['globaltransid_in_window', 'double'], ['party_side', 'string'], ['entity_type', 'string'],
  ['entity_id', 'string'], ['evidence_type', 'string'], ['evidence_date', 'dateonly'], ['source_reference', 'string'],
  ['evidence_value', 'string'], ['group_id', 'string'],
].map(([name, type]) => ({ name, type }));
const schema = { columns }, request = { project_key: project, dataset_name: dataset, schema };
const path = process.argv[2], resume = process.argv[3] === '--resume-verified-schema', apply = process.argv[3] === '--apply-and-build' || resume;
assert.ok(path, 'Supply a report/checkpoint path');
if (apply && !resume) assert.ok(!existsSync(path), 'Checkpoint exists: inspect it, do not repeat mutation');
const originalFetch = globalThis.fetch;
let puts = 0, posts = 0, schemaVerified = false;
globalThis.fetch = (url, init = {}) => {
  const method = init.method ?? 'GET', pathname = new URL(url).pathname;
  if (method !== 'GET') {
    assert.ok(apply, 'Monitoring mode is GET-only');
    const body = JSON.parse(init.body);
    if (method === 'PUT') {
      assert.ok(!resume, 'Resume never sends another schema PUT');
      assert.equal(puts, 0); assert.equal(posts, 0);
      assert.ok(pathname.endsWith('/public/api/projects/FCR_010/datasets/silver_alert_investor_evidence_v2/schema'));
      assert.deepEqual(body.columns, columns); puts++;
    } else {
      assert.equal(method, 'POST'); assert.equal(posts, 0); assert.ok(schemaVerified);
      assert.ok(pathname.endsWith('/public/api/projects/FCR_010/jobs/'));
      assert.deepEqual(body, { type: 'NON_RECURSIVE_FORCED_BUILD', refreshHiveMetastore: false, autoUpdateSchemaBeforeEachRecipeRun: false,
        outputs: [{ type: 'DATASET', id: dataset, projectKey: project, partition: null }] }); posts++;
    }
  }
  return originalFetch(url, init);
};
const client = new DataikuClient({ readOnly: !apply });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  const datasets = await client.listDatasets(project), recipes = await client.listRecipes(project), result = {};
  for (const d of datasets) result['dataset:' + d.name] = hash(d);
  for (const r of recipes) result['recipe:' + r.name] = hash((await client.getRecipeInfo(project, r.name)).raw);
  return result;
}
let report;
if (apply && !resume) {
  const before = await snapshot();
  const dry = await client.updateDataset({ ...request, dry_run: true });
  assert.equal(dry.writes, 0); assert.equal(puts + posts, 0); assert.deepEqual(dry.diff.removed, []);
  const recipePlan = await client.runRecipe({ project_key: project, recipe_name: recipe, dry_run: true });
  assert.equal(recipePlan.dataset_name, dataset);
  report = { project, dataset, before, dry_run: dry, recipe_plan: recipePlan, mutation_attempted: true };
  writeFileSync(path, JSON.stringify(report, null, 2));
  report.schema_update = await client.updateDataset(request);
  assert.equal(report.schema_update.verified, true);
  const readback = await client.getDatasetSchema(project, dataset);
  assert.deepEqual(readback.columns.map(c => ({ name: c.name, type: c.type })), columns);
  report.schema_readback = readback; schemaVerified = true;
  writeFileSync(path, JSON.stringify(report, null, 2));
  report.job_submission_attempted = true;
  writeFileSync(path, JSON.stringify(report, null, 2));
  report.job = await client.buildDataset({ project_key: project, dataset_name: dataset, mode: 'NON_RECURSIVE_FORCED_BUILD', wait: false });
  report.writes = { schema_put: puts, job_post: posts };
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ schema_columns: readback.columns.length, writes: report.writes, job: report.job }));
} else report = JSON.parse(readFileSync(path, 'utf8'));
if (resume) {
  assert.ok(!report.job_submission_attempted && !report.job, 'Job already attempted; resume polling only');
  // This branch requires explicit investigation of an earlier successful schema PUT followed by a verification warning.
  const readback = await client.getDatasetSchema(project, dataset);
  assert.deepEqual(readback.columns.map(c => ({ name: c.name, type: c.type })), columns);
  report.schema_update = await client.updateDataset(request);
  assert.equal(report.schema_update.writes, 0); assert.equal(report.schema_update.verified, true);
  report.schema_readback = readback; schemaVerified = true;
  report.initial_schema_update_warning = 'First schema PUT succeeded and read-back matched, but strict full-settings comparison reported a difference. Previous per-field values were not retained; the exact differing field cannot be established retrospectively. No schema PUT was repeated.';
  report.job_submission_attempted = true;
  writeFileSync(path, JSON.stringify(report, null, 2));
  report.job = await client.buildDataset({ project_key: project, dataset_name: dataset, mode: 'NON_RECURSIVE_FORCED_BUILD', wait: false });
  report.writes = { schema_put: 1, job_post: posts };
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ schema_columns: readback.columns.length, writes: report.writes, job: report.job }));
}
assert.ok(report.job?.job_id, 'No confirmed job ID; inspect DSS before any retry');
report.job = await client.waitForJob({ project_key: project, job_id: report.job.job_id, timeout_seconds: 45 });
const details = await client.getJobDetails(project, report.job.job_id);
report.activities = Object.values(details.baseStatus.activities ?? {}).map(a => ({ activity: a.activityId, recipe: a.recipeName, state: a.state, targets: a.targets?.map(t => t.id) }));
report.after = await snapshot();
report.changed_objects = [...new Set([...Object.keys(report.before), ...Object.keys(report.after)])].filter(k => report.before[k] !== report.after[k]);
report.other_objects_unchanged = report.changed_objects.every(k => k === 'dataset:' + dataset);
writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ job: report.job, changed_objects: report.changed_objects, other_objects_unchanged: report.other_objects_unchanged, activities: report.activities }, null, 2));
