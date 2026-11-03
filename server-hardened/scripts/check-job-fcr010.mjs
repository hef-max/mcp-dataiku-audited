// Explicitly authorized integration target. Never broaden this allowlist or retry submission automatically.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DataikuClient } from '../dist/dataiku-client.js';
const project = 'FCR_010', dataset = 'silver_alert_investor_evidence_v2', recipe = 'compute_silver_alert_investor_evidence_v2';
const reportPath = process.argv[2];
assert.ok(reportPath, 'Supply a local report/checkpoint path');
const submit = process.argv[3] === '--submit';
if (submit) assert.ok(!existsSync(reportPath), 'Checkpoint already exists; inspect the existing job instead of submitting again');
let posts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => {
  const method = init.method ?? 'GET';
  if (method !== 'GET') {
    assert.ok(submit && method === 'POST' && posts === 0, 'Only one job submission is authorized');
    assert.ok(new URL(url).pathname.endsWith('/public/api/projects/FCR_010/jobs/'));
    assert.deepEqual(JSON.parse(init.body), { type: 'NON_RECURSIVE_FORCED_BUILD', refreshHiveMetastore: false,
      autoUpdateSchemaBeforeEachRecipeRun: false, outputs: [{ type: 'DATASET', id: dataset, projectKey: project, partition: null }] });
    posts++;
  }
  return originalFetch(url, init);
};
const client = new DataikuClient({ readOnly: !submit });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  const datasets = await client.listDatasets(project), recipes = await client.listRecipes(project);
  const fingerprints = {};
  for (const d of datasets) fingerprints['dataset:' + d.name] = hash(d);
  for (const r of recipes) fingerprints['recipe:' + r.name] = hash((await client.getRecipeInfo(project, r.name)).raw);
  return fingerprints;
}
let report;
if (submit) {
  const before = await snapshot();
  const dry = await client.runRecipe({ project_key: project, recipe_name: recipe, dry_run: true });
  assert.equal(dry.writes, 0); assert.equal(dry.dataset_name, dataset); assert.equal(posts, 0);
  report = { project, dataset, recipe, before, dry_run: dry, writes: 0, submission_attempted: true };
  // Persist an intent marker before POST so an ambiguous network error cannot trigger a second build.
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const job = await client.buildDataset({ project_key: project, dataset_name: dataset, mode: 'NON_RECURSIVE_FORCED_BUILD', wait: false });
  report.job = job; report.writes = posts;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ job, job_submissions: posts }));
} else report = JSON.parse(readFileSync(reportPath, 'utf8'));
assert.ok(report.job?.job_id, 'Submission outcome unknown; inspect DSS jobs manually, do not rerun --submit');
report.job = await client.waitForJob({ project_key: project, job_id: report.job.job_id, timeout_seconds: 45 });
report.job_details = await client.getJobDetails(project, report.job.job_id);
report.after = await snapshot();
report.changed_objects = [...new Set([...Object.keys(report.before), ...Object.keys(report.after)])].filter(k => report.before[k] !== report.after[k]);
report.activities = Object.values(report.job_details.baseStatus.activities ?? {}).map(a => ({ activity_id: a.activityId,
  recipe: a.recipeName, state: a.state, targets: a.targets?.map(t => t.id) }));
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ job: report.job, changed_objects: report.changed_objects, activities: report.activities }, null, 2));
