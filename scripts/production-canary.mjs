#!/usr/bin/env node

// Deliberately read-only production canary. It exercises only service
// discovery, tool discovery, and location listing for a dedicated synthetic
// business. Drafting, submission, scheduling, and publishing are never called.
// Credential class is an operational invariant: the sragt_ prefix cannot prove
// that the supplied key is legacy/admin-issued and pinned to one business.

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

const REQUIRED_PUBLIC_TOOLS = Object.freeze([
  'get_service_info',
]);

const REQUIRED_AUTHENTICATED_TOOLS = Object.freeze([
  'list_locations',
  'submit_reply_for_approval',
]);

const CURRENT_AGENT_CONSENT_VERSION = '2026-07-24-v2';

const REQUIRED_PUBLISHING_POLICY = Object.freeze({
  agentCanPost: false,
  eligibleUneditedStarReviewDraftMayAutoSchedule: true,
  agentAuthoredRepliesRequireApproval: true,
  editedRepliesRequireApproval: true,
  safetyHeldRepliesRequireApproval: true,
  unsupportedProvidersRequireManualPost: true,
  unsupportedProvidersRemainPendingUntilHumanApproval: true,
});

export const CANARY_HELP = `StarReview read-only production canary

Required environment:
  STARREVIEW_CANARY_API_KEY       Legacy/admin-issued sragt_ credential pinned
                                  to the dedicated synthetic business. An
                                  account-wide self-service key is not valid.
  STARREVIEW_CANARY_BUSINESS_ID   Expected synthetic business ID.

The canary scopes list_locations to the expected business and rejects picker,
empty, inactive, malformed, or explicitly mismatched results. It cannot
independently introspect the credential class, so operators must provision the
per-business credential correctly.`;

function canaryError(message) {
  return new CliError('canary_failed', message);
}

function assertServiceInfo(payload) {
  if (payload?.service !== 'StarPresence') {
    throw canaryError('get_service_info did not identify the StarPresence service');
  }
  if (payload?.pricing?.model !== 'subscription' || payload?.pricing?.chargedPerAction !== false) {
    throw canaryError('get_service_info must report subscription pricing with nothing charged per action');
  }
  if (payload?.agentConsentVersion !== CURRENT_AGENT_CONSENT_VERSION) {
    throw canaryError(
      `get_service_info must report Agent Consent ${CURRENT_AGENT_CONSENT_VERSION}`,
    );
  }
  for (const [fact, expected] of Object.entries(REQUIRED_PUBLISHING_POLICY)) {
    if (payload?.publishingPolicy?.[fact] !== expected) {
      throw canaryError(
        `get_service_info publishingPolicy.${fact} must be ${expected}`,
      );
    }
  }

  const publicTools = payload?.connect?.publicTools;
  for (const toolName of REQUIRED_PUBLIC_TOOLS) {
    if (!Array.isArray(publicTools) || !publicTools.includes(toolName)) {
      throw canaryError(`get_service_info is missing public tool ${toolName}`);
    }
  }
  if (
    payload?.connect?.oauth?.dynamicClientRegistration !== true
    || payload?.connect?.oauth?.pkceRequired !== true
  ) {
    throw canaryError('get_service_info is missing the required OAuth DCR/PKCE facts');
  }

  const policy = payload?.what;
  if (typeof policy !== 'string') {
    throw canaryError('get_service_info is missing its publishing-policy summary');
  }
  const requiredFacts = [
    [/can never post/i, 'agents can never post'],
    [/eligible,\s*unedited StarPresence draft may schedule under standing consent/i, 'eligible unedited drafts may schedule under standing consent'],
    [/agent-written,\s*edited,\s*or safety-held replies remain pending/i, 'agent-written, edited, and safety-held replies remain pending'],
    [/without a posting API[^.]*pending until a human approves/i, 'providers without a posting API remain pending until human approval'],
  ];
  for (const [pattern, label] of requiredFacts) {
    if (!pattern.test(policy)) {
      throw canaryError(`get_service_info is missing the canonical policy fact: ${label}`);
    }
  }
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

function assertAuthenticatedContract(tools) {
  for (const toolName of REQUIRED_AUTHENTICATED_TOOLS) {
    if (!tools.some((tool) => tool?.name === toolName)) {
      throw canaryError(`authenticated tools/list is missing ${toolName}`);
    }
  }
  const submit = tools.find((tool) => tool?.name === 'submit_reply_for_approval');
  if (submit?.inputSchema?.properties?.variant?.minimum !== 1) {
    throw canaryError(
      'authenticated submit_reply_for_approval must advertise variant.minimum=1',
    );
  }
}

function assertSyntheticLocations(payload, expectedBusinessId) {
  if (Array.isArray(payload?.businesses) || payload?.hint) {
    throw canaryError('list_locations returned a multi-business picker instead of the synthetic target');
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    throw canaryError('list_locations did not return locations for the synthetic target');
  }
  for (const location of payload) {
    if (typeof location?.locationId !== 'string' || location.locationId.length === 0) {
      throw canaryError('list_locations returned a location without a locationId');
    }
    if (location.businessId !== undefined && location.businessId !== expectedBusinessId) {
      throw canaryError(`list_locations returned a location outside ${expectedBusinessId}`);
    }
  }
  if (!payload.some((location) => location.status === 'active')) {
    throw canaryError('list_locations returned no active synthetic location');
  }
  return payload.length;
}

export async function runProductionCanary({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = env.STARREVIEW_CANARY_API_KEY;
  if (!apiKey?.startsWith('sragt_')) {
    throw new CliError(
      'invalid_configuration',
      'STARREVIEW_CANARY_API_KEY must be a legacy/admin-issued sragt_ credential pinned to the dedicated synthetic business; an account-wide self-service key is not valid',
    );
  }
  const businessId = env.STARREVIEW_CANARY_BUSINESS_ID;
  if (typeof businessId !== 'string' || businessId.trim() !== businessId || businessId.length === 0) {
    throw new CliError(
      'invalid_configuration',
      'STARREVIEW_CANARY_BUSINESS_ID must identify the dedicated synthetic canary business',
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

  const serviceInfo = await callTool({
    name: 'get_service_info',
    args: {},
    isPublic: true,
    env: cliEnv,
    fetchImpl,
  });
  assertServiceInfo(serviceInfo);
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
  const locations = await callTool({
    name: 'list_locations',
    args: { businessId },
    env: cliEnv,
    fetchImpl,
  });

  const publicNames = assertToolset(publicTools, 'get_service_info', 'public');
  const authenticatedNames = assertToolset(authenticatedTools, 'list_locations', 'authenticated');
  assertAuthenticatedContract(authenticatedTools);
  const locationCount = assertSyntheticLocations(locations, businessId);
  return {
    ok: true,
    endpoint,
    businessId,
    checks: CANARY_CALLS,
    publicToolCount: publicNames.length,
    authenticatedToolCount: authenticatedNames.length,
    locationCount,
  };
}

async function runFromCommandLine() {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    console.log(CANARY_HELP);
    return;
  }
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
