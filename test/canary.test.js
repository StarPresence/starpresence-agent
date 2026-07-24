import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANARY_CALLS, runProductionCanary } from '../scripts/production-canary.mjs';

function envelope(payload) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  };
}

function fakeCanaryFetch() {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });

    const responseBody = body.method === 'tools/list'
      ? {
          jsonrpc: '2.0',
          id: 1,
          result: {
            tools: url.endsWith('/public')
              ? [{ name: 'get_service_info' }, { name: 'search_business' }]
              : [{ name: 'list_locations' }, { name: 'draft_reply' }, { name: 'submit_reply_for_approval' }],
          },
        }
      : envelope(body.params.name === 'list_locations' ? { locations: [] } : { service: 'StarReview' });

    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(responseBody),
    };
  };
  impl.calls = calls;
  return impl;
}

test('production canary is restricted to the four approved read-only checks', async () => {
  assert.deepEqual(CANARY_CALLS, [
    'public:get_service_info',
    'public:tools/list',
    'authenticated:tools/list',
    'authenticated:list_locations',
  ]);

  const fetchImpl = fakeCanaryFetch();
  const result = await runProductionCanary({
    env: { STARREVIEW_CANARY_API_KEY: 'sragt_synthetic_canary' },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 4);
  assert.deepEqual(
    fetchImpl.calls.map(({ body }) => (
      body.method === 'tools/list' ? 'tools/list' : body.params.name
    )),
    ['get_service_info', 'tools/list', 'tools/list', 'list_locations'],
  );
  assert.equal(fetchImpl.calls[0].headers.authorization, undefined);
  assert.equal(fetchImpl.calls[1].headers.authorization, undefined);
  assert.equal(fetchImpl.calls[2].headers.authorization, 'Bearer sragt_synthetic_canary');
  assert.equal(fetchImpl.calls[3].headers.authorization, 'Bearer sragt_synthetic_canary');
});

test('production canary refuses a non-dedicated credential before network access', async () => {
  const fetchImpl = fakeCanaryFetch();
  await assert.rejects(
    runProductionCanary({ env: { STARREVIEW_CANARY_API_KEY: 'not-an-agent-key' }, fetchImpl }),
    (err) => err.code === 'invalid_configuration',
  );
  assert.equal(fetchImpl.calls.length, 0);
});
