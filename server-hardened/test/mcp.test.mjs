import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('compiled MCP exposes strict visual config schemas and rejects invalid request without DSS', async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/mcp-server.js'],
    env: { ...process.env, DSS_HOST: 'https://example.invalid', DSS_API_KEY: 'test-only', DSS_INSECURE_TLS: 'false', DSS_READ_ONLY: 'true' }, stderr: 'pipe' });
  const client = new Client({ name: 'recipe-contract-tests', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
    for (const name of ['list_flow_zones', 'get_flow_object_zone', 'move_flow_items']) assert.ok(tools.some(t => t.name === name));
    for (const name of ['move_flow_items', 'create_recipe', 'create_dataset']) assert.equal(tools.find(t => t.name === name).inputSchema.properties.dry_run.default, true);
    for (const name of ['create_recipe', 'create_dataset']) {
      assert.ok(tools.find(t => t.name === name).inputSchema.properties.zone_id);
      assert.ok(tools.find(t => t.name === name).inputSchema.properties.zone_name);
    }
    const replacement = tools.find(t => t.name === 'replace_visual_recipe_input').inputSchema;
    assert.equal(replacement.properties.require_identical_schema.default, true);
    assert.equal(replacement.properties.require_identical_schema.const, true);
    assert.equal(replacement.properties.dry_run.default, true);
    const create = tools.find(t => t.name === 'create_recipe');
    assert.ok(create.inputSchema.properties.config);
    for (const name of ['create_recipe', 'update_recipe', 'repair_recipe_configuration']) {
      const configSchema = JSON.stringify(tools.find(t => t.name === name).inputSchema.properties.config);
      for (const field of ['partition_by', 'order_by', 'functions', 'nulls', 'dense_rank']) assert.ok(configSchema.includes(field));
    }
    assert.ok(create.inputSchema.properties.dry_run);
    assert.equal(create.inputSchema.required.includes('dry_run'), false);
    assert.ok(tools.find(t => t.name === 'update_recipe').inputSchema.properties.config);
    const dataset = tools.find(t => t.name === 'create_dataset').inputSchema;
    assert.ok(dataset.properties.clone_settings_from);
    assert.ok(dataset.properties.schema);
    assert.ok(dataset.properties.dry_run);
    assert.equal(dataset.properties.params, undefined);
    assert.ok(create.inputSchema.properties.outputs.items.properties.clone_settings_from);
    for (const name of ['build_dataset', 'run_recipe']) {
      const schema = tools.find(t => t.name === name).inputSchema;
      assert.equal(schema.properties.mode.default, 'NON_RECURSIVE_FORCED_BUILD');
      assert.ok(schema.properties.dry_run); assert.ok(schema.properties.wait);
    }
    for (const name of ['get_job_status', 'wait_for_job', 'get_job_log']) assert.ok(tools.find(t => t.name === name));
    const repair = tools.find(t => t.name === 'repair_recipe_configuration');
    assert.ok(repair.inputSchema.properties.config); assert.equal(repair.inputSchema.properties.inputs, undefined);
    for (const name of ['update_dataset', 'apply_dataset_schema']) {
      const schema = tools.find(t => t.name === name).inputSchema;
      assert.ok(schema.properties.schema); assert.ok(schema.properties.dry_run);
      assert.equal(schema.additionalProperties, false);
    }
    const result = await client.callTool({ name: 'create_recipe', arguments: {
      project_key: 'TEST', recipe_name: 'test', recipe_type: 'join', inputs: ['a', 'b'], outputs: [{ name: 'out' }],
    } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /must match/);
  } finally { await client.close(); }
});
