/**
 * Minimal JSON-RPC client for the StarReview MCP endpoint.
 *
 * The server speaks MCP streamable HTTP (stateless): one POST per tools/call,
 * answered either as plain JSON or as a one-shot SSE stream. Every tool result
 * is double-encoded (JSON serialized inside result.content[0].text) — see the
 * "Result envelope: parse twice" section of the StarReview SKILL.md.
 *
 * No secrets live here: the only credential handled is the caller's own
 * STARREVIEW_API_KEY, read from the environment and sent as a Bearer header.
 */

export const DEFAULT_ENDPOINT = 'https://mcp.starreview.ch/';
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

export class CliError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function resolveEndpoint(env = process.env) {
  const raw = env.STARREVIEW_MCP_URL || DEFAULT_ENDPOINT;
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export function resolveApiKey(env = process.env) {
  return env.STARREVIEW_API_KEY || null;
}

export function resolveTimeoutMs(env = process.env) {
  const raw = env.STARREVIEW_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;

  if (!/^[0-9]+$/.test(raw)) {
    throw new CliError(
      'invalid_configuration',
      `STARREVIEW_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new CliError(
      'invalid_configuration',
      `STARREVIEW_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
  return value;
}

/** Extract the JSON body from a plain-JSON or one-shot SSE response. */
export function parseRpcBody(contentType, rawText) {
  if ((contentType || '').includes('text/event-stream')) {
    // One-shot SSE: take the LAST data: line that parses as JSON.
    let parsed = null;
    for (const line of rawText.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        parsed = JSON.parse(payload);
      } catch {
        // keep scanning; non-JSON data lines are not the RPC response
      }
    }
    if (parsed === null) throw new CliError('bad_response', 'no JSON data in event stream');
    return parsed;
  }
  try {
    return JSON.parse(rawText);
  } catch {
    throw new CliError('bad_response', `server answered non-JSON (${rawText.slice(0, 120)})`);
  }
}

/**
 * Call one MCP tool and return the decoded inner payload.
 *
 * @param {object} params
 * @param {string} params.name tool name
 * @param {object} [params.args] tool arguments
 * @param {boolean} [params.isPublic] use the credential-less /public endpoint
 * @param {object} [params.env] environment (injectable for tests)
 * @param {typeof fetch} [params.fetchImpl] fetch (injectable for tests)
 * @param {typeof setTimeout} [params.setTimeoutImpl] timer (injectable for tests)
 * @param {typeof clearTimeout} [params.clearTimeoutImpl] timer cleanup (injectable for tests)
 */
export async function callTool({
  name,
  args = {},
  isPublic = false,
  env = process.env,
  fetchImpl = fetch,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const timeoutMs = resolveTimeoutMs(env);
  const endpoint = resolveEndpoint(env);
  const url = isPublic ? `${endpoint}public` : endpoint;

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (!isPublic) {
    const key = resolveApiKey(env);
    if (!key) {
      throw new CliError(
        'missing_api_key',
        'STARREVIEW_API_KEY is not set. Create an agent key in your StarReview settings (Einstellungen -> Agent-Zugang) and export it: export STARREVIEW_API_KEY=sragt_...',
      );
    }
    headers.authorization = `Bearer ${key}`;
  }

  const controller = new AbortController();
  let didTimeout = false;
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeoutImpl(() => {
      didTimeout = true;
      controller.abort();
      reject(new CliError('timeout', `request timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const raceTimeout = (promise) => Promise.race([promise, timeoutPromise]);

  let res;
  let rawText;
  try {
    res = await raceTimeout(fetchImpl(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }));

    if (res.status === 401) {
      throw new CliError(
        'unauthorized',
        'The server rejected the credential (revoked, expired, or wrong STARREVIEW_API_KEY). Create a fresh agent key in your StarReview settings.',
      );
    }
    if (res.status === 403) {
      throw new CliError('forbidden', 'Agent access is currently disabled by the operator.');
    }
    if (!res.ok) {
      throw new CliError('http_error', `HTTP ${res.status} from ${url}`);
    }

    rawText = await raceTimeout(res.text());
  } catch (err) {
    if (didTimeout) {
      throw new CliError('timeout', `request timed out after ${timeoutMs} ms`);
    }
    if (err instanceof CliError) throw err;
    throw new CliError('network_error', `could not reach ${url}: ${err?.message || err}`);
  } finally {
    if (timer !== undefined) clearTimeoutImpl(timer);
  }

  const rpc = parseRpcBody(res.headers.get('content-type'), rawText);
  if (rpc.error) {
    throw new CliError('rpc_error', rpc.error.message || 'JSON-RPC error');
  }

  const result = rpc.result;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new CliError('bad_response', 'missing result content');
  }

  let inner;
  try {
    inner = JSON.parse(text);
  } catch {
    throw new CliError('bad_response', 'inner payload is not JSON');
  }

  if (result.isError) {
    throw new CliError(inner?.code || 'tool_error', inner?.message || `tool ${name} failed (${inner?.code || 'unknown'})`);
  }
  return inner;
}
