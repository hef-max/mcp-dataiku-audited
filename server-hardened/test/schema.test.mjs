import test from 'node:test';
import assert from 'node:assert/strict';
import { SchemaService } from '../dist/schema-service.js';
const requested = { columns: [{ name: 'id', type: 'string' }, { name: 'entity_id', type: 'string' }] };
const request = { project_key: 'TEST', dataset_name: 'out', schema: requested };
function fixture({ mismatch = false, failure = false, concurrent = false, bookkeeping = false, metadataChange = false } = {}) {
  let settings = { name: 'out', type: 'S3', managed: true, params: { connection: 'storage', path: '/out', bucket: 'bucket' },
    formatType: 'csv', formatParams: { compress: 'gz' }, partitioning: { dimensions: [] }, metrics: { probes: [] },
    tags: ['keep'], customMeta: { x: 'keep' }, versionTag: { versionNumber: 1 }, schema: { columns: [{ name: 'id', type: 'string' }] } };
  const before = structuredClone(settings), calls = []; let reads = 0;
  const http = {
    async get(path) {
      calls.push({ method: 'GET', path });
      if (path === '/projects/TEST') return { data: {} };
      if (concurrent && ++reads > 1) settings.params.path = '/other';
      return { data: structuredClone(path.endsWith('/schema') ? settings.schema : settings) };
    },
    async put(path, body) {
      calls.push({ method: 'PUT', path, body: structuredClone(body) });
      assert.equal(path, '/projects/TEST/datasets/out/schema');
      if (failure) throw new Error('DSS rejected schema');
      if (!mismatch) settings.schema = structuredClone(body);
      if (bookkeeping) { settings.typeSystemVersion = 'V2'; settings.smartName = 'out'; }
      if (metadataChange) settings.metrics.probes.push({ changed: true });
      settings.versionTag.versionNumber++; return { data: null };
    },
  };
  return { service: new SchemaService(http), calls, before, current: () => settings };
}
test('schema dry-run returns diff and uses GET only', async () => {
  const f = fixture(); const r = await f.service.update({ ...request, dry_run: true });
  assert.equal(r.writes, 0); assert.deepEqual(r.diff.added, [requested.columns[1]]);
  assert.ok(f.calls.every(c => c.method === 'GET')); assert.deepEqual(f.current(), f.before);
});
test('schema update preserves all non-schema settings, verifies read-back and never touches recipe/data', async () => {
  const f = fixture(); const result = await f.service.update(request);
  assert.deepEqual(result.schema_after, requested); assert.equal(result.verified, true); assert.equal(result.writes, 1);
  const { schema, versionTag, ...rest } = f.current(); void schema; void versionTag;
  const { schema: oldSchema, versionTag: oldVersion, ...old } = f.before; void oldSchema; void oldVersion;
  assert.deepEqual(rest, old);
  assert.ok(f.calls.every(c => c.method === 'GET' || c.method === 'PUT' && c.path.endsWith('/schema')));
  assert.ok(!f.calls.some(c => /recipes|jobs|\/data\//.test(c.path)));
});
test('no supplied schema and matching schema are idempotent GET-only no-ops', async () => {
  const f = fixture(); await f.service.update({ project_key: 'TEST', dataset_name: 'out' });
  await f.service.update({ ...request, schema: f.before.schema });
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
for (const columns of [[{ name: 'id', type: 'string' }, { name: 'id', type: 'int' }], [{ name: 'x', type: 'wrong' }]]) test('duplicate/invalid column type rejected before any HTTP', async () => {
  const f = fixture(); await assert.rejects(f.service.update({ ...request, schema: { columns } })); assert.equal(f.calls.length, 0);
});
test('schema read-back mismatch reports requested and actual, with no destructive rollback', async () => {
  const f = fixture({ mismatch: true }); await assert.rejects(f.service.update(request), error => {
    assert.match(error.message, /read-back mismatch/); assert.match(error.message, /requested_schema/); assert.match(error.message, /actual/); return true;
  });
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
});
test('failed PUT retains data/settings and does not retry, delete or build', async () => {
  const f = fixture({ failure: true }); await assert.rejects(f.service.update(request), /DSS rejected schema/);
  assert.deepEqual(f.current(), f.before); assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
});
test('concurrent settings change blocks schema PUT', async () => {
  const f = fixture({ concurrent: true }); await assert.rejects(f.service.update(request), /changed during preflight/);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('DSS schema bookkeeping updates do not invalidate a verified schema', async () => {
  const f = fixture({ bookkeeping: true }); const result = await f.service.update(request);
  assert.equal(result.verified, true); assert.equal(result.storage_settings_preserved, true);
});
test('protected metadata change names the affected field and triggers no rollback write', async () => {
  const f = fixture({ metadataChange: true }); await assert.rejects(f.service.update(request), /Protected settings changed.*metrics/);
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 1);
});
