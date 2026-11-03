import { defaultFlowRead } from './default-flow-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatasetService } from '../dist/dataset-service.js';
import { RecipeService } from '../dist/recipe-service.js';
import { SecureHttpClient } from '../dist/dataiku-client.js';

const schema = { columns: [{ name: 'entity_id', type: 'string' }, { name: 'evidence_date', type: 'dateonly' }] };
const request = { dry_run: false, project_key: 'TEST', dataset_name: 'new_out', clone_settings_from: 'source', path: '/data/new_out', schema };
function fixture(options = {}) {
  const datasets = new Map([['source', { name: 'source', projectKey: 'TEST', type: 'S3', managed: true,
    params: { connection: 'storage', bucket: 'test-bucket', path: '/data/source', metastoreTableName: 'source', metastoreSynchronizationEnabled: true },
    formatType: 'csv', formatParams: { compress: 'gz', separator: '\t' }, schema: { columns: [{ name: 'old', type: 'int' }] },
    partitioning: { dimensions: [], ignoreNonMatchingFile: false }, readWriteOptions: { preserveOrder: false },
    tags: ['private'], creationTag: { versionNumber: 1 }, metrics: { history: 'never-copy' } }],
    ['existing', { name: 'existing', type: 'S3', params: { connection: 'storage', bucket: 'test-bucket', path: '/data/existing' }, schema }]]);
  const calls = []; let envelope;
  const zones = [{ id: 'default', name: 'Bronze', items: [] }, { id: 'silver', name: 'Silver', items: [] }];
  const http = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (options.zones && path.endsWith('/flow/zones')) return { data: structuredClone(zones) };
      if (options.zones && path.endsWith('/flow/graph/')) {
        const nodes = Object.fromEntries([...datasets.keys()].map(name => [name, { ref: name, fullId: `TEST.${name}`, type: 'COMPUTABLE_DATASET', predecessors: [], successors: [] }]));
        if (envelope) {
          const recipe = envelope.recipe;
          const inputs = recipe.inputs.main.items.map(i => i.ref), outputs = recipe.outputs.main.items.map(i => i.ref);
          nodes.recipe = { ref: 'recipe', fullId: 'TEST.recipe', type: 'RUNNABLE_RECIPE', predecessors: inputs, successors: outputs };
          for (const name of outputs) nodes[name].predecessors = ['recipe'];
          for (const name of inputs) nodes[name].successors = ['recipe'];
        }
        return { data: { nodes } };
      }
      const flow = defaultFlowRead(path); if (flow) return flow;
      if (path === '/projects/TEST') return { data: {} };
      if (path === '/projects/') return { data: [{ projectKey: 'TEST' }, ...(options.remote ? [{ projectKey: 'OTHER' }] : [])] };
      if (path === '/projects/OTHER/datasets/') return { data: options.remote };
      if (path === '/connections/get-names?type=all') return { data: ['storage', 'filesystem'] };
      if (path === '/projects/TEST/datasets/') return { data: [...datasets.values()].map(value => structuredClone(value)) };
      if (path === '/projects/TEST/recipes/') return { data: options.owner ? [{ name: 'owner', outputs: { main: { items: [{ ref: 'new_out' }] } } }] : envelope ? [envelope.recipe] : [] };
      if (path === '/projects/TEST/recipes/recipe') return { data: structuredClone(envelope) };
      if (path.endsWith('/finish-streaming/')) return { data: null };
      if (path.endsWith('/data/')) {
        if (options.unknownData) throw new Error('Cannot read missing storage');
        return { data: { complete: true, rows: options.nonempty ? [['1']] : [] } };
      }
      const name = path.split('/')[4];
      if (!datasets.has(name)) throw new Error('Missing dataset ' + name);
      return { data: structuredClone(path.endsWith('/schema') ? datasets.get(name).schema : datasets.get(name)) };
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body: structuredClone(body) });
      if (path.includes('/flow/zones/')) {
        const target = path.split('/')[5];
        for (const item of body) {
          for (const z of zones) z.items = z.items.filter(i => i.objectId !== item.objectId || i.objectType !== item.objectType);
          zones.find(z => z.id === target).items.push(item);
        }
        if (options.zoneFailure && target === 'silver') throw new Error('Zone assignment failed');
        return { data: null };
      }
      if (path.endsWith('/datasets/')) {
        if (options.datasetFailure) throw new Error('DSS dataset failed');
        datasets.set(body.name, { ...structuredClone(body), creationTag: options.noTag ? undefined : { versionNumber: 17, timestamp: 123 }, versionTag: { versionNumber: 1 } });
        return { data: null };
      }
      assert.ok(path.endsWith('/recipes/'), 'No builds or jobs allowed');
      if (options.recipeFailure) {
        if (options.ownerAfterFailure) options.owner = true;
        if (options.partitionedAfterFailure) datasets.get('new_out').partitioning = { dimensions: [{ name: 'date' }] };
        throw new Error('DSS recipe failed');
      }
      envelope = { recipe: body.recipePrototype, payload: body.creationSettings.payload ?? '{}' };
      if (options.resetSchemaOnRecipe) datasets.get('new_out').schema = structuredClone(datasets.get('source').schema);
      return { data: { name: 'recipe' } };
    },
    async put(path, body) {
      calls.push({ method: 'PUT', path, body: structuredClone(body) });
      if (path.endsWith('/recipes/recipe')) envelope = structuredClone(body);
      else if (path.endsWith('/schema')) {
        if (options.failFinalSchema) throw new Error('Final schema rejected');
        datasets.get('new_out').schema = structuredClone(body);
      } else datasets.set(body.name, structuredClone(body));
      return { data: null };
    },
    async delete(path) { calls.push({ method: 'DELETE', path }); assert.ok(path.endsWith('?dropData=false')); datasets.delete(path.split('/')[4].split('?')[0]); return { data: null }; },
  };
  return { service: new DatasetService(http), recipes: new RecipeService(http), calls, datasets, zones };
}
test('managed clone dry-run is GET only and excludes source identity/history', async () => {
  const f = fixture(); const result = await f.service.create({ ...request, dry_run: true });
  assert.equal(result.writes, 0); assert.ok(f.calls.every(c => c.method === 'GET'));
  const b = result.creation_request;
  assert.deepEqual(b.schema, schema); assert.equal(b.params.path, request.path); assert.equal(b.formatParams.compress, 'gz');
  assert.equal(b.managed, true); assert.equal(b.type, 'S3'); assert.equal(b.params.bucket, 'test-bucket');
  for (const key of ['creationTag', 'versionTag', 'metrics', 'tags']) assert.equal(b[key], undefined);
  assert.equal(b.params.metastoreTableName, undefined);
  assert.deepEqual(result.post_create_settings.partitioning.dimensions, []);
});
test('clone provisioning applies settings by GET/PUT and never builds', async () => {
  const f = fixture(); const result = await f.service.create(request);
  assert.equal(result.executed, false); assert.deepEqual(f.datasets.get('new_out').schema, schema);
  assert.equal(f.datasets.get('new_out').readWriteOptions.preserveOrder, false);
  assert.deepEqual(f.calls.filter(c => c.method !== 'GET').map(c => c.method), ['POST', 'PUT']);
  assert.ok(f.calls.every(c => !/build|jobs|run/.test(c.path)));
});
for (const type of ['S3', 'Filesystem']) test(`explicit managed ${type} creation`, async () => {
  const f = fixture(); await f.service.create({ dry_run: false, project_key: 'TEST', dataset_name: 'new_out', dataset_type: type,
    connection: type === 'S3' ? 'storage' : 'filesystem', path: '/explicit/output', format_type: 'csv',
    ...(type === 'S3' ? { bucket: 'test-bucket' } : {}), schema });
  assert.equal(f.datasets.get('new_out').type, type);
});
for (const [name, changes, pattern] of [
  ['duplicate name', { dataset_name: 'existing' }, /name conflict/],
  ['source path', { path: '/data/source/' }, /path conflicts/],
  ['other path', { path: '/data/existing/child' }, /path conflict/],
  ['missing source', { clone_settings_from: 'missing' }, /Missing source/],
  ['invalid connection', { connection: 'invalid' }, /Invalid or inaccessible connection/],
  ['missing path', { path: undefined }, /explicit path/],
  ['traversal', { path: '/data/../source' }, /traversal/],
  ['duplicate columns', { schema: { columns: [{ name: 'x', type: 'string' }, { name: 'x', type: 'int' }] } }, /unique/],
]) test(`${name} rejected before writes`, async () => {
  const f = fixture(); await assert.rejects(f.service.create({ ...request, ...changes }), pattern);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
const recipe = outputs => ({ project_key: 'TEST', recipe_name: 'recipe', dry_run: false, recipe_type: 'python', inputs: ['source'], outputs, code: 'print(1)' });
const output = { name: 'new_out', new: true, clone_settings_from: 'source', path: '/data/new_out', schema };
test('recipe existing unowned output needs no provisioning', async () => {
  const f = fixture(); await f.recipes.create(recipe([{ name: 'existing' }]));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
test('recipe provisions new output before creating recipe', async () => {
  const f = fixture(); const result = await f.recipes.create(recipe([output]));
  assert.equal(result.schema_applied, true);
  assert.deepEqual(result.provisioned_outputs, [{ name: 'new_out', schema_applied: true }]);
  assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['/projects/TEST/datasets/', '/projects/TEST/recipes/']);
});
test('recipe dry-run includes output plan with zero writes', async () => {
  const f = fixture(); const result = await f.recipes.create({ ...recipe([output]), dry_run: true });
  assert.equal(result.output_provisioning.length, 1); assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('failed output provisioning never creates recipe or deletes unknown dataset', async () => {
  const f = fixture({ datasetFailure: true }); await assert.rejects(f.recipes.create(recipe([output])), /DSS dataset failed/);
  assert.ok(!f.calls.some(c => c.method === 'DELETE' || c.method === 'POST' && c.path.endsWith('/recipes/')));
});
test('failed recipe rolls back confirmed empty newly-created output metadata only', async () => {
  const f = fixture({ recipeFailure: true }); await assert.rejects(f.recipes.create(recipe([output])), /DSS recipe failed/);
  assert.ok(f.calls.some(c => c.method === 'DELETE' && c.path.endsWith('new_out?dropData=false')));
  assert.ok(f.datasets.has('source')); assert.ok(f.datasets.has('existing'));
});
for (const option of ['nonempty', 'unknownData', 'noTag', 'ownerAfterFailure', 'partitionedAfterFailure']) test(`rollback retains dataset when ${option}`, async () => {
  const f = fixture({ recipeFailure: true, [option]: true }); await assert.rejects(f.recipes.create(recipe([output])));
  assert.ok(!f.calls.some(c => c.method === 'DELETE')); assert.ok(f.datasets.has('new_out'));
});
test('multiple output path conflict prevents every write', async () => {
  const f = fixture(); await assert.rejects(f.recipes.create(recipe([output, { ...output, name: 'second' }])), /overlapping storage/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
for (const [kind, body] of [['JSON', JSON.stringify({ errorType: 'InvalidDataset', message: 'Missing format', apiKey: 'secret-test-value', nested: { password: 'other-secret' } })],
  ['text', 'Missing format. Authorization: Bearer secret-test-value password=other-secret']]) test(`HTTP400 ${kind} body is diagnostic and sanitized`, async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 400 }));
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'secret-test-value');
  await assert.rejects(http.post('/projects/TEST/datasets/', {}), error => {
    assert.equal(error.details.status, 400); assert.equal(error.details.method, 'POST');
    assert.equal(error.details.endpoint, '/projects/TEST/datasets/'); assert.match(error.message, /Missing format/);
    assert.ok(!error.message.includes('secret-test-value')); assert.ok(!error.message.includes('other-secret')); return true;
  });
});
test('readonly HTTP client prevents POST before fetch', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch'); });
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'test', true);
  await assert.rejects(http.post('/projects/TEST/datasets/', {}), /Read-only/); assert.equal(fetch.mock.callCount(), 0);
});
test('create shaker reapplies explicit schema after recipe creation resets it and after saving visual config', async () => {
  const f = fixture({ resetSchemaOnRecipe: true });
  const desired = { columns: [{ name: 'old', type: 'int' }, { name: 'entity_id', type: 'string' }] };
  const r = await f.recipes.create({ ...recipe([{ ...output, schema: desired }]), code: undefined, recipe_type: 'shaker',
    config: { kind: 'shaker', steps: [{ op: 'compute', column: 'entity_id', expression: '"INVESTOR"' }] } });
  assert.deepEqual(f.datasets.get('new_out').schema, desired); assert.equal(r.schema_applied, true);
  const recipePut = f.calls.findIndex(c => c.method === 'PUT' && c.path.endsWith('/recipes/recipe'));
  const schemaPut = f.calls.findIndex(c => c.method === 'PUT' && c.path.endsWith('/schema'));
  assert.ok(schemaPut > recipePut && recipePut > 0);
  assert.ok(!f.calls.some(c => /jobs|build|\/data\//.test(c.path)));
});
test('final schema failure preserves the created recipe and its owned output', async () => {
  const f = fixture({ resetSchemaOnRecipe: true, failFinalSchema: true });
  await assert.rejects(f.recipes.create(recipe([output])), /Final schema rejected/);
  assert.ok(f.datasets.has('new_out')); assert.ok(!f.calls.some(c => c.method === 'DELETE'));
});
test('oversized HTTP error is bounded and omitted', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('secret-test-value'.repeat(10000), { status: 400 }));
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'secret-test-value');
  await assert.rejects(http.post('/projects/TEST/datasets/', {}), error => {
    assert.match(error.message, /omitted/); assert.ok(!error.message.includes('secret-test-value')); return true;
  });
});

test('existing clone projectKey placeholder resolves, literal new path remains allowed; no writes', async () => {
  const f = fixture(); f.datasets.get('source').params.path = '/data/${projectKey}/source';
  const result = await f.service.create({ ...request, path: '/data/TEST/new_out', dry_run: true });
  assert.equal(result.creation_request.params.path, '/data/TEST/new_out');
  assert.ok(f.calls.every(c => c.method === 'GET'));
  assert.equal(f.datasets.get('source').params.path, '/data/${projectKey}/source');
});
for (const path of ['/data/TEST/source', '/data/TEST/source/child', '/data/TEST']) test(`expanded clone overlap blocks ${path}`, async () => {
  const f = fixture(); f.datasets.get('source').params.path = '/data/${projectKey}/source';
  await assert.rejects(f.service.create({ ...request, path, dry_run: true }), /conflicts with clone source/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('remote inventory uses its owner project, not the requested project', async () => {
  const remote = [{ name: 'remote', type: 'S3', params: { bucket: 'test-bucket', path: '/data/${projectKey}/remote' } }];
  const f = fixture({ remote });
  await f.service.create({ ...request, path: '/data/TEST/remote', dry_run: true });
  await assert.rejects(f.service.create({ ...request, path: '/data/OTHER/remote/child', dry_run: true }), /Storage path conflict with dataset OTHER.remote/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
for (const path of ['/data/${projectKey}/new_out', '/data/$CUSTOM/new_out']) test('new user path variables remain prohibited', async () => {
  const f = fixture(); await assert.rejects(f.service.create({ ...request, path, dry_run: true }), /literal storage path/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('unknown existing variable fails closed with existing-path diagnostic', async () => {
  const f = fixture(); f.datasets.get('existing').params.path = '/data/${unknown}/existing';
  await assert.rejects(f.service.create({ ...request, dry_run: true }), /Unresolved variable in existing dataset path/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('create dataset resolves target and verifies native zone assignment', async () => {
  const f = fixture({ zones: true }); const result = await f.service.create({ ...request, zone_name: 'Silver' });
  assert.equal(result.assigned_zone.zone_id, 'silver');
  assert.equal(f.zones[1].items.length, 1);
});
test('create recipe places recipe and new output together without moving input', async () => {
  const f = fixture({ zones: true }); const result = await f.recipes.create({ ...recipe([output]), zone_id: 'silver' });
  assert.equal(result.assigned_zones.length, 2); assert.ok(result.assigned_zones.every(z => z.zone_id === 'silver'));
  const moves = f.calls.filter(c => c.path.includes('/add-items'));
  assert.equal(moves.length, 1); assert.deepEqual(moves[0].body.map(i => i.objectId).sort(), ['new_out', 'recipe']);
  assert.ok(!f.zones[1].items.some(i => i.objectId === 'source'));
});
test('existing output requires explicit move flag before any provisioning', async () => {
  const f = fixture({ zones: true }); const r = { ...recipe([{ name: 'existing' }]), zone_name: 'Silver' };
  await assert.rejects(f.recipes.create(r), /move_existing_outputs/); assert.ok(f.calls.every(c => c.method === 'GET'));
  const result = await f.recipes.create({ ...r, move_existing_outputs: true });
  assert.ok(result.assigned_zones.every(z => z.zone_id === 'silver'));
});
for (const tool of ['service', 'recipes']) test(`${tool} invalid target fails before provisioning`, async () => {
  const f = fixture({ zones: true }); await assert.rejects(f[tool].create({ ...(tool === 'service' ? request : recipe([output])), zone_id: 'missing' }), /missing or ambiguous/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('create defaults GET-only and reports proposed zone for dataset and recipe', async () => {
  const f = fixture({ zones: true });
  const dataset = await f.service.create({ ...request, dry_run: undefined, zone_name: 'Silver' });
  const result = await f.recipes.create({ ...recipe([output]), dry_run: undefined, zone_name: 'Silver' });
  assert.equal(dataset.writes, 0); assert.equal(result.writes, 0);
  assert.equal(dataset.proposed_zone_assignment.zone_id, 'silver'); assert.deepEqual(result.proposed_zone_assignment.new_outputs, ['new_out']);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('legacy create without zone leaves assignment unchanged and returns actual zone', async () => {
  const f = fixture({ zones: true }); const result = await f.recipes.create(recipe([output]));
  assert.ok(result.assigned_zones.every(z => z.zone_id === 'default'));
  assert.ok(!f.calls.some(c => c.path.includes('/add-items')));
});
test('failed zone assignment cleans only confirmed empty unreferenced new dataset metadata', async () => {
  const f = fixture({ zones: true, zoneFailure: true });
  await assert.rejects(f.service.create({ ...request, zone_id: 'silver' }), e => {
    assert.equal(JSON.parse(e.message).rollback[0].rolled_back, true); return true;
  });
  assert.ok(f.datasets.has('source')); assert.ok(f.datasets.has('existing')); assert.ok(!f.datasets.has('new_out'));
  assert.deepEqual(f.calls.filter(c => c.method === 'DELETE').map(c => c.path), ['/projects/TEST/datasets/new_out?dropData=false']);
});
test('failed zone assignment retains new recipe and referenced outputs when deletion safety cannot be established', async () => {
  const f = fixture({ zones: true, zoneFailure: true });
  await assert.rejects(f.recipes.create({ ...recipe([output]), zone_id: 'silver' }), e => {
    const detail = JSON.parse(e.message); assert.equal(detail.recipe_retained, true); assert.equal(detail.rollback[0].rolled_back, false); return true;
  });
  assert.ok(!f.calls.some(c => c.method === 'DELETE')); assert.ok(f.datasets.has('new_out'));
});
