import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const workflow = readFileSync(
  new URL('../.circleci/config.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const manifest = JSON.parse(readFileSync(
  new URL('../release/cli-0.1.1.json', import.meta.url),
  'utf8',
));

function jobBlock(name, nextName = null) {
  const startMarker = `\n  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `workflow is missing ${name}`);
  if (!nextName) return workflow.slice(start);
  const end = workflow.indexOf(`\n  ${nextName}:\n`, start + startMarker.length);
  assert.notEqual(end, -1, `workflow is missing ${nextName}`);
  return workflow.slice(start, end);
}

test('every pipeline runs the supported compatibility matrix', () => {
  const compatibility = jobBlock('compatibility', 'candidate');
  assert.match(compatibility, /npm install --ignore-scripts/);
  assert.match(compatibility, /npm test/);
  assert.match(compatibility, /npm run pack:check/);
  for (const version of ['18.17.0', '20.19.4', '22.17.1']) {
    assert.match(workflow, new RegExp(`"${version.replaceAll('.', '\\.')}"`));
  }
});

test('release jobs require an exact GitHub App main push', () => {
  const candidate = jobBlock('candidate', 'publish');
  const publish = jobBlock('publish', 'verify_registry');
  for (const block of [candidate, publish]) {
    assert.match(block, /Fabsbags\/starreview-agent/);
    assert.match(block, /PIPELINE_CONFIG_REF/);
    assert.match(block, /refs\/heads\/main/);
    assert.match(block, /PIPELINE_EVENT_NAME/);
    assert.match(block, /PIPELINE_CONFIG_SHA/);
    assert.match(block, /PIPELINE_GIT_REVISION/);
  }

  const filter = 'filters: pipeline.git.branch == "main" and pipeline.config.ref == "refs/heads/main" and pipeline.event.name == "push"';
  assert.equal(workflow.split(filter).length - 1, 3);
});

test('candidate requires passed canary evidence and canonical bytes', () => {
  const candidate = jobBlock('candidate', 'publish');
  assert.match(candidate, /productionCanary\?\.status !== 'passed'/);
  assert.match(candidate, /credentialRevokedAt/);
  assert.match(candidate, /artifactSha256 !== manifest\.sha256/);
  assert.match(candidate, /npm test/);
  assert.match(candidate, /npm pack --silent --ignore-scripts/);
  assert.match(candidate, /Candidate differs from the canonical canaried Linux artifact/);
  assert.match(candidate, /persist_to_workspace/);
});

test('only checkout-free publish job requests short-lived npm OIDC', () => {
  const candidate = jobBlock('candidate', 'publish');
  const publish = jobBlock('publish', 'verify_registry');
  const verifyRegistry = jobBlock('verify_registry');

  assert.match(publish, /sha256sum --check/);
  assert.match(publish, /circleci run oidc get/);
  assert.match(publish, /NPM_ID_TOKEN="\$oidc_token" npm publish/);
  assert.match(publish, /NPM_TOKEN/);
  assert.match(publish, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(publish, /\bnpm (?:install|ci|test|run)\b/);
  assert.doesNotMatch(publish, /\bnpm pack\b/);
  assert.doesNotMatch(publish, /(?:^|\n)\s+- checkout(?:\n|$)/);
  assert.doesNotMatch(publish, /--provenance/);

  assert.doesNotMatch(candidate, /circleci run oidc get/);
  assert.doesNotMatch(verifyRegistry, /circleci run oidc get/);
  assert.equal(workflow.split('npm-trusted-publishing').length - 1, 1);
});

test('release manifest binds exact Linux artifact and payload', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.package, '@starreview/cli');
  assert.equal(manifest.version, '0.1.1');
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.packedWith, {
    os: 'linux',
    node: '24.18.0',
    npm: '11.16.0',
  });
  assert.equal(manifest.productionCanary.artifactSha256, manifest.sha256);
  assert.deepEqual(manifest.contents, [
    'package/LICENSE',
    'package/README.md',
    'package/SKILL.md',
    'package/bin/starreview.js',
    'package/package.json',
    'package/scripts/production-canary.mjs',
    'package/src/cli.js',
    'package/src/mcp.js',
  ]);
});
