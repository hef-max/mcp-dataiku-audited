import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DataikuClient } from '../dist/dataiku-client.js';

// Defense in depth: even a regression in dry_run cannot issue a write in this script.
const originalFetch = globalThis.fetch;
const methods = [];
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? 'GET';
  assert.equal(method, 'GET', 'Read-only verification forbids all non-GET requests');
  methods.push(method);
  return originalFetch(url, options);
};
const client = new DataikuClient({ readOnly: true });
const project = 'FCR_010';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const before = await client.listRecipes(project);
const seen = new Set();
for (const recipe of before) {
  if (!['join', 'shaker', 'vstack', 'grouping'].includes(recipe.type) || seen.has(recipe.type)) continue;
  const info = await client.getRecipeInfo(project, recipe.name);
  assert.equal(info.recipe_type, recipe.type);
  assert.equal(info.configuration_format, 'DSS_NATIVE_PAYLOAD');
  assert.ok(info.config);
  seen.add(recipe.type);
}
const join = before.find(r => r.type === 'join');
assert.ok(join, 'No existing join found');
const info = await client.getRecipeInfo(project, join.name);
const inputs = info.inputs.main.items.map(i => i.ref);
const native = info.config;
assert.equal(native.joins.length, 1);
const j = native.joins[0];
const config = {
  kind: 'join', join_type: j.type,
  left: inputs[native.virtualInputs[j.table1].index], right: inputs[native.virtualInputs[j.table2].index],
  keys: j.on.map(c => ({ left: c.column1.name, right: c.column2.name })),
  selected_columns: native.selectedColumns.map(c => ({ dataset: inputs[native.virtualInputs[c.table].index], column: c.name, ...(c.alias ? { alias: c.alias } : {}) })),
};
const plan = await client.updateRecipe(project, join.name, { config, dry_run: true });
assert.equal(plan.writes, 0);
assert.deepEqual(plan.proposed.config.joins[0].on.map(c => [c.column1.name, c.column2.name]), config.keys.map(c => [c.left, c.right]));
await assert.rejects(client.createRecipe(project, {
  name: 'mcp_readonly_conflict_probe', type: 'join', inputs,
  outputs: info.outputs.main.items.map(i => ({ name: i.ref })), config, dry_run: true,
}), /Output name conflict/);
const after = await client.listRecipes(project);
assert.equal(digest(before), digest(after), 'Recipe metadata changed during read-only inspection (possibly another user)');
console.log(JSON.stringify({ project, read_only: true, http_get_count: methods.length, writes: 0,
  inspected_types: [...seen], join_dry_run: 'passed', output_conflict: 'rejected',
  recipe_metadata_unchanged: true, before_sha256: digest(before), after_sha256: digest(after) }, null, 2));
