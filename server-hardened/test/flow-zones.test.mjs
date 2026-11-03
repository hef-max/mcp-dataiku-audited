import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowZoneService, listZonesSchema, objectZoneSchema, moveFlowSchema, flowSchema } from '../dist/flow-zone.js';
import { createRecipeSchema } from '../dist/recipe-config.js';
import { createDatasetSchema } from '../dist/dataset-config.js';
import { DataikuClient, SecureHttpClient } from '../dist/dataiku-client.js';
const clone = structuredClone;
const items = [{ object_type: 'recipe', object_id: 'prepare' }, { object_type: 'dataset', object_id: 'output' }];
const request = { project_key: 'TEST', target_zone_id: 'silver', items };
function fixture(options = {}) {
  const zones = [{ id: 'default', name: 'Bronze', items: [] }, { id: 'silver', name: 'Silver', items: [], shared: [{ objectType: 'DATASET', objectId: 'source' }] },
    { id: 'third', name: options.ambiguous ? 'Silver' : 'Other', items: [] }];
  const node = (name, type, predecessors = [], successors = []) => ({ ref: name, fullId: `TEST.${name}`, type, predecessors, successors });
  const graph = { nodes: { source: node('source', 'COMPUTABLE_DATASET', [], ['prepare']),
    prepare: node('prepare', 'RUNNABLE_RECIPE', ['source'], ['output']), output: node('output', 'COMPUTABLE_DATASET', ['prepare']),
    'REMOTE.source': { ...node('source', 'COMPUTABLE_DATASET'), fullId: 'REMOTE.source' } } };
  const calls = [];
  function assign(zone, refs) {
    for (const ref of refs) {
      for (const z of zones) z.items = z.items.filter(i => JSON.stringify(i) !== JSON.stringify(ref));
      zones.find(z => z.id === zone).items.push(clone(ref));
    }
  }
  const http = {
    async get(path) { calls.push({ method: 'GET', path });
      if (path === '/projects/TEST/flow/zones') return { data: clone(zones) };
      assert.equal(path, '/projects/TEST/flow/graph/'); return { data: clone(graph) };
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body: clone(body) });
      const zone = path.match(/\/zones\/(\w+)\/add-items$/)?.[1]; assert.ok(zone);
      assign(zone, options.partial && zone === 'silver' ? body.slice(0, 1) : body);
      if (options.collateral && zone === 'silver') assign(zone, [{ objectId: 'source', objectType: 'DATASET' }]);
      if (options.partial && zone === 'silver') throw new Error('Partial DSS failure');
      return { data: null };
    },
  };
  return { service: new FlowZoneService(http), calls, zones, graph, assign };
}
test('strict Flow schemas and scoped dry-run defaults', () => {
  assert.equal(moveFlowSchema.parse(request).dry_run, true);
  assert.equal(flowSchema.parse({ project_key: 'TEST' }).max_objects, 2000);
  assert.throws(() => listZonesSchema.parse({ project_key: 'TEST', surprise: true }));
  assert.throws(() => objectZoneSchema.parse({ project_key: 'TEST', object_id: 'source' }));
  assert.throws(() => moveFlowSchema.parse({ ...request, items: [] }));
  const recipe = { project_key: 'TEST', recipe_name: 'r', recipe_type: 'python', inputs: ['source'], outputs: [{ name: 'output' }], code: 'pass' };
  const dataset = { project_key: 'TEST', dataset_name: 'd', path: '/new', clone_settings_from: 'source' };
  assert.equal(createRecipeSchema.parse(recipe).dry_run, true); assert.equal(createDatasetSchema.parse(dataset).dry_run, true);
  for (const [schema, value] of [[createRecipeSchema, recipe], [createDatasetSchema, dataset]]) assert.throws(() => schema.parse({ ...value, zone_id: 'silver', zone_name: 'Silver' }));
});
test('zones include implicit default counts and ignore shared visibility', async () => {
  const f = fixture(), result = await f.service.list({ project_key: 'TEST' });
  assert.deepEqual(result.zones[0].object_counts, { datasets: 3, recipes: 1, other: 0 });
  assert.equal(result.zones[0].is_default, true); assert.equal(result.zones[1].object_counts.datasets, 0);
});
test('resolve exact zone ID/name and reject missing/case mismatch/ambiguous', async () => {
  const f = fixture();
  for (const selector of [{ zone_id: 'silver' }, { zone_name: 'Silver' }]) assert.equal((await f.service.resolve('TEST', selector)).zone_id, 'silver');
  for (const selector of [{ zone_name: 'silver' }, { zone_id: 'absent' }]) await assert.rejects(f.service.resolve('TEST', selector), /missing or ambiguous/);
  await assert.rejects(fixture({ ambiguous: true }).service.resolve('TEST', { zone_name: 'Silver' }), /ambiguous/);
});
test('typed object lookup distinguishes local/foreign dataset and recipe', async () => {
  const f = fixture(); f.assign('silver', [{ objectId: 'source', objectType: 'DATASET', projectKey: 'REMOTE' }]);
  for (const [type, name, expected] of [['dataset', 'source', 'default'], ['dataset', 'REMOTE.source', 'silver'], ['recipe', 'prepare', 'default']]) {
    const result = await f.service.object({ project_key: 'TEST', object_type: type, object_id: name });
    assert.equal(result.zone_id, expected); assert.equal(result.verified, true);
  }
  await assert.rejects(f.service.object({ project_key: 'TEST', object_type: 'recipe', object_id: 'source' }), /missing/);
});
test('dry-run lists missing/unsupported/related conflicts with zero writes', async () => {
  const f = fixture(), plan = await f.service.move({ ...request, items: [items[1], { object_type: 'dataset', object_id: 'absent' }, { object_type: 'unknown', object_id: 'source' }] });
  assert.equal(plan.writes, 0); assert.equal(plan.conflicts.length, 3); assert.equal(plan.proposed_diff[0].source_zone_id, 'default');
  assert.ok(f.calls.every(c => c.method === 'GET'));
  await assert.rejects(f.service.move({ ...request, items: [items[1]], dry_run: false }), /preflight/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('batch move uses official smartrefs and verifies all ownership, leaving input unchanged', async () => {
  const f = fixture(), result = await f.service.move({ ...request, dry_run: false });
  assert.equal(result.writes, 1); assert.equal(result.verified, true); assert.equal(result.atomic, false);
  assert.deepEqual(f.calls.find(c => c.method === 'POST'), { method: 'POST', path: '/projects/TEST/flow/zones/silver/add-items',
    body: [{ objectId: 'prepare', objectType: 'RECIPE' }, { objectId: 'output', objectType: 'DATASET' }] });
  assert.equal((await f.service.object({ project_key: 'TEST', object_type: 'dataset', object_id: 'source' })).zone_id, 'default');
});
for (const flag of ['partial', 'collateral']) test(`${flag} failure compensates and verifies original assignments`, async () => {
  const f = fixture({ [flag]: true });
  await assert.rejects(f.service.move({ ...request, dry_run: false }), e => {
    const details = JSON.parse(e.message); assert.equal(details.rollback.verified, true); assert.equal(details.writes, 2); return true;
  });
  const snapshot = await f.service.snapshot('TEST'); assert.ok(snapshot.objects.every(o => o.zone_id === 'default'));
});
test('graph uses official route, supplies edges/zones and enforces response bound', async () => {
  const f = fixture(), detail = await f.service.flow({ project_key: 'TEST' });
  assert.equal(detail.edges.length, 2); assert.equal(detail.datasets.length, 3); assert.equal(detail.recipes[0].zone_id, 'default');
  const summary = await f.service.flow({ project_key: 'TEST', detail: 'summary', max_objects: 1 });
  assert.equal(summary.truncated, true); assert.equal(summary.datasets.length, 1); assert.deepEqual(summary.edges, []);
  assert.ok(f.calls.every(c => c.path.endsWith('/zones') || c.path.endsWith('/graph/')));
});
for (const contentType of ['application/zip', 'application/octet-stream', 'text/plain']) test(`binary export rejected for ${contentType}`, async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('PK\x03\x04secret archive', { headers: { 'content-type': contentType } }));
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'secret');
  await assert.rejects(http.get('/projects/TEST/export'), e => { assert.ok(!e.message.includes('secret archive')); return /binary|ZIP|archive/i.test(e.message); });
});
test('export JSON is an explicitly labeled read-only Flow snapshot, never an archive', async () => {
  const c = new DataikuClient({ host: 'https://example.invalid', apiKey: 'secret', readOnly: true });
  c.getProjectFlow = async () => ({ zones: [] });
  const result = await c.exportProjectConfig('TEST'); assert.equal(result.archive_included, false); assert.equal(result.export_kind, 'flow_configuration_snapshot');
});
for (const contentType of ['application/zip', 'text/plain']) test(`failed binary response preserves HTTP context without raw content (${contentType})`, async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('PK\x03\x04private-archive-content', { status: 500, headers: { 'content-type': contentType } }));
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'secret');
  await assert.rejects(http.get('/projects/TEST/flow/graph/'), e => {
    assert.equal(e.details.status, 500); assert.equal(e.details.method, 'GET'); assert.equal(e.details.endpoint, '/projects/TEST/flow/graph/');
    assert.ok(!e.message.includes('private-archive-content')); return true;
  });
});
test('Flow HTTP errors retain sanitized DSS diagnostics', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'Authorization: Bearer secret', cookie: 'session-private', connectionSecret: 'connection-private' }), { status: 403, headers: { 'content-type': 'application/json' } }));
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'secret');
  await assert.rejects(new FlowZoneService(http).list({ project_key: 'TEST' }), e => {
    assert.equal(e.details.status, 403); assert.equal(e.details.endpoint, '/projects/TEST/flow/zones');
    for (const secret of ['Bearer secret', 'session-private', 'connection-private']) assert.ok(!e.message.includes(secret)); return true;
  });
});
