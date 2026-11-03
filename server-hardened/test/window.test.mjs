import { defaultFlowRead } from './default-flow-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWindow, verifyWindow } from '../dist/window-config.js';
import { createRecipeSchema } from '../dist/recipe-config.js';
import { RecipeService } from '../dist/recipe-service.js';
import { SecureHttpClient } from '../dist/dataiku-client.js';
import { readFileSync } from 'node:fs';

const columns = [{ name: 'alert_record_key', type: 'string' }, { name: 'time_gap_seconds', type: 'bigint' },
  { name: 'trade_timestamp', type: 'date' }, { name: 'globaltransid', type: 'string' }];
const config = { kind: 'window', partition_by: ['alert_record_key'],
  order_by: columns.slice(1).map(c => ({ column: c.name, direction: 'ASC', nulls: 'LAST' })),
  functions: [{ function: 'row_number', alias: 'candidate_rank' }] };
const request = { dry_run: false, project_key: 'TEST', recipe_name: 'window', recipe_type: 'window', inputs: ['input'], outputs: [{ name: 'out' }], config };
test('adapter ranking names conform to retained native DSS evidence', () => {
  const evidence = JSON.parse(readFileSync(new URL('./fixtures/window-dss-evidence.json', import.meta.url)));
  const row = evidence.examples.find(e => e.rowNumber);
  assert.ok(row.outputColumnNameOverrides.rownumber);
  const dense = evidence.examples.find(e => e.denseRank);
  assert.ok(dense.observed_output_schema.some(c => c.name === 'denserank' && c.type === 'bigint'));
  assert.match(evidence.official_ui.computed_column_initialization, /expr:.*mode:"GREL"/);
});
const envelope = () => ({ recipe: { name: 'window', type: 'window', inputs: { main: { items: [{ ref: 'input' }] } },
  outputs: { main: { items: [{ ref: 'out' }] } } }, payload: '' });

function fixture({ mutate, invalid = false, schemaMismatch = false } = {}) {
  const calls = []; let recipe = envelope(), schema = { columns: [] };
  const http = {
    async get(path) {
      calls.push(['GET', path]);
      const flow = defaultFlowRead(path); if (flow) return flow;
      let data;
      if (path === '/projects/TEST') data = {};
      else if (path.endsWith('/datasets/')) data = ['input', 'out'].map(name => ({ name }));
      else if (path.endsWith('/recipes/')) data = [];
      else if (path.endsWith('/input/schema')) data = { columns };
      else if (path.endsWith('/out/schema')) data = schemaMismatch ? { columns: [] } : schema;
      else if (path.endsWith('/datasets/out')) data = { name: 'out', type: 'Filesystem', params: { path: '/out' }, schema };
      else if (path.endsWith('/recipes/window')) data = invalid ? null : recipe;
      else throw Error('Unexpected GET ' + path);
      return { data: structuredClone(data) };
    },
    async post(path, body) { calls.push(['POST', path]); assert.ok(path.endsWith('/recipes/')); recipe = { recipe: body.recipePrototype, payload: '' }; return { data: 'window' }; },
    async put(path, body) {
      calls.push(['PUT', path]);
      if (path.endsWith('/schema')) schema = structuredClone(body);
      else { recipe = structuredClone(body); if (mutate) mutate(recipe); }
      return { data: null };
    },
  };
  return { http, calls, service: new RecipeService(http) };
}

test('explicit row_number: native alias, bigint schema, multi-column order, hidden null keys', () => {
  const { payload: p, schema } = buildWindow(config, columns);
  assert.equal(p.rowNumber, true); assert.deepEqual(p.outputColumnNameOverrides, { rownumber: 'candidate_rank' });
  assert.deepEqual(schema.columns.at(-1), { name: 'candidate_rank', type: 'bigint' });
  assert.deepEqual(p.windows[0].partitioningColumns, ['alert_record_key']);
  assert.equal(p.windows[0].orders.length, 6);
  assert.deepEqual(p.windows[0].orders.filter((_, i) => i % 2), config.order_by.map(o => ({ column: o.column, desc: false })));
  assert.equal(p.computedColumns[0].expr, 'if(isBlank(val("time_gap_seconds")), 1, 0)');
  assert.ok(p.values.filter(v => v.column.startsWith('__mcp')).every(v => v.value === false));
  assert.equal(p.retrievedColumnsSelectionMode, 'EXPLICIT');
});
for (const direction of ['ASC', 'DESC']) for (const nulls of ['FIRST', 'LAST']) test(`${direction} NULLS ${nulls} preserves requested semantics`, () => {
  const p = buildWindow({ ...config, order_by: [{ column: 'globaltransid', direction, nulls }] }, columns).payload;
  assert.equal(p.windows[0].orders[0].desc, nulls === 'FIRST');
  assert.equal(p.windows[0].orders[1].desc, direction === 'DESC');
});
for (const fn of ['row_number', 'rank', 'dense_rank', 'min', 'max', 'first', 'last']) test(`native function ${fn}`, () => {
  const aggregate = ['min', 'max', 'first', 'last'].includes(fn);
  const p = buildWindow({ ...config, functions: [{ function: fn, alias: 'result', ...(aggregate ? { column: 'trade_timestamp' } : {}) }] }, columns);
  assert.equal(p.schema.columns.at(-1).type, aggregate ? 'date' : 'bigint');
  if (aggregate) assert.equal(p.payload.values.find(v => v.column === 'trade_timestamp')[fn], true);
});
for (const patch of [
  { partition_by: ['missing'] }, { order_by: [{ column: 'missing', direction: 'ASC' }] },
  { functions: [{ function: 'min', column: 'missing', alias: 'n' }] },
  { functions: [{ function: 'min', alias: 'n' }] },
  { functions: [{ function: 'rank', alias: 'x' }, { function: 'row_number', alias: 'x' }] },
  { functions: [{ function: 'rank', alias: 'globaltransid' }] },
]) test(`invalid Window is rejected before writes: ${JSON.stringify(patch)}`, async () => {
  const f = fixture(); await assert.rejects(f.service.create({ ...request, config: { ...config, ...patch } }));
  assert.ok(f.calls.every(c => c[0] === 'GET'));
});
test('template and explicit config cannot be mixed; template alone remains valid', () => {
  assert.ok(createRecipeSchema.parse({ ...request, config: { kind: 'window', template: { recipe_name: 'template' } } }));
  assert.throws(() => createRecipeSchema.parse({ ...request, config: { ...config, template: { recipe_name: 'template' } } }));
});
for (const method of ['create', 'update', 'repair']) {
  const input = method === 'create' ? request : { project_key: 'TEST', recipe_name: 'window', config };
  test(`${method} explicit Window integrates recipe PUT/read-back and schema propagation`, async () => {
    const f = fixture(); const r = await f.service[method](input);
    assert.equal(r.schema_applied, true); assert.equal(r.config.outputColumnNameOverrides.rownumber, 'candidate_rank');
    assert.ok(f.calls.some(c => c[0] === 'PUT' && c[1].endsWith('/out/schema')));
    assert.ok(!f.calls.some(c => /build|jobs|template/.test(c[1])));
  });
  test(`${method} dry-run is GET-only and returns proposed payload plus schema diff`, async () => {
    const f = fixture(); const r = await f.service[method]({ ...input, dry_run: true });
    assert.equal(r.writes, 0); assert.ok(f.calls.every(c => c[0] === 'GET'));
    assert.equal((r.configuration_patch ?? r.proposed.config).rowNumber, true);
    assert.deepEqual(r.schema_diff[0].diff.added.at(-1), { name: 'candidate_rank', type: 'bigint' });
  });
}
for (const target of ['partition', 'order', 'function', 'alias', 'input', 'output', 'nulls']) test(`read-back ${target} mismatch prevents schema write`, async () => {
  const f = fixture({ mutate(e) {
    const p = JSON.parse(e.payload);
    if (target === 'partition') p.windows[0].partitioningColumns = [];
    if (target === 'order') p.windows[0].orders.reverse();
    if (target === 'function') p.rowNumber = false;
    if (target === 'alias') p.outputColumnNameOverrides.rownumber = 'wrong';
    if (target === 'nulls') p.computedColumns[0].expr = '0';
    if (target === 'input') e.recipe.inputs.main.items = [{ ref: 'wrong' }];
    if (target === 'output') e.recipe.outputs.main.items = [{ ref: 'wrong' }];
    e.payload = JSON.stringify(p);
  } });
  await assert.rejects(f.service.repair({ project_key: 'TEST', recipe_name: 'window', config }), /mismatch/);
  assert.ok(!f.calls.some(c => c[0] === 'PUT' && c[1].endsWith('/schema')));
});
test('schema propagation mismatch is not reported as success', async () => {
  const f = fixture({ schemaMismatch: true });
  await assert.rejects(f.service.update({ project_key: 'TEST', recipe_name: 'window', config }), /Schema application or verification failed/);
});
test('empty recipe response has a diagnostic and no write', async () => {
  const f = fixture({ invalid: true }); await assert.rejects(f.service.repair({ project_key: 'TEST', recipe_name: 'window', config }), /empty or invalid/);
  assert.ok(f.calls.every(c => c[0] === 'GET'));
});
for (const payload of ['', '{"Authorization":"Bearer secret-value"']) test('invalid native read-back payload never claims success', async () => {
  const f = fixture({ mutate(e) { e.payload = payload; } });
  await assert.rejects(f.service.repair({ project_key: 'TEST', recipe_name: 'window', config }), e => {
    assert.match(e.message, /empty|Invalid visual/); assert.ok(!e.message.includes('secret-value')); return true;
  });
  assert.ok(!f.calls.some(c => c[0] === 'PUT' && c[1].endsWith('/schema')));
});
test('Window read-back tolerates extra DSS UI metadata', () => {
  const p = buildWindow(config, columns).payload, actual = structuredClone(p);
  actual.windows[0].uiHint = 'x'; verifyWindow(actual, p);
});
test('integration: public HTTP transport serializes native payload; response errors redact secrets', async t => {
  const f = fixture(); const key = 'window-test-secret';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname.replace('/public/api', '');
    const method = init.method.toLowerCase();
    const response = await f.http[method](path, init.body ? JSON.parse(init.body) : undefined);
    return new Response(JSON.stringify(response.data), { headers: { 'content-type': 'application/json' } });
  });
  const service = new RecipeService(new SecureHttpClient(new URL('https://dss.invalid/public/api/'), key));
  assert.equal((await service.create(request)).schema_applied, true);
  t.mock.method(globalThis, 'fetch', async () => new Response('{"Authorization":"Bearer ' + key, { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(service.repair({ project_key: 'TEST', recipe_name: 'window', config }), e => !e.message.includes(key) && /REDACTED/.test(e.message));
});
