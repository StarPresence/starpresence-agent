#!/usr/bin/env node

// Deliberately read-only production canary. It exercises only service
// discovery, tool discovery, and location listing for a dedicated synthetic
// business. Drafting, submission, scheduling, and publishing are never called.

import { pathToFileURL } from 'node:url';
import {
  CliError,
  DEFAULT_ENDPOINT,
  callTool,
  parseRpcBody,
  resolveTimeoutMs,
} from '../src/mcp.js';

export const CANARY_CALLS = Object.freeze([
  'public:get_service_info',
  'public:tools/list',
  'authenticated:tools/list',
  'authenticated:list_locations',
]);

function canaryError(message) {
  return new CliError('canary_failed', message);
}

async function listTools({ endpoint, apiKey, isPublic, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = isPublic ? `${endpoint}public` : endpoint;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (!isPublic) headers.authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    if (!response.ok) throw canaryError(`tools/list returned HTTP ${response.status}`);

    const rpc = parseRpcBody(response.headers.get('content-type'), await response.text());
    if (rpc.error) throw canaryError(rpc.error.message || 'tools/list returned a JSON-RPC error');
    if (!Array.isArray(rpc.result?.tools)) throw canaryError('tools/list response is missing tools');
    return rpc.result.tools;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new CliError('timeout', `request timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function assertToolset(tools, requiredName, label) {
  const names = tools.map((tool) => tool?.name).filter(Boolean);
  if (!names.includes(requiredName)) {
    throw canaryError(`${label} tools/list is missing ${requiredName}`);
  }
  const directPostingTool = names.find((name) => /publish|(^|[_-])post([_-]|$)/i.test(name));
  if (directPostingTool) {
    throw canaryError(`${label} unexpectedly exposes direct posting tool ${directPostingTool}`);
  }
  return names;
}

export async function runProductionCanary({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = env.STARREVIEW_CANARY_API_KEY;
  if (!apiKey?.startsWith('sragt_')) {
    throw new CliError(
      'invalid_configuration',
      'STARREVIEW_CANARY_API_KEY must be a dedicated sragt_ key for the synthetic canary business',
    );
  }

  const endpoint = env.STARREVIEW_CANARY_MCP_URL || DEFAULT_ENDPOINT;
  if (!endpoint.startsWith('https://') || !endpoint.endsWith('/')) {
    throw new CliError(
      'invalid_configuration',
      'STARREVIEW_CANARY_MCP_URL must be an HTTPS URL ending in /',
    );
  }
  const timeoutMs = resolveTimeoutMs(env);
  const cliEnv = {
    STARREVIEW_API_KEY: apiKey,
    STARREVIEW_MCP_URL: endpoint,
    ...(env.STARREVIEW_TIMEOUT_MS === undefined
      ? {}
      : { STARREVIEW_TIMEOUT_MS: env.STARREVIEW_TIMEOUT_MS }),
  };

  await callTool({
    name: 'get_service_info',
    args: {},
    isPublic: true,
    env: cliEnv,
    fetchImpl,
  });
  const publicTools = await listTools({
    endpoint,
    apiKey,
    isPublic: true,
    timeoutMs,
    fetchImpl,
  });
  const authenticatedTools = await listTools({
    endpoint,
    apiKey,
    isPublic: false,
    timeoutMs,
    fetchImpl,
  });
  await callTool({
    name: 'list_locations',
    args: {},
    env: cliEnv,
    fetchImpl,
  });

  const publicNames = assertToolset(publicTools, 'get_service_info', 'public');
  const authenticatedNames = assertToolset(authenticatedTools, 'list_locations', 'authenticated');
  return {
    ok: true,
    endpoint,
    checks: CANARY_CALLS,
    publicToolCount: publicNames.length,
    authenticatedToolCount: authenticatedNames.length,
  };
}

async function runFromCommandLine() {
  try {
    const result = await runProductionCanary();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      error: err instanceof CliError ? err.code : 'canary_failed',
      message: err?.message || String(err),
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromCommandLine();
}
