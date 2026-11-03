import test from 'node:test';
import assert from 'node:assert/strict';
import { JobService } from '../dist/job-service.js';
import { SecureHttpClient } from '../dist/dataiku-client.js';

const request = { project_key: 'TEST', dataset_name: 'out' };
function fixture({ states = ['DONE'], producer = true, missing = false, multiple = false, type = 'python', postFailure = false } = {}) {
  const calls = []; let now = 0, index = 0;
  const outputs = { main: { items: [{ ref: 'out' }, ...(multiple ? [{ ref: 'other' }] : [])] } };
  const recipe = { name: 'compute_out', type, outputs };
  const http = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path === '/projects/TEST') return { data: {} };
      if (path === '/projects/TEST/datasets/out') { if (missing) throw new Error('Dataset not found'); return { data: { name: 'out' } }; }
      if (path === '/projects/TEST/recipes/') return { data: producer ? [recipe] : [] };
      if (path === '/projects/TEST/recipes/compute_out') return { data: { recipe } };
      assert.equal(path, '/projects/TEST/jobs/job%3A123/');
      const state = states[Math.min(index++, states.length - 1)];
      return { data: { baseStatus: { state, def: { outputs: [{ targetDataset: 'out' }] }, jobStartTime: 1000,
        jobEndTime: state === 'RUNNING' ? 0 : 2000,
        activities: { activity: { state, errorMessage: 'Failure password=private-value' } } } } };
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body }); assert.equal(path, '/projects/TEST/jobs/');
      if (postFailure) throw new Error('Connection lost; unknown submission outcome');
      return { data: { id: 'job:123' } };
    },
    async getText(path) { calls.push({ method: 'GET', path }); return { data: 'Stacktrace\nAuthorization: Bearer api-secret\npassword=private-value\nfailed activity' }; },
  };
  return { service: new JobService(http, 'api-secret', { now: () => now, sleep: async ms => { now += ms; } }), calls, http };
}
test('dry-run build performs zero writes and matches official job builder body', async () => {
  const f = fixture(); const result = await f.service.build({ ...request, dry_run: true });
  assert.equal(result.writes, 0); assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.deepEqual(result.job_definition, { type: 'NON_RECURSIVE_FORCED_BUILD', refreshHiveMetastore: false,
    autoUpdateSchemaBeforeEachRecipeRun: false, outputs: [{ type: 'DATASET', id: 'out', projectKey: 'TEST', partition: null }] });
});
for (const type of ['python', 'shaker', 'join', 'grouping']) test(`build existing dataset from ${type} producer`, async () => {
  const f = fixture({ type }); const result = await f.service.build(request);
  assert.equal(result.job_id, 'job:123'); assert.equal(result.state, 'RUNNING');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('run recipe resolves its unique dataset output using job API', async () => {
  const f = fixture(); const result = await f.service.runRecipe({ project_key: 'TEST', recipe_name: 'compute_out' });
  assert.equal(result.dataset_name, 'out'); assert.ok(f.calls.every(c => !c.path.includes('actions/build')));
});
for (const [option, pattern] of [['missing', /not found/], ['multiple', /multiple|ambiguous/]]) test(`${option} output rejected before job creation`, async () => {
  const f = fixture({ [option]: true }); await assert.rejects(f.service.build(request), pattern);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('dataset without producer rejected', async () => {
  const f = fixture({ producer: false }); await assert.rejects(f.service.build(request), /no producer/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('job transitions to SUCCESS and exposes timestamps', async () => {
  const f = fixture({ states: ['RUNNING', 'DONE'] }); const result = await f.service.build({ ...request, wait: true });
  assert.equal(result.state, 'SUCCESS'); assert.equal(result.finished_at, '1970-01-01T00:00:02.000Z');
});
for (const state of ['FAILED', 'ABORTED']) test(`${state} job includes sanitized activity error and log`, async () => {
  const f = fixture({ states: [state] }); const result = await f.service.build({ ...request, wait: true });
  assert.equal(result.state, state); assert.equal(result.error.activity_id, 'activity');
  assert.match(result.error.log_excerpt, /failed activity/);
  assert.ok(!JSON.stringify(result).includes('api-secret')); assert.ok(!JSON.stringify(result).includes('private-value'));
});
test('timeout retains job ID and RUNNING state, without abort/resubmit', async () => {
  const f = fixture({ states: ['RUNNING'] }); const result = await f.service.build({ ...request, wait: true, timeout_seconds: 1 });
  assert.equal(result.timed_out, true); assert.equal(result.state, 'RUNNING'); assert.equal(result.job_id, 'job:123');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('async mode does not poll', async () => {
  const f = fixture(); await f.service.build({ ...request, wait: false });
  assert.ok(!f.calls.some(c => c.method === 'GET' && c.path.includes('/jobs/')));
});
for (const mode of ['NON_RECURSIVE_FORCED_BUILD', 'RECURSIVE_FORCED_BUILD']) test(`explicit ${mode} mode sent unchanged`, async () => {
  const f = fixture(); await f.service.build({ ...request, mode });
  assert.equal(f.calls.find(c => c.method === 'POST').body.type, mode);
});
test('unknown legacy mode and partition are rejected locally', async () => {
  const f = fixture(); await assert.rejects(f.service.build({ ...request, mode: 'RECURSIVE_BUILD' }));
  await assert.rejects(f.service.build({ ...request, partition: '2026' })); assert.equal(f.calls.length, 0);
});
test('submission transport failure is never retried', async () => {
  const f = fixture({ postFailure: true }); await assert.rejects(f.service.build(request), /unknown submission/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('wait/status do not need in-memory build state', async () => {
  const f = fixture(); const result = await f.service.wait({ project_key: 'TEST', job_id: 'job:123' });
  assert.equal(result.state, 'SUCCESS'); assert.deepEqual(result.outputs, ['out']); assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('job details uses trailing slash and supports encoded IDs', async () => {
  const f = fixture(); await f.service.details({ project_key: 'TEST', job_id: 'job:123' });
  assert.equal(f.calls[0].path, '/projects/TEST/jobs/job%3A123/');
});
test('recipe without output is rejected before submission', async () => {
  const f = fixture(); f.http.get = async () => ({ data: { recipe: { outputs: {} } } });
  await assert.rejects(f.service.runRecipe({ project_key: 'TEST', recipe_name: 'compute_out' }), /exactly one/);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});
test('first status request timeout preserves ID without claiming FAILED', async () => {
  let now = 0;
  const service = new JobService({ get: async () => { now = 1000; throw new Error('Timed out'); }, post: async () => { throw new Error('No writes'); }, getText: async () => ({ data: '' }) }, '', { now: () => now, sleep: async () => {} });
  const result = await service.wait({ project_key: 'TEST', job_id: 'job:123', timeout_seconds: 1 });
  assert.equal(result.job_id, 'job:123'); assert.equal(result.timed_out, true); assert.equal(result.state, 'RUNNING');
});
test('plain text log transport and HTTP errors preserve sanitization', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => new Response(init.method === 'GET' ? 'ordinary log' : JSON.stringify({ message: 'Authorization: Bearer api-secret', apiKey: 'api-secret' }), { status: init.method === 'GET' ? 200 : 400 }));
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'api-secret');
  assert.equal((await http.getText('/projects/TEST/jobs/id/log')).data, 'ordinary log');
  await assert.rejects(http.post('/projects/TEST/jobs/', {}), error => {
    assert.equal(error.details.status, 400); assert.ok(!error.message.includes('api-secret')); return true;
  });
});
