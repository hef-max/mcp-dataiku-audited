import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DataikuClient } from '../dist/dataiku-client.js';

// Defense in depth: no mutation can reach DSS even if a service dry-run regresses.
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = (url, init = {}) => {
  const method = init.method ?? 'GET';
  assert.equal(method, 'GET', 'Live check prohibits every non-GET request');
  calls.push({ method, endpoint: new URL(url).pathname });
  return originalFetch(url, init);
};
const client = new DataikuClient({ readOnly: true });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const before = { datasets: await client.listDatasets('FCR_010'), recipes: await client.listRecipes('FCR_010') };
const request = { project_key: 'FCR_010', dataset_name: 'silver_alert_investor_evidence_v2',
  clone_settings_from: 'silver_alert_trade_resolution_canonical',
  path: '/dataiku/dataikusilver_alert_investor_evidence_v2',
  schema: { columns: ['entity_type', 'entity_id', 'security_code', 'evidence_date', 'evidence_type', 'evidence_value', 'group_id', 'source_reference']
    .map(name => ({ name, type: name === 'evidence_date' ? 'dateonly' : 'string' })) }, dry_run: true };
try {
  const result = await client.createDataset(request);
  assert.equal(result.writes, 0);
  assert.equal(result.creation_request.type, 'S3');
  assert.equal(result.creation_request.formatParams.compress, 'gz');
  assert.deepEqual(result.creation_request.schema, request.schema);
  const after = { datasets: await client.listDatasets('FCR_010'), recipes: await client.listRecipes('FCR_010') };
  assert.equal(digest(before), digest(after), 'FCR_010 inventory changed during check');
  console.log(JSON.stringify({ result, requests: calls.length, methods: [...new Set(calls.map(c => c.method))],
    writes: 0, inventory_unchanged: true, before_sha256: digest(before), after_sha256: digest(after),
    target_exists: after.datasets.some(d => d.name === request.dataset_name) }, null, 2));
} finally { globalThis.fetch = originalFetch; }
