import test from 'node:test';
import assert from 'node:assert/strict';
import { DataikuClient } from '../dist/dataiku-client.js';
import { readTsvSample, SAMPLE_BYTE_LIMIT } from '../dist/dataset-sample.js';
const client = () => new DataikuClient({ host: 'https://dss.invalid', apiKey: 'test-secret', readOnly: true });
const schema = { columns: [{ name: 'id', type: 'bigint' }, { name: 'text', type: 'string' }] };
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('metrics uses official non-partitioned last/NP endpoint', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(new URL(url).pathname, '/public/api/projects/P/datasets/D/metrics/last/NP');
    return json({ metrics: [] });
  });
  assert.deepEqual(await client().getDatasetMetrics('P', 'D'), { metrics: [] });
});
test('sample uses official data/ TSV; projects columns locally; preserves bigint text', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const u = new URL(url); calls.push(u); assert.equal(init.method, 'GET');
    if (u.pathname.endsWith('/schema')) return json(schema);
    assert.ok(u.pathname.endsWith('/data/')); assert.equal(u.searchParams.get('format'), 'tsv-excel-noheader');
    assert.ok(u.searchParams.get('readSessionId')); assert.equal(u.searchParams.has('rows'), false);
    return new Response('9007199254740999\t"hello\tworld"\n2\tsecond\n');
  });
  const result = await client().getDatasetSample('P', 'D', 1, ['text', 'id']);
  assert.deepEqual(result.rows, [['hello\tworld', '9007199254740999']]);
  assert.equal(result.limit_reached, true); assert.equal(result.complete, false); assert.equal(calls.length, 2);
});
test('empty dataset / exhausted sample checks official finish-streaming endpoint with same session', async t => {
  let session;
  t.mock.method(globalThis, 'fetch', async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/schema')) return json(schema);
    if (u.pathname.endsWith('/data/')) { session = u.searchParams.get('readSessionId'); return new Response(''); }
    assert.ok(u.pathname.endsWith('/finish-streaming/')); assert.equal(u.searchParams.get('readSessionId'), session);
    return new Response(null, { status: 204 });
  });
  const result = await client().getDatasetSample('P', 'D', 2); assert.equal(result.row_count, 0); assert.equal(result.complete, true);
});
for (const rows of [0, -1, 1001, 1.5, NaN, '10']) test(`invalid sample bound ${rows} rejects before network`, async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('No network expected'); });
  await assert.rejects(client().getDatasetSample('P', 'D', rows));
});
for (const columns of [['missing'], ['id', 'id'], []]) test(`invalid sample columns ${columns} never reads data`, async t => {
  t.mock.method(globalThis, 'fetch', async url => { assert.ok(new URL(url).pathname.endsWith('/schema')); return json(schema); });
  await assert.rejects(client().getDatasetSample('P', 'D', 1, columns));
});
test('TSV handles UTF-8 chunk splits, quotes, tabs, multiline values, CRLF and final unterminated row', async () => {
  const raw = new TextEncoder().encode('1\t"é\tline\n""quoted"""\r\n2\tlast');
  const stream = new ReadableStream({ start(c) { for (const byte of raw) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const result = await readTsvSample(new Response(stream), 3, 2);
  assert.deepEqual(result.rows, [['1', 'é\tline\n"quoted"'], ['2', 'last']]); assert.equal(result.complete, true);
});
test('row limit cancels stream without consuming subsequent chunks', async () => {
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(c) { pulls++; c.enqueue(new TextEncoder().encode('1\tx\n')); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const result = await readTsvSample(new Response(stream), 1, 2);
  assert.equal(result.rows.length, 1); assert.equal(pulls, 1); assert.equal(cancelled, true);
});
test('byte bound cancels and fails without leaking data', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(SAMPLE_BYTE_LIMIT + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readTsvSample(new Response(stream), 1, 2), /byte limit/); assert.equal(cancelled, true);
});
for (const text of ['1\n', '1\t"unfinished', '1\t"closed"junk\n']) test('malformed TSV fails with data-free diagnostics', async () => {
  await assert.rejects(readTsvSample(new Response(text), 2, 2), /schema|quoted/);
});
test('sample rejects HTML instead of interpreting it as a dataset', async t => {
  t.mock.method(globalThis, 'fetch', async url => new URL(url).pathname.endsWith('/schema') ? json(schema) : new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(client().getDatasetSample('P', 'D'), /non-TSV/);
});
