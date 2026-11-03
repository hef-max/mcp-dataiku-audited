import test from 'node:test';
import assert from 'node:assert/strict';
import { SecureHttpClient } from '../dist/dataiku-client.js';
for (const example of [
  { name: 'JSON', status: 200, type: 'application/json; charset=utf-8', body: '{"ok":true}', expected: { ok: true } },
  { name: 'empty JSON', status: 200, type: 'application/json', body: '', expected: null },
  { name: 'whitespace', status: 200, type: 'application/json', body: ' \n ', expected: null },
  { name: '204', status: 204, type: '', body: null, expected: null },
  { name: 'text', status: 200, type: 'text/plain', body: 'Saved', expected: 'Saved' },
]) test(`successful HTTP ${example.name} body handled by content type`, async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(example.body, { status: example.status, headers: { 'content-type': example.type } }));
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'api-secret');
  assert.deepEqual((await http.put('/projects/TEST/recipes/join', {})).data, example.expected);
});
test('invalid/truncated JSON diagnostics are contextual and sanitized', async t => {
  const body = '{"message":"Authorization: Bearer api-secret", "truncated":';
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
  const http = new SecureHttpClient(new URL('https://example.invalid/public/api/'), 'api-secret');
  await assert.rejects(http.get('/projects/TEST/recipes/join'), e => {
    assert.equal(e.details.status, 200); assert.equal(e.details.endpoint, '/projects/TEST/recipes/join');
    assert.equal(e.details.content_type, 'application/json'); assert.equal(e.details.body_length, Buffer.byteLength(body));
    assert.ok(!e.message.includes('api-secret')); assert.match(e.details.excerpt, /REDACTED/); return true;
  });
});
