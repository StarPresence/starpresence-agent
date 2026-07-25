// Hermetic tests for the starreview CLI: fetch is injected, no network ever.
// Covers the output contract (one JSON doc on stdout, error shape + exit
// codes), the double-parse envelope, SSE parsing, auth failures, command->tool
// mapping, and the submit dispatch (--variant vs --text).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  parseRpcBody,
  callTool,
  CliError,
  resolveTimeoutMs,
} from '../src/mcp.js';

const ENV = { STARREVIEW_API_KEY: 'sragt_testkey' };

function envelope(payload, { isError = false } = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] },
  };
}

function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const out = responder(body, url);
    return {
      ok: out.status ? out.status < 400 : true,
      status: out.status ?? 200,
      headers: { get: (k) => (k === 'content-type' ? (out.contentType ?? 'application/json') : null) },
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

function capture() {
  const io = { outLines: [], errLines: [] };
  io.out = (s) => io.outLines.push(s);
  io.err = (s) => io.errLines.push(s);
  return io;
}

test('reviews maps to list_unanswered_reviews with flags passed through', async () => {
  const fetchImpl = fakeFetch(() => ({ body: envelope([{ reviewId: 'r1', provider: 'google' }]) }));
  const io = capture();
  const code = await main(
    ['reviews', '--provider', 'google', '--limit', '5', '--business', 'biz-1'],
    io,
    { env: ENV, fetchImpl },
  );
  assert.equal(code, 0);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://mcp.starreview.ch/');
  assert.equal(call.headers.authorization, 'Bearer sragt_testkey');
  assert.deepEqual(call.body.params, {
    name: 'list_unanswered_reviews',
    arguments: { businessId: 'biz-1', provider: 'google', limit: 5 },
  });
  assert.deepEqual(JSON.parse(io.outLines[0]), [{ reviewId: 'r1', provider: 'google' }]);
});

test('submit --variant commits a draft; submit --text alone takes the own-reply tool', async () => {
  const fetchImpl = fakeFetch(() => ({ body: envelope({ submitted: true }) }));
  const io = capture();

  assert.equal(await main(['submit', 'rev-1', '--variant', '2', '--text', 'edited'], io, { env: ENV, fetchImpl }), 0);
  assert.deepEqual(fetchImpl.calls[0].body.params, {
    name: 'submit_reply_for_approval',
    arguments: { reviewId: 'rev-1', variant: 2, finalText: 'edited' },
  });

  assert.equal(await main(['submit', 'rev-1', '--text', 'my own reply'], io, { env: ENV, fetchImpl }), 0);
  assert.deepEqual(fetchImpl.calls[1].body.params, {
    name: 'submit_own_reply',
    arguments: { reviewId: 'rev-1', finalText: 'my own reply' },
  });
});

test('submit without --variant or --text is a usage error (exit 2, nothing sent)', async () => {
  const fetchImpl = fakeFetch(() => ({ body: envelope({}) }));
  const io = capture();
  assert.equal(await main(['submit', 'rev-1'], io, { env: ENV, fetchImpl }), 2);
  assert.equal(fetchImpl.calls.length, 0);
});

test('stats maps to get_review_stats with days as integer', async () => {
  const fetchImpl = fakeFetch(() => ({ body: envelope({ totalReviews: 10, byProvider: {} }) }));
  const io = capture();
  assert.equal(await main(['stats', '--days', '30'], io, { env: ENV, fetchImpl }), 0);
  assert.deepEqual(fetchImpl.calls[0].body.params, { name: 'get_review_stats', arguments: { days: 30 } });
});

test('numeric flags require complete, bounded positive integers', async () => {
  const malformed = ['0', '1.5', '1day', '+1', '-1', ' 1', '1 ', '', '9007199254740992'];
  const cases = [
    ...malformed.map((value) => ['reviews', '--limit', value]),
    ['reviews', '--limit', '51'],
    ...malformed.map((value) => ['stats', '--days', value]),
    ['stats', '--days', '3651'],
    ...malformed.map((value) => ['submit', 'rev-1', '--variant', value]),
  ];

  for (const argv of cases) {
    const fetchImpl = fakeFetch(() => ({ body: envelope({}) }));
    const io = capture();
    assert.equal(await main(argv, io, { env: ENV, fetchImpl }), 2, argv.join(' '));
    assert.equal(fetchImpl.calls.length, 0, argv.join(' '));
  }
});

test('numeric flags accept their inclusive boundaries', async () => {
  const fetchImpl = fakeFetch(() => ({ body: envelope({ ok: true }) }));
  const io = capture();

  assert.equal(await main(['reviews', '--limit', '1'], io, { env: ENV, fetchImpl }), 0);
  assert.equal(await main(['reviews', '--limit', '50'], io, { env: ENV, fetchImpl }), 0);
  assert.equal(await main(['stats', '--days', '1'], io, { env: ENV, fetchImpl }), 0);
  assert.equal(await main(['stats', '--days', '3650'], io, { env: ENV, fetchImpl }), 0);
  assert.equal(
    await main(['submit', 'rev-1', '--variant', String(Number.MAX_SAFE_INTEGER)], io, { env: ENV, fetchImpl }),
    0,
  );
});

test('info and check use the credential-less public endpoint (no auth header)', async () => {
  const fetchImpl = fakeFetch((body) => {
    if (body.params.name === 'search_business') {
      return { body: envelope({ candidates: [{ placeId: 'p1', name: 'Adler' }] }) };
    }
    return { body: envelope({ responseRatePct: 8 }) };
  });
  const io = capture();

  assert.equal(await main(['info'], io, { env: {}, fetchImpl }), 0);
  assert.equal(fetchImpl.calls[0].url, 'https://mcp.starreview.ch/public');
  assert.equal(fetchImpl.calls[0].headers.authorization, undefined);

  // single candidate -> auto rate-check, combined payload
  assert.equal(await main(['check', 'Restaurant Adler Zuerich'], io, { env: {}, fetchImpl }), 0);
  const combined = JSON.parse(io.outLines.at(-1));
  assert.equal(combined.candidate.placeId, 'p1');
  assert.equal(combined.check.responseRatePct, 8);
});

test('check with multiple candidates returns them + a hint, never guesses', async () => {
  const fetchImpl = fakeFetch(() => ({
    body: envelope({ candidates: [{ placeId: 'p1' }, { placeId: 'p2' }] }),
  }));
  const io = capture();
  assert.equal(await main(['check', 'Cafe Central'], io, { env: {}, fetchImpl }), 0);
  const out = JSON.parse(io.outLines[0]);
  assert.equal(out.candidates.length, 2);
  assert.match(out.hint, /--place/);
  assert.equal(fetchImpl.calls.length, 1); // no second (rate-check) call
});

test('missing API key on an authenticated command: JSON error, exit 1, no request', async () => {
  const fetchImpl = fakeFetch(() => ({ body: envelope({}) }));
  const io = capture();
  assert.equal(await main(['reviews'], io, { env: {}, fetchImpl }), 1);
  const err = JSON.parse(io.outLines[0]);
  assert.equal(err.error, 'missing_api_key');
  assert.match(err.message, /STARREVIEW_API_KEY/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a 401 maps to unauthorized with a fix-it message', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 401, body: { error: 'invalid_agent_token' } }));
  const io = capture();
  assert.equal(await main(['locations'], io, { env: ENV, fetchImpl }), 1);
  assert.equal(JSON.parse(io.outLines[0]).error, 'unauthorized');
});

test('a tool refusal surfaces its machine code from the double-parsed envelope', async () => {
  const fetchImpl = fakeFetch(() => ({ body: envelope({ code: 'review_not_pending' }, { isError: true }) }));
  const io = capture();
  assert.equal(await main(['draft', 'rev-1'], io, { env: ENV, fetchImpl }), 1);
  assert.equal(JSON.parse(io.outLines[0]).error, 'review_not_pending');
});

test('parseRpcBody handles one-shot SSE streams', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n';
  const rpc = parseRpcBody('text/event-stream', sse);
  assert.equal(rpc.result.content[0].text, '{"ok":true}');
});

test('callTool: network failure maps to network_error', async () => {
  await assert.rejects(
    callTool({ name: 'get_service_info', isPublic: true, env: {}, fetchImpl: async () => { throw new Error('offline'); } }),
    (err) => err instanceof CliError && err.code === 'network_error',
  );
});

test('timeout configuration defaults to 120 seconds and enforces its exact range', () => {
  assert.equal(resolveTimeoutMs({}), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ STARREVIEW_TIMEOUT_MS: String(MIN_TIMEOUT_MS) }), MIN_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ STARREVIEW_TIMEOUT_MS: String(MAX_TIMEOUT_MS) }), MAX_TIMEOUT_MS);

  for (const value of ['', '999', '600001', '1.5', '1000ms', ' 1000', '1000 ']) {
    assert.throws(
      () => resolveTimeoutMs({ STARREVIEW_TIMEOUT_MS: value }),
      (err) => err instanceof CliError && err.code === 'invalid_configuration',
      value,
    );
  }
});

test('invalid timeout configuration returns stable JSON without making a request', async () => {
  const fetchImpl = fakeFetch(() => ({ body: envelope({}) }));
  const io = capture();
  const code = await main(
    ['info'],
    io,
    { env: { STARREVIEW_TIMEOUT_MS: 'later' }, fetchImpl },
  );

  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(io.outLines[0]), {
    error: 'invalid_configuration',
    message: 'STARREVIEW_TIMEOUT_MS must be an integer between 1000 and 600000',
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('timeout aborts a request that has not produced response headers', async () => {
  let fireTimeout;
  let sentSignal;
  const fetchImpl = async (_url, init) => {
    sentSignal = init.signal;
    return new Promise(() => {});
  };
  const io = capture();
  const result = main(
    ['info'],
    io,
    {
      env: { STARREVIEW_TIMEOUT_MS: '1000' },
      fetchImpl,
      setTimeoutImpl: (fn) => {
        fireTimeout = fn;
        return 1;
      },
      clearTimeoutImpl: () => {},
    },
  );

  await Promise.resolve();
  fireTimeout();
  assert.equal(await result, 1);
  assert.equal(sentSignal.aborted, true);
  assert.deepEqual(JSON.parse(io.outLines[0]), {
    error: 'timeout',
    message: 'request timed out after 1000 ms',
  });
});

test('timeout also aborts response-body reading', async () => {
  let fireTimeout;
  let signal;
  let markBodyStarted;
  const bodyStarted = new Promise((resolve) => {
    markBodyStarted = resolve;
  });
  const fetchImpl = async (_url, init) => {
    signal = init.signal;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: () => {
        markBodyStarted();
        return new Promise(() => {});
      },
    };
  };
  const io = capture();
  const result = main(
    ['info'],
    io,
    {
      env: { STARREVIEW_TIMEOUT_MS: '1000' },
      fetchImpl,
      setTimeoutImpl: (fn) => {
        fireTimeout = fn;
        return 1;
      },
      clearTimeoutImpl: () => {},
    },
  );

  await bodyStarted;
  fireTimeout();
  assert.equal(await result, 1);
  assert.equal(signal.aborted, true);
  assert.equal(JSON.parse(io.outLines[0]).error, 'timeout');
});

test('unknown command prints usage and exits 2', async () => {
  const io = capture();
  assert.equal(await main(['frobnicate'], io, {}), 2);
  assert.match(io.errLines[0], /unknown command/);
});
