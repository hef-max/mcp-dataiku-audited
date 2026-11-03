import { defaultFlowRead } from './default-flow-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { retiredInputReferences, hasRetiredReference } from '../dist/recipe-references.js';
import { RecipeService } from '../dist/recipe-service.js';
import { DataikuClient } from '../dist/dataiku-client.js';
import { createRecipeSchema } from '../dist/recipe-config.js';

const columns = [{ name: 'id', type: 'string' }, { name: 'amount', type: 'double' }, { name: 'label', type: 'string' }];
const join = { kind: 'join', join_type: 'LEFT', left: 'left', right: 'right', keys: [{ left: 'id', right: 'id' }],
  selected_columns: [{ dataset: 'left', column: 'id' }, { dataset: 'right', column: 'amount', alias: 'total' }],
  post_filter: { expression: 'total > 0', language: 'CUSTOM' } };
const request = (type, config) => ({ project_key: 'TEST', recipe_name: 'new_recipe', recipe_type: type, dry_run: false,
  inputs: ['left'], outputs: [{ name: 'out' }], ...(config ? { config } : { code: 'print(1)' }) });

function fixture({ owner = false, missing = false, templateType, mismatchedTemplate = false, tamperPayload, putFailure = false, emptyPayload = false, creationResponse = 'default', tamperJoin = false } = {}) {
  const writes = [], reads = [];
  let envelope = { recipe: { name: 'new_recipe', type: 'python', unknownServerField: { keep: true },
    inputs: { main: { items: [{ ref: 'left', deps: ['preserve'] }] } },
    outputs: { main: { items: [{ ref: 'out', appendMode: false }] } } }, payload: 'old code', outerUnknown: 7 };
  const http = {
    async get(path) {
      reads.push(path);
      const flow = defaultFlowRead(path); if (flow) return flow;
      if (path === '/projects/TEST') return { data: {} };
      if (path.endsWith('/datasets/')) return { data: (missing ? ['out', 'right'] : ['left', 'right', 'out']).map(name => ({ name })) };
      if (path.endsWith('/template_source/schema')) return { data: { columns: columns.map(c => ({ ...c, type: 'boolean' })) } };
      if (path.endsWith('/schema')) return { data: { columns } };
      if (path.endsWith('/recipes/')) return { data: owner ? [{ name: 'other', outputs: { main: { items: [{ ref: 'out' }] } } }] : [] };
      if (path.endsWith('/recipes/template')) return { data: { recipe: { type: templateType,
        inputs: { main: { items: [{ ref: mismatchedTemplate ? 'template_source' : 'left' }] } }, outputs: { main: { items: [{ ref: 'template_out' }] } } },
        // Opaque test data: deliberately not a guessed native Window/Distinct schema.
        payload: JSON.stringify({ opaqueTemplateSettings: { verifiedByCaller: true }, engineParams: { old: true } }) } };
      if (path.endsWith('/recipes/new_recipe')) return { data: structuredClone(envelope) };
      throw new Error('Unexpected GET ' + path);
    },
    async post(path, body) {
      assert.ok(path.endsWith('/recipes/'), 'Only recipe creation is allowed');
      assert.ok(body.recipePrototype);
      assert.ok(body.creationSettings);
      writes.push({ method: 'POST', path, body: structuredClone(body) });
      envelope = { ...envelope, recipe: { ...envelope.recipe, ...body.recipePrototype }, payload: emptyPayload ? '' : body.creationSettings.payload ?? JSON.stringify({ engineParams: { keep: true } }) };
      return { data: creationResponse === 'default' ? { name: 'new_recipe' } : creationResponse };
    },
    async put(path, body) {
      if (putFailure) throw new Error('write failed');
      writes.push({ method: 'PUT', path, body: structuredClone(body) });
      envelope = structuredClone(body);
      if (tamperPayload) tamperPayload(envelope);
      if (tamperJoin) { const payload = JSON.parse(envelope.payload); payload.joins[0].rightLimit.enabled = true; envelope.payload = JSON.stringify(payload); }
      return { data: null };
    },
  };
  return { service: new RecipeService(http), writes, reads, setEnvelope: value => { envelope = value; } };
}

test('create Python sends code as creationSettings.payload, no build', async () => {
  const f = fixture(); const info = await f.service.create(request('python'));
  assert.equal(info.code, 'print(1)'); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].body.creationSettings.payload, 'print(1)');
  assert.equal(info.executed, false);
});
test('SQL alias resolves to sql_query', async () => {
  const f = fixture(); await f.service.create({ ...request('sql'), code: 'SELECT 1' });
  assert.equal(f.writes[0].body.recipePrototype.type, 'sql_query');
});
for (const joinType of ['INNER', 'LEFT', 'RIGHT', 'FULL']) test(`create Join ${joinType}: keys, selection, filter and defaults`, async () => {
  const f = fixture(); const result = await f.service.create({ ...request('join', { ...join, join_type: joinType }), inputs: ['right', 'left'] });
  assert.equal(result.config.joins[0].type, joinType);
  assert.deepEqual(result.config.joins[0].on[0], { type: 'EQ', column1: { table: 1, name: 'id' }, column2: { table: 0, name: 'id' } });
  assert.equal(result.config.selectedColumns[1].alias, 'total');
  assert.equal(result.config.postFilter.expression, 'total > 0');
  assert.deepEqual(result.config.engineParams, { keep: true });
  assert.equal(f.writes.length, 2);
});
test('create Prepare preserves operation order, projection and escaped column references', async () => {
  const f = fixture(); const result = await f.service.create(request('prepare', { kind: 'shaker', steps: [
    { op: 'filter', expression: 'amount > 0' }, { op: 'compute', column: 'copy', expression: 'amount * 2' },
    { op: 'rename', from: 'label', to: 'name' }, { op: 'cast', column: 'copy', to: 'double' },
    { op: 'trim', column: 'name' }, { op: 'normalize', column: 'name', mode: 'lower' }, { op: 'select', columns: ['id', 'name'] },
  ] }));
  assert.equal(result.recipe_type, 'shaker');
  assert.equal(result.config.steps[0].type, 'FilterOnCustomFormula');
  assert.equal(result.config.steps[3].params.expression, 'numval("copy")');
  assert.deepEqual(result.config.columnsSelection, { mode: 'ALL', list: [{ name: 'amount', d: true }, { name: 'copy', d: true }] });
});
for (const mode of ['UNION', 'INTERSECT', 'REMAP']) test(`create Stack ${mode}`, async () => {
  const f = fixture(); const config = { kind: 'vstack', schema_alignment: mode,
    ...(mode === 'REMAP' ? { column_mapping: { result: { left: 'id', right: 'label' } } } : {}) };
  const result = await f.service.create({ ...request('stack', config), inputs: ['left', 'right'] });
  assert.equal(result.config.mode, mode);
  if (mode === 'REMAP') assert.deepEqual(result.config.virtualInputs.map(v => v.columnsMatch), [['id'], ['label']]);
});
test('create Grouping count, distinct, min/max/sum/average', async () => {
  const f = fixture(); const result = await f.service.create(request('grouping', { kind: 'grouping', group_keys: ['id'], count_rows: true,
    aggregations: [{ column: 'label', operation: 'count_distinct', alias: 'labels' },
      ...['min', 'max', 'sum', 'average'].map(operation => ({ column: 'amount', operation }))] }));
  assert.equal(result.config.globalCount, true);
  assert.equal(result.config.values[1].avg, true);
  assert.equal(result.config.values[1].sum, true);
  assert.deepEqual(result.config.outputColumnNameOverrides, { label_distinct: 'labels' });
  assert.equal(f.writes[0].body.creationSettings.groupKey, 'id');
});
for (const type of ['window', 'distinct']) {
  test(`create ${type} copies native template unchanged except engine settings`, async () => {
    const f = fixture({ templateType: type });
    const result = await f.service.create(request(type, { kind: type, template: { recipe_name: 'template' } }));
    assert.deepEqual(result.config.opaqueTemplateSettings, { verifiedByCaller: true });
    assert.deepEqual(result.config.engineParams, { keep: true });
    assert.match(result.limitations.join(' '), /Template copy only/);
  });
  test(`${type} without verified template is rejected before writes`, async () => {
    const f = fixture(); await assert.rejects(f.service.create(request(type, { kind: type }))); assert.equal(f.writes.length, 0);
  });
}
test('invalid join key rejects before mutation', async () => {
  const f = fixture(); await assert.rejects(f.service.create({ ...request('join', { ...join, keys: [{ left: 'missing', right: 'id' }] }), inputs: ['left', 'right'] }), /Missing column/);
  assert.equal(f.writes.length, 0);
});
test('missing input dataset rejects before mutation', async () => {
  const f = fixture({ missing: true }); await assert.rejects(f.service.create(request('python')), /Missing input/); assert.equal(f.writes.length, 0);
});
test('output producer conflict rejects before mutation', async () => {
  const f = fixture({ owner: true }); await assert.rejects(f.service.create(request('python')), /Output name conflict/); assert.equal(f.writes.length, 0);
});
test('ambiguous selected output names rejected', async () => {
  const f = fixture(); const config = { ...join, selected_columns: [{ dataset: 'left', column: 'id' }, { dataset: 'right', column: 'id' }] };
  await assert.rejects(f.service.create({ ...request('join', config), inputs: ['left', 'right'] }), /Ambiguous/); assert.equal(f.writes.length, 0);
});
test('dry-run is GET only and returns exact planned body', async () => {
  const f = fixture(); const result = await f.service.create({ ...request('join', join), inputs: ['left', 'right'], dry_run: true });
  assert.equal(result.writes, 0); assert.equal(f.writes.length, 0); assert.ok(result.configuration_patch.joins);
});
test('output provisioning and unknown configuration rejected, not silently ignored', async () => {
  const f = fixture(); await assert.rejects(f.service.create({ ...request('python'), outputs: [{ name: 'out', new: true }] }), /provisioning/);
  await assert.rejects(f.service.create({ ...request('window', { kind: 'window', template: { recipe_name: 'template' }, partition_keys: ['id'] }) }));
  assert.equal(f.writes.length, 0);
});
test('type mismatch rejected before writes', async () => {
  const f = fixture(); await assert.rejects(f.service.create(request('grouping', join)), /must match/); assert.equal(f.writes.length, 0);
});
test('update Python preserves unknown fields and I/O metadata', async () => {
  const f = fixture(); await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', code: 'print(2)' });
  assert.equal(f.writes[0].method, 'PUT'); assert.equal(f.writes[0].body.payload, 'print(2)');
  assert.equal(f.writes[0].body.outerUnknown, 7); assert.deepEqual(f.writes[0].body.recipe.inputs.main.items[0].deps, ['preserve']);
});
test('update visual config preserves engine and replaces requested settings', async () => {
  const f = fixture(); await f.service.create({ ...request('join', join), inputs: ['left', 'right'] });
  const result = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', config: { ...join, join_type: 'INNER' } });
  assert.equal(result.config.joins[0].type, 'INNER'); assert.deepEqual(result.config.engineParams, { keep: true });
});
test('update dry-run never PUTs', async () => {
  const f = fixture(); const result = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', code: 'x=2', dry_run: true });
  assert.equal(result.writes, 0); assert.equal(f.writes.length, 0);
});
test('partial create failure is reported without deletion or retry', async () => {
  const f = fixture({ putFailure: true }); await assert.rejects(f.service.create({ ...request('join', join), inputs: ['left', 'right'] }), /created but configuration/);
  assert.equal(f.writes.length, 1);
});
test('path injection and typo fields rejected locally', () => {
  assert.equal(createRecipeSchema.safeParse({ ...request('python'), project_key: '../admin' }).success, false);
  assert.equal(createRecipeSchema.safeParse({ ...request('python'), dryrun: true }).success, false);
});
test('read-only HTTP client refuses mutations before contacting network', async () => {
  const client = new DataikuClient({ host: 'https://example.invalid', apiKey: 'test', readOnly: true });
  await assert.rejects(client.deleteDataset('TEST', 'out'), /Read-only/);
});
test('create multi-key Join initializes virtualInputs and can configure an empty initial payload', async () => {
  const f = fixture({ emptyPayload: true });
  const config = { ...join, join_type: 'INNER', keys: [{ left: 'id', right: 'id' }, { left: 'label', right: 'label' }] };
  const r = await f.service.create({ ...request('join', config), inputs: ['left', 'right'] });
  assert.deepEqual(f.writes[0].body.creationSettings.virtualInputs, ['left', 'right']);
  assert.equal(r.config.joins[0].on.length, 2); assert.equal(r.config.joins[0].rightLimit.enabled, false);
});
for (const creationResponse of [null, 'new_recipe']) test(`create handles ${creationResponse === null ? 'empty' : 'text'} success response with separate GET`, async () => {
  const f = fixture({ emptyPayload: true, creationResponse });
  const result = await f.service.create({ ...request('join', join), inputs: ['left', 'right'] });
  assert.equal(result.recipe_name, 'new_recipe'); assert.ok(f.reads.some(p => p.endsWith('/recipes/new_recipe')));
});
const partialEnvelope = payload => ({ recipe: { name: 'new_recipe', type: 'join',
  inputs: { main: { items: [{ ref: 'left', deps: ['keep'] }, { ref: 'right', deps: [] }] } },
  outputs: { main: { items: [{ ref: 'out', appendMode: false }] } }, params: { keep: true } }, payload });
test('get_recipe_info on empty payload reports EMPTY and retains metadata', async () => {
  const f = fixture(); f.setEnvelope(partialEnvelope(''));
  const info = await f.service.info('TEST', 'new_recipe');
  assert.equal(info.configuration_format, 'EMPTY'); assert.equal(info.config, null); assert.match(info.diagnostic, /visual payload is empty/);
  assert.deepEqual(info.recipe_settings, { keep: true });
});
test('repair empty/malformed payload preserves I/O and never builds or modifies schema', async () => {
  for (const payload of ['', '{truncated']) {
    const f = fixture(); const before = partialEnvelope(payload); f.setEnvelope(before);
    const result = await f.service.repair({ project_key: 'TEST', recipe_name: 'new_recipe', config: join });
    assert.deepEqual(result.inputs, before.recipe.inputs); assert.deepEqual(result.outputs, before.recipe.outputs);
    assert.equal(result.verified, true); assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].path, '/projects/TEST/recipes/new_recipe');
  }
});
test('repair dry-run has no writes and returns proposed payload', async () => {
  const f = fixture(); f.setEnvelope(partialEnvelope(''));
  const result = await f.service.repair({ project_key: 'TEST', recipe_name: 'new_recipe', config: join, dry_run: true });
  assert.equal(result.writes, 0); assert.equal(result.proposed.config.joins[0].type, 'LEFT'); assert.equal(f.writes.length, 0);
});
test('Cartesian Join is rejected locally without opt-in support', async () => {
  const f = fixture(); await assert.rejects(f.service.create({ ...request('join', { ...join, keys: [] }), inputs: ['left', 'right'] }));
  assert.equal(f.writes.length, 0);
});
test('create failure reports partial creation and recovery instructions without deletion', async () => {
  const f = fixture({ emptyPayload: true, putFailure: true });
  await assert.rejects(f.service.create({ ...request('join', join), inputs: ['left', 'right'] }), error => {
    const details = JSON.parse(error.message); assert.equal(details.partial_creation, true);
    assert.match(details.recovery, /repair_recipe_configuration/); assert.deepEqual(details.rollback, []); return true;
  });
});
test('partial Join with missing inputs requires explicit update; repair never invents I/O', async () => {
  const f = fixture(); const partial = partialEnvelope(''); partial.recipe.inputs = {}; f.setEnvelope(partial);
  await assert.rejects(f.service.repair({ project_key: 'TEST', recipe_name: 'new_recipe', config: join }));
  assert.equal(f.writes.length, 0);
  const result = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', inputs: ['left', 'right'], config: join });
  assert.deepEqual(result.inputs.main.items.map(i => i.ref), ['left', 'right']);
  assert.deepEqual(result.outputs, partial.recipe.outputs); assert.equal(result.verified, true);
});
test('read-back right-side row limit causes failure, never false success', async () => {
  const f = fixture({ tamperJoin: true }); f.setEnvelope(partialEnvelope(''));
  await assert.rejects(f.service.repair({ project_key: 'TEST', recipe_name: 'new_recipe', config: join }), /no right-side row limit/);
});

for (const output_type of ['date', 'dateonly', 'datetimenotz']) test(`Prepare DateParser native ${output_type} supports formats and timezone`, async () => {
  const f = fixture(); const result = await f.service.create(request('shaker', { kind: 'shaker', steps: [
    { op: 'parse_date', column: 'label', formats: ['yyyy-MM-dd', 'MM/dd/yy'], timezone: 'Asia/Jakarta', output_type },
  ] }));
  assert.deepEqual(result.config.steps[0], { metaType: 'PROCESSOR', type: 'DateParser', disabled: false,
    params: { appliesTo: 'SINGLE_COLUMN', columns: ['label'], formats: ['yyyy-MM-dd', 'MM/dd/yy'], timezone_id: 'Asia/Jakarta', lang: 'auto', outCol: '', outType: { name: 'out', type: output_type } } });
});
for (const patch of [{ column: 'missing' }, { formats: [] }, { timezone: 'invalid/timezone' }, { output_column: 'id' }]) test(`DateParser invalid ${JSON.stringify(patch)} is zero write`, async () => {
  const f = fixture(); await assert.rejects(f.service.create(request('shaker', { kind: 'shaker', steps: [{ op: 'parse_date', column: 'label', formats: ['yyyy-MM-dd'], output_type: 'date', ...patch }] })));
  assert.equal(f.writes.length, 0);
});
test('DateParser new output is available to subsequent steps and dry-run never writes', async () => {
  const f = fixture(); const result = await f.service.create({ ...request('shaker', { kind: 'shaker', steps: [
    { op: 'parse_date', column: 'label', formats: ['yyyy-MM-dd'], output_type: 'dateonly', output_column: 'parsed' },
    { op: 'rename', from: 'parsed', to: 'result' },
  ] }), dry_run: true });
  assert.equal(result.configuration_patch.steps[0].params.outCol, 'parsed'); assert.equal(f.writes.length, 0);
});
test('shaker native template is cloned for identical schema', async () => {
  const f = fixture({ templateType: 'shaker' }); const result = await f.service.create(request('shaker', { kind: 'shaker', template: { recipe_name: 'template' } }));
  assert.deepEqual(result.config.opaqueTemplateSettings, { verifiedByCaller: true });
});
test('shaker template schema mismatch rejects without writes', async () => {
  const f = fixture({ templateType: 'shaker', mismatchedTemplate: true });
  await assert.rejects(f.service.create(request('shaker', { kind: 'shaker', template: { recipe_name: 'template' } })), /schema must exactly match/);
  assert.equal(f.writes.length, 0);
});
test('template and explicit Prepare steps rejected before requests', async () => {
  const f = fixture(); await assert.rejects(f.service.create(request('shaker', { kind: 'shaker', template: { recipe_name: 'template' }, steps: [{ op: 'trim', column: 'label' }] })), /exactly one/);
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});
test('shaker template dry-run retains native steps with no writes', async () => {
  const f = fixture({ templateType: 'shaker' }); const result = await f.service.create({ ...request('shaker', { kind: 'shaker', template: { recipe_name: 'template' } }), dry_run: true });
  assert.ok(result.configuration_patch.opaqueTemplateSettings); assert.equal(f.writes.length, 0);
});
test('Join full config updates missing metadata inputs and indexed references together', async () => {
  const f = fixture(); const old = partialEnvelope(''); old.recipe.inputs = {}; f.setEnvelope(old);
  const result = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', config: join, outputs: [{ name: 'out' }] });
  assert.deepEqual(result.inputs.main.items.map(i => i.ref), ['left', 'right']);
  assert.deepEqual(result.config.virtualInputs.map(i => [i.index, i.originLabel]), [[0, 'left'], [1, 'right']]);
  assert.equal(result.config.joins[0].table1, 0); assert.equal(result.config.joins[0].table2, 1);
});
test('Vstack reordering rebuilds mappings in metadata input order and removes stale payload', async () => {
  const f = fixture(); const old = partialEnvelope(JSON.stringify({ stale: true })); old.recipe.type = 'vstack'; f.setEnvelope(old);
  const result = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', inputs: ['right', 'left'], outputs: [{ name: 'out' }],
    config: { kind: 'vstack', schema_alignment: 'REMAP', column_mapping: { value: { left: 'id', right: 'label' } } } });
  assert.deepEqual(result.inputs.main.items.map(i => i.ref), ['right', 'left']);
  assert.deepEqual(result.config.virtualInputs.map(i => [i.index, i.originLabel, i.columnsMatch]), [[0, 'right', ['label']], [1, 'left', ['id']]]);
  assert.equal(result.config.stale, undefined);
});
for (const type of ['shaker', 'vstack']) test(`${type} read-back semantic mismatch is rejected`, async () => {
  const f = fixture({ tamperPayload(e) { const p = JSON.parse(e.payload); if (type === 'shaker') p.steps = []; else p.virtualInputs[0].columnsMatch = ['wrong']; e.payload = JSON.stringify(p); } });
  const conf = type === 'shaker' ? { kind: 'shaker', steps: [{ op: 'trim', column: 'label' }] } : { kind: 'vstack', schema_alignment: 'REMAP', column_mapping: { result: { left: 'id', right: 'label' } } };
  await assert.rejects(f.service.create({ ...request(type, conf), inputs: type === 'shaker' ? ['left'] : ['left', 'right'] }), /read-back mismatch/);
});

const rewireEnvelope = () => {
  const e = partialEnvelope(JSON.stringify({ engineParams: { sparkSQL: { readParams: { map: { old_left: {}, right: {} } } }, futureEngine: { source: 'TEST.old_left' } }, hiddenOldCache: ['old_left'] }));
  e.recipe.inputs.main.items[0].ref = 'old_left';
  e.recipe.params = { engineParams: { spark: { readParams: { map: { old_left: {} } } } }, hiddenCache: { dataset: 'old_left' }, keep: true };
  return e;
};
test('Join rewire dry-run resets engine blocks and hidden old-input settings with zero writes', async () => {
  const f = fixture(); f.setEnvelope(rewireEnvelope());
  const r = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', config: join, dry_run: true });
  assert.equal(r.input_settings_reset, true);
  assert.equal(r.proposed.config.engineParams, undefined);
  assert.equal(r.proposed.config.hiddenOldCache, undefined);
  assert.deepEqual(r.proposed.recipe_settings, { keep: true });
  assert.ok(!JSON.stringify(r.proposed.config).includes('old_left'));
  assert.deepEqual(r.proposed.inputs.main.items.map(i => i.ref), ['left', 'right']);
  assert.equal(f.writes.length, 0);
});
for (const where of ['payload-map-key', 'payload-array', 'settings', 'qualified']) test(`rewire read-back rejects resurrected old reference: ${where}`, async () => {
  const f = fixture({ tamperPayload(e) {
    const p = JSON.parse(e.payload);
    if (where === 'payload-map-key') p.engineParams = { sparkSQL: { readParams: { map: { old_left: {} } } } };
    if (where === 'payload-array') p.unknownCache = ['old_left'];
    if (where === 'settings') e.recipe.params.hidden = { dataset: 'old_left' };
    if (where === 'qualified') p.unknownCache = { query: 'select * from TEST.old_left' };
    e.payload = JSON.stringify(p);
  } }); f.setEnvelope(rewireEnvelope());
  await assert.rejects(f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', config: join }), /retired input references/);
  assert.equal(f.writes.length, 1);
});
test('rewire clean read-back succeeds and retains still-active right input', async () => {
  const f = fixture(); f.setEnvelope(rewireEnvelope());
  const r = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', config: join });
  assert.equal(r.verified, true); assert.equal(r.input_settings_reset, true);
  assert.equal(r.config.virtualInputs[1].originLabel, 'right');
});
test('input reorder resets engine caches even without retiring a dataset name', async () => {
  const f = fixture(); const e = rewireEnvelope(); e.recipe.inputs.main.items[0].ref = 'left'; f.setEnvelope(e);
  const r = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', inputs: ['right', 'left'], config: join, dry_run: true });
  assert.equal(r.input_settings_reset, true); assert.equal(r.proposed.config.engineParams, undefined);
});

test('retired reference matcher handles qualified column paths but not output-name prefixes', () => {
  const retired = retiredInputReferences(['TEST.old', 'right'], ['new', 'TEST.right'], 'TEST');
  assert.equal(hasRetiredReference({ cache: ['TEST.old.column'] }, retired), true);
  assert.equal(hasRetiredReference({ 'old.partition': {} }, retired), true);
  assert.equal(hasRetiredReference({ output: 'old_enriched', keep: 'TEST.right' }, retired), false);
});

const promptConfig = {
  kind: 'prompt',
  llm_id: 'mistralai:test:mistral-small-latest',
  prompt: 'ID={{id}} Label={{label}}. Return JSON.',
  input_columns: ['id', 'label'],
  required_json_keys: ['summary', 'limitations'],
  response_format: 'JSON_OBJECT',
};

test('create Prompt recipe builds verified native DSS payload without execution', async () => {
  const f = fixture();
  const result = await f.service.create(request('prompt', promptConfig));
  assert.equal(result.recipe_type, 'prompt');
  assert.equal(result.config.llmId, promptConfig.llm_id);
  assert.deepEqual(result.config.prompt.promptTemplateInputs.map(x => x.datasetColumnName), ['id', 'label']);
  assert.deepEqual(result.config.prompt.resultValidation.requiredJSONObjectKeys, ['summary', 'limitations']);
  assert.equal(result.config.prompt.resultValidation.expectedFormat, 'JSON_OBJECT');
  assert.equal(result.executed, false);
  assert.equal(f.writes.length, 2);
});

test('Prompt dry-run is GET-only and returns proposed native payload', async () => {
  const f = fixture();
  const result = await f.service.create({ ...request('prompt', promptConfig), dry_run: true });
  assert.equal(result.dry_run, true);
  assert.equal(result.writes, 0);
  assert.equal(result.configuration_patch.llmId, promptConfig.llm_id);
  assert.equal(f.writes.length, 0);
});

test('Prompt rejects missing input columns and unreferenced template columns', async () => {
  const f = fixture();
  await assert.rejects(f.service.create(request('prompt', { ...promptConfig, input_columns: ['missing'], prompt: 'missing={{missing}}' })), /Missing column/);
  await assert.rejects(f.service.create(request('prompt', { ...promptConfig, prompt: 'ID={{id}}' })), /does not reference input column: label/);
});

test('Prompt TEXT response rejects JSON required keys', async () => {
  const f = fixture();
  await assert.rejects(f.service.create(request('prompt', { ...promptConfig, response_format: 'TEXT' })), /required_json_keys requires JSON_OBJECT/);
});

test('update Prompt replaces complete native configuration and verifies read-back', async () => {
  const f = fixture();
  await f.service.create(request('prompt', promptConfig));
  const changed = { ...promptConfig, prompt: 'Updated ID={{id}} Label={{label}}. Return JSON.' };
  const result = await f.service.update({ project_key: 'TEST', recipe_name: 'new_recipe', config: changed, dry_run: false });
  assert.equal(result.config.prompt.structuredPromptPrefix, changed.prompt);
  assert.equal(result.verified, true);
  assert.equal(result.executed, false);
});

test('repair Prompt performs GET-only dry-run with complete typed config', async () => {
  const f = fixture();
  await f.service.create(request('prompt', promptConfig));
  const result = await f.service.repair({ project_key: 'TEST', recipe_name: 'new_recipe', config: promptConfig, dry_run: true });
  assert.equal(result.dry_run, true);
  assert.equal(result.writes, 0);
  assert.equal(result.proposed.config.llmId, promptConfig.llm_id);
});
