import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANARY_CALLS, CANARY_HELP, runProductionCanary } from '../scripts/production-canary.mjs';

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
      : envelope(body.params.name === 'list_locations'
          ? [{ locationId: 'location-synthetic', name: 'Synthetic Canary', status: 'active' }]
          : { service: 'StarReview' });

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
    env: {
      STARREVIEW_CANARY_API_KEY: 'sragt_synthetic_canary',
      STARREVIEW_CANARY_BUSINESS_ID: 'business-synthetic',
    },
    fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.equal(result.businessId, 'business-synthetic');
  assert.equal(result.locationCount, 1);
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
  assert.deepEqual(fetchImpl.calls[3].body.params.arguments, {
    businessId: 'business-synthetic',
  });
});

test('production canary refuses a non-dedicated credential before network access', async () => {
  const fetchImpl = fakeCanaryFetch();
  await assert.rejects(
    runProductionCanary({ env: { STARREVIEW_CANARY_API_KEY: 'not-an-agent-key' }, fetchImpl }),
    (err) => (
      err.code === 'invalid_configuration'
      && /legacy\/admin-issued/.test(err.message)
      && /account-wide self-service/.test(err.message)
    ),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('production canary help makes the per-business credential limitation explicit', () => {
  assert.match(CANARY_HELP, /legacy\/admin-issued sragt_ credential pinned/i);
  assert.match(CANARY_HELP, /account-wide self-service key is not valid/);
  assert.match(CANARY_HELP, /cannot\s+independently introspect the credential class/i);
});

test('production canary requires an explicit synthetic business before network access', async () => {
  const fetchImpl = fakeCanaryFetch();
  await assert.rejects(
    runProductionCanary({
      env: { STARREVIEW_CANARY_API_KEY: 'sragt_synthetic_canary' },
      fetchImpl,
    }),
    (err) => err.code === 'invalid_configuration' && /STARREVIEW_CANARY_BUSINESS_ID/.test(err.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('production canary rejects a multi-business picker', async () => {
  const fetchImpl = fakeCanaryFetch();
  const original = fetchImpl;
  const pickerFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.params?.name === 'list_locations') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(envelope({
          businesses: [{ businessId: 'business-synthetic' }, { businessId: 'business-other' }],
          hint: 'Choose a business.',
        })),
      };
    }
    return original(url, init);
  };

  await assert.rejects(
    runProductionCanary({
      env: {
        STARREVIEW_CANARY_API_KEY: 'sragt_synthetic_canary',
        STARREVIEW_CANARY_BUSINESS_ID: 'business-synthetic',
      },
      fetchImpl: pickerFetch,
    }),
    (err) => err.code === 'canary_failed' && /multi-business picker/.test(err.message),
  );
});

test('production canary rejects a location explicitly tagged for another business', async () => {
  const original = fakeCanaryFetch();
  const wrongBusinessFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.params?.name === 'list_locations') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify(envelope([{
          businessId: 'business-other',
          locationId: 'location-other',
          status: 'active',
        }])),
      };
    }
    return original(url, init);
  };

  await assert.rejects(
    runProductionCanary({
      env: {
        STARREVIEW_CANARY_API_KEY: 'sragt_synthetic_canary',
        STARREVIEW_CANARY_BUSINESS_ID: 'business-synthetic',
      },
      fetchImpl: wrongBusinessFetch,
    }),
    (err) => err.code === 'canary_failed' && /outside business-synthetic/.test(err.message),
  );
});
