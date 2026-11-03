import test from 'node:test';
import assert from 'node:assert/strict';
import { InputReplacementService, replaceInputSchema } from '../dist/input-replacement.js';
import { DataikuClient } from '../dist/dataiku-client.js';
const columns = [{ name: 'id', type: 'string', meaning: 'Text' }, { name: 'evidence_value', type: 'double' }];
const request = { project_key: 'P', recipe_name: 'r', old_input: 'old', new_input: 'new' };
function fixture({ type = 'vstack', schema = columns, inputs = ['other', 'second', 'old'], tamper, mutateFresh = false, customize } = {}) {
  const calls = [];
  const payload = type === 'vstack' || type === 'join' ? {
    mode: 'REMAP', virtualInputs: inputs.map((name, index) => ({ index, originLabel: name, alias: name, columnsMatch: ['id', '', 'evidence_value'] })),
    selectedColumns: type === 'join' ? [{ name: 'id', table: 2, alias: 'unchanged_alias' }] : ['id', 'blank', 'evidence_value'],
    joins: [{ table1: 0, table2: 2, type: 'LEFT', rightLimit: { enabled: true, maxMatches: 1 }, on: [{ type: 'EQ', column1: { table: 0, name: 'id' }, column2: { table: 2, name: 'id' } }] }],
    copySchemaFromDatasetWithName: 'other', column_mapping: { value: { old: 'evidence_value', other: 'text_value' } },
    postFilter: { enabled: true, expression: 'id != ""' },
    engineParams: { sparkSQL: { readParams: { map: { old: { cache: false, repartition: 10 }, other: {} } } }, otherEngine: { input: 'P.old' } },
  } : { steps: [{ type: 'OpaqueNativeProcessor', params: { expression: 'id' } }], untouched: { values: ['', 1, false] } };
  if (customize) customize(payload);
  let envelope = { recipe: { name: 'r', type, versionTag: { versionNumber: 1 },
    inputs: { main: { items: inputs.map(ref => ({ ref, deps: ['preserved'] })) } },
    outputs: { main: { items: [{ ref: 'out', appendMode: false }] } },
    params: { engineParams: { spark: { readParams: { map: { 'P.old': { repartition: 8 } } } } } },
  }, payload: JSON.stringify(payload) };
  const before = structuredClone(envelope); let reads = 0;
  const http = {
    async get(path) {
      calls.push(['GET', path]);
      if (path === '/projects/P') return { data: {} };
      if (path.endsWith('/recipes/r')) { reads++; if (mutateFresh && reads === 2) envelope.recipe.description = 'concurrent edit'; return { data: structuredClone(envelope) }; }
      if (path.endsWith('/datasets/')) return { data: ['old', 'new', 'other', 'second'].map(name => ({ name })) };
      if (path.endsWith('/old/schema')) return { data: { columns } };
      if (path.endsWith('/new/schema')) return { data: { columns: schema } };
      if (type === 'join' && path.endsWith('/schema')) return { data: { columns } };
      // Other inputs have a legacy double/string conflict. Their schemas must not
      // be requested at all by slot-local replacement.
      throw new Error('Unexpected/global-validation GET ' + path);
    },
    async put(path, body) { calls.push(['PUT', path]); assert.equal(path, '/projects/P/recipes/r'); envelope = structuredClone(body); envelope.recipe.versionTag.versionNumber++;
      if (tamper) tamper(envelope); return { data: null }; },
    async post() { assert.fail('No POST permitted'); }, async delete() { assert.fail('No DELETE permitted'); },
  };
  return { service: new InputReplacementService(http, 'secret-key'), calls, before, http };
}
test('Vstack native REMAP replacement preserves blanks/mappings despite legacy conflicts elsewhere', async () => {
  const f = fixture(); const result = await f.service.replace({ ...request, dry_run: false });
  assert.equal(result.writes, 1); assert.equal(result.read_back_verification.verified, true);
  assert.deepEqual(result.slot, { role: 'main', index: 2, position: 3 });
  assert.equal(result.schema_comparison.identical, true);
  const before = JSON.parse(f.before.payload), after = result.proposed.payload;
  assert.deepEqual(after.virtualInputs.map(v => v.columnsMatch), before.virtualInputs.map(v => v.columnsMatch));
  assert.deepEqual(after.selectedColumns, before.selectedColumns);
  assert.equal(after.virtualInputs[2].originLabel, 'new'); assert.equal(after.virtualInputs[2].alias, 'new');
  assert.deepEqual(after.column_mapping.value, { new: 'evidence_value', other: 'text_value' });
  assert.deepEqual(after.engineParams.sparkSQL.readParams.map.new, { cache: false, repartition: 10 });
  assert.equal(after.copySchemaFromDatasetWithName, 'other');
  assert.deepEqual(result.proposed.recipe.inputs.main.items[2], { ref: 'new', deps: ['preserved'] });
  assert.equal(result.executed, false);
});
test('default dry-run executes complete preflight GET-only', async () => {
  const f = fixture(); const result = await f.service.replace(request);
  assert.equal(result.dry_run, true); assert.equal(result.writes, 0);
  assert.ok(f.calls.every(([method]) => method === 'GET'));
  assert.ok(f.calls.some(([, p]) => p.endsWith('/new/schema')));
  assert.equal(result.read_back_verification.performed, false);
});
for (const schema of [columns.slice().reverse(), [{ ...columns[0], name: 'wrong' }, columns[1]],
  [columns[0], { ...columns[1], type: 'string' }], [{ ...columns[0], meaning: 'Other' }, columns[1]]]) test('schema name/order/type/meaning mismatch stops before PUT', async () => {
  const f = fixture({ schema }); await assert.rejects(f.service.replace({ ...request, dry_run: false }), /schema mismatch/);
  assert.ok(f.calls.every(([m]) => m === 'GET'));
});
for (const inputs of [['other'], ['old', 'old'], ['old', 'new']]) test(`ambiguous or already-used input ${inputs}`, async () => {
  const f = fixture({ inputs }); await assert.rejects(f.service.replace({ ...request, dry_run: false }), /exactly once|already used/);
  assert.ok(f.calls.every(([m]) => m === 'GET'));
});
for (const type of ['shaker', 'grouping', 'window', 'distinct']) test(`${type} preserves single-input native transformation`, async () => {
  const f = fixture({ type, inputs: ['old'] }); const result = await f.service.replace({ ...request, dry_run: false });
  assert.deepEqual(result.proposed.payload, JSON.parse(f.before.payload)); assert.equal(result.read_back_verification.verified, true);
});
test('Join preserves indices, selected aliases, join type, right limit and filter', async () => {
  const f = fixture({ type: 'join' }); const result = await f.service.replace({ ...request, dry_run: false });
  const before = JSON.parse(f.before.payload);
  for (const key of ['joins', 'selectedColumns', 'postFilter']) assert.deepEqual(result.proposed.payload[key], before[key]);
});
for (const target of ['origin', 'map', 'mapping', 'filter', 'metadata']) test(`read-back tampering ${target} is failure`, async () => {
  const f = fixture({ tamper(e) { const p = JSON.parse(e.payload);
    if (target === 'origin') p.virtualInputs[2].originLabel = 'old';
    if (target === 'map') p.engineParams.sparkSQL.readParams.map.old = {};
    if (target === 'mapping') p.virtualInputs[0].columnsMatch[1] = 'changed';
    if (target === 'filter') p.postFilter.enabled = false;
    if (target === 'metadata') e.recipe.inputs.main.items[2].ref = 'old';
    e.payload = JSON.stringify(p); } });
  await assert.rejects(f.service.replace({ ...request, dry_run: false }), /read-back failed/);
  assert.equal(f.calls.filter(([m]) => m === 'PUT').length, 2);
});
test('copySchemaFromDatasetWithName changes only when equal to old input', async () => {
  const f = fixture(); const get = f.http.get;
  f.http.get = async p => { const result = await get(p); if (p.endsWith('/recipes/r')) { const q = JSON.parse(result.data.payload); q.copySchemaFromDatasetWithName = 'old'; result.data.payload = JSON.stringify(q); } return result; };
  assert.equal((await f.service.replace(request)).proposed.payload.copySchemaFromDatasetWithName, 'new');
});
test('unsafe schema opt-out is rejected', () => assert.equal(replaceInputSchema.safeParse({ ...request, require_identical_schema: false }).success, false));
test('concurrent recipe edit stops before write', async () => {
  const f = fixture({ mutateFresh: true }); await assert.rejects(f.service.replace({ ...request, dry_run: false }), /changed during preflight/);
  assert.ok(f.calls.every(([m]) => m === 'GET'));
});
test('sanitized diff never returns credentials from engine settings', async () => {
  const f = fixture(); const get = f.http.get;
  f.http.get = async p => { const result = await get(p); if (p.endsWith('/recipes/r')) result.data.recipe.params.password = 'secret-key'; return result; };
  assert.ok(!JSON.stringify(await f.service.replace(request)).includes('secret-key'));
});
test('public client integrates secure HTTP transport with replacement', async t => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname.replace('/public/api', '');
    const result = await f.http[init.method.toLowerCase()](path, init.body ? JSON.parse(init.body) : undefined);
    return new Response(JSON.stringify(result.data), { headers: { 'content-type': 'application/json' } });
  });
  const c = new DataikuClient({ host: 'https://example.invalid', apiKey: 'secret-key' });
  assert.equal((await c.replaceVisualRecipeInput({ ...request, dry_run: false })).read_back_verification.verified, true);
});
for (const kind of ['missing dataset', 'invalid index', 'unknown reference', 'key collision', 'missing Join column']) test(`replacement fails closed: ${kind}`, async () => {
  const f = fixture({ type: kind === 'missing Join column' ? 'join' : 'vstack' }); const get = f.http.get;
  f.http.get = async path => {
    const r = await get(path);
    if (kind === 'missing dataset' && path.endsWith('/datasets/')) r.data = r.data.filter(d => d.name !== 'new');
    if (path.endsWith('/recipes/r')) {
      const p = JSON.parse(r.data.payload);
      if (kind === 'invalid index') p.virtualInputs[2].index = 0;
      if (kind === 'unknown reference') p.futureUnknownField = 'old';
      if (kind === 'key collision') p.engineParams.sparkSQL.readParams.map.new = {};
      if (kind === 'missing Join column') p.selectedColumns[0].name = 'absent';
      r.data.payload = JSON.stringify(p);
    }
    return r;
  };
  await assert.rejects(f.service.replace({ ...request, dry_run: false }));
  assert.ok(f.calls.every(([method]) => method === 'GET'));
});

function computedJoin(p) {
  p.virtualInputs[2].computedColumns = [
    { name: 'alert_timestamp', expr: 'CAST("id" AS TIMESTAMP)', type: 'datetimenotz', mode: 'SQL', future: { untouched: [1, false] } },
    { name: 'alert_record_key', expr: 'CONCAT("id", CAST("alert_timestamp" AS VARCHAR))', type: 'string', mode: 'SQL' }
  ];
  p.selectedColumns.push({ name: 'alert_record_key', table: 2, alias: 'key_alias' });
  p.joins[0].on[0].column2.name = 'alert_record_key';
  p.virtualInputs[2].preFilter = { enabled: true, expression: '"alert_timestamp" IS NOT NULL' };
  p.postFilter = { enabled: true, expression: '"key_alias" IS NOT NULL' };
}
test('computed Join replacement preserves chained expressions, keys, filters, unknown properties and aliases', async () => {
  const f = fixture({ type: 'join', customize: computedJoin });
  const r = await f.service.replace({ ...request, dry_run: false });
  const old = JSON.parse(f.before.payload);
  assert.equal(r.effective_schemas[2].physical_columns.length, 2);
  assert.equal(r.effective_schemas[2].effective_columns.length, 4);
  assert.deepEqual(r.effective_schemas[2].computed_columns, old.virtualInputs[2].computedColumns);
  assert.deepEqual(r.proposed.payload.virtualInputs[2].computedColumns, old.virtualInputs[2].computedColumns);
  for (const key of ['joins', 'selectedColumns', 'postFilter']) assert.deepEqual(r.proposed.payload[key], old[key]);
  assert.deepEqual(r.proposed.payload.virtualInputs[2].preFilter, old.virtualInputs[2].preFilter);
  assert.equal(r.proposed.payload.virtualInputs[2].alias, 'new');
  assert.ok(r.proposed.payload.engineParams.sparkSQL.readParams.map.new);
  assert.deepEqual(r.proposed.recipe.outputs, f.before.recipe.outputs);
  assert.equal(r.read_back_verification.verified, true);
});
test('computed Join dry-run returns schemas and ref diff with zero writes', async () => {
  const f = fixture({ type: 'join', customize: computedJoin }); const r = await f.service.replace(request);
  assert.equal(r.writes, 0); assert.ok(f.calls.every(([m]) => m === 'GET'));
  assert.equal(r.effective_schemas.length, 3); assert.equal(r.effective_schemas[2].computed_columns.length, 2); assert.ok(r.diff.length > 0);
});
for (const location of ['selectedColumns', 'join', 'preFilter', 'postFilter', 'computed']) test(`missing ${location} column has contextual diagnostics and zero writes`, async () => {
  const f = fixture({ type: 'join', customize(p) { computedJoin(p);
    if (location === 'selectedColumns') p.selectedColumns.push({ table: 2, name: 'absent' });
    if (location === 'join') p.joins[0].on[0].column2.name = 'absent';
    if (location === 'preFilter') p.virtualInputs[2].preFilter.expression = '"absent" IS NOT NULL';
    if (location === 'postFilter') p.postFilter.expression = '"absent" IS NOT NULL';
    if (location === 'computed') p.virtualInputs[2].computedColumns[0].expr = 'CAST("absent" AS TIMESTAMP)';
  } });
  await assert.rejects(f.service.replace(request), e => {
    const d = JSON.parse(e.message); assert.equal(d.recipe_name, 'r'); assert.equal(d.column, 'absent'); assert.ok(d.location); assert.equal(d.searched.length, 2); return true;
  });
  assert.ok(f.calls.every(([m]) => m === 'GET'));
});
test('forward computed dependency is rejected', async () => {
  const f = fixture({ type: 'join', customize(p) { computedJoin(p); p.virtualInputs[2].computedColumns.reverse(); } });
  await assert.rejects(f.service.replace(request), /alert_timestamp/);
});
test('read-back computed mismatch rolls back original configuration and verifies GET', async () => {
  let once = true;
  const f = fixture({ type: 'join', customize: computedJoin, tamper(e) {
    if (!once) return; once = false; const p = JSON.parse(e.payload); p.virtualInputs[2].computedColumns[0].expr = 'broken'; e.payload = JSON.stringify(p);
  } });
  await assert.rejects(f.service.replace({ ...request, dry_run: false }), e => { assert.equal(JSON.parse(e.message).rollback.verified, true); return true; });
  const restored = (await f.http.get('/projects/P/recipes/r')).data;
  assert.deepEqual(JSON.parse(restored.payload), JSON.parse(f.before.payload));
  assert.deepEqual(restored.recipe.outputs, f.before.recipe.outputs);
  assert.equal(f.calls.filter(([m]) => m === 'PUT').length, 2);
});
