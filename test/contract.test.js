// Release compatibility gate: every request shape emitted by the CLI must
// validate against the exact @starreview/mcp contract this package declares.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { main } from '../src/cli.js';

const require = createRequire(import.meta.url);
const cliPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mcpPackage = require('@starreview/mcp/package.json');
const contract = require('@starreview/mcp/agent-contract.generated.json');

const ENV = { STARREVIEW_API_KEY: 'sragt_contract_test' };

function envelope(payload) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  };
}

function contractFetch() {
  const calls = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });

    let payload = { ok: true };
    if (body.params.name === 'search_business') {
      payload = { candidates: [{ placeId: 'place-1' }, { placeId: 'place-2' }] };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(envelope(payload)),
    };
  };
  impl.calls = calls;
  return impl;
}

function capture() {
  return { out: () => {}, err: () => {} };
}

test('the CLI pins and loads the coordinated MCP contract version', () => {
  assert.equal(cliPackage.devDependencies['@starreview/mcp'], '0.6.1');
  assert.equal(mcpPackage.version, '0.6.1');
  assert.equal(contract.serverVersion, '0.6.1');
  assert.equal(contract.agentConsent.currentVersion, '2026-07-24-v2');
  assert.equal(contract.agentConsent.privacyDocumentKey, 'agent_mcp_privacy');
  assert.equal(contract.agentConsent.privacyCurrentVersion, '2026-07-24-v2');
  assert.equal(contract.agentConsent.requiredForAutomaticScheduling, true);
  assert.equal(contract.agentConsent.staleCredentialBehavior, 'submission_succeeds_pending');
  assert.equal(contract.agentConsent.staleSubmissionReason, 'agent_consent_upgrade_required');
  assert.equal(contract.publishingPolicy.agentCanPost, false);
  assert.equal(contract.publishingPolicy.eligibleUneditedStarReviewDraftMayAutoSchedule, true);
  assert.equal(contract.publishingPolicy.agentAuthoredRepliesRequireApproval, true);
  assert.equal(contract.publishingPolicy.editedRepliesRequireApproval, true);
  assert.equal(contract.publishingPolicy.safetyHeldRepliesRequireApproval, true);
  assert.equal(contract.publishingPolicy.unsupportedProvidersRequireManualPost, true);
});

test('the coordinated contract requires draft variants to be positive integers', () => {
  const submit = contract.authenticatedTools.find((tool) => tool.name === 'submit_reply_for_approval');
  assert.ok(submit, 'submit_reply_for_approval is missing from the MCP contract');
  assert.equal(submit.inputSchema.properties.variant.type, 'integer');
  assert.equal(submit.inputSchema.properties.variant.minimum, 1);
});

test('every CLI request validates against its real MCP tool input schema', async () => {
  const fetchImpl = contractFetch();
  const io = capture();
  const commands = [
    ['locations', '--business', 'business-1'],
    ['reviews', '--business', 'business-1', '--location', 'location-1', '--provider', 'google', '--limit', '50'],
    ['stats', '--business', 'business-1', '--location', 'location-1', '--days', '3650'],
    ['review', 'review-1'],
    ['draft', 'review-1'],
    ['submit', 'review-1', '--variant', '1', '--post-at', '2026-07-25T10:00:00.000Z'],
    ['submit', 'review-1', '--variant', '2', '--text', 'Edited reply'],
    ['submit', 'review-1', '--text', 'Agent-authored reply'],
    ['info'],
    ['check', '--place', 'place-1', '--lang', 'en'],
    ['check', 'Restaurant', 'Adler', 'Zurich', '--lang', 'de'],
  ];

  for (const argv of commands) {
    assert.equal(await main(argv, io, { env: ENV, fetchImpl }), 0, argv.join(' '));
  }

  const tools = [...contract.authenticatedTools, ...contract.publicTools];
  const schemaByName = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
  const ajv = new Ajv({ allErrors: true, strict: false });

  assert.ok(fetchImpl.calls.length > 0);
  for (const { body } of fetchImpl.calls) {
    assert.equal(body.method, 'tools/call');
    const { name, arguments: args } = body.params;
    const schema = schemaByName.get(name);
    assert.ok(schema, `CLI emitted unknown MCP tool ${name}`);
    const validate = ajv.compile(schema);
    assert.equal(
      validate(args),
      true,
      `${name} arguments failed the MCP contract: ${ajv.errorsText(validate.errors)}`,
    );
  }
});
