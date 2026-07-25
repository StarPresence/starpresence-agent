import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const publishWorkflow = readFileSync(
  new URL('../.github/workflows/npm-publish.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const canaryWorkflow = readFileSync(
  new URL('../.github/workflows/production-canary.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const ciWorkflow = readFileSync(
  new URL('../.github/workflows/ci.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

function jobBlock(workflow, name, nextName = null) {
  const startMarker = `\n  ${name}:\n`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `workflow is missing ${name}`);
  if (!nextName) return workflow.slice(start);
  const end = workflow.indexOf(`\n  ${nextName}:\n`, start + startMarker.length);
  assert.notEqual(end, -1, `workflow is missing ${nextName}`);
  return workflow.slice(start, end);
}

test('secret-bearing canary jobs depend on an exact main-ref guard', () => {
  for (const workflow of [publishWorkflow, canaryWorkflow]) {
    const guard = jobBlock(
      workflow,
      'release-ref',
      workflow === publishWorkflow ? 'candidate' : 'read-only-canary',
    );
    assert.match(guard, /GITHUB_REF[^]*refs\/heads\/main/);
  }

  const publishCandidate = jobBlock(publishWorkflow, 'candidate', 'publish');
  assert.match(publishCandidate, /needs:\s*release-ref/);
  assert.match(publishCandidate, /environment:\s*production-canary/);

  const standaloneCanary = jobBlock(canaryWorkflow, 'read-only-canary');
  assert.match(standaloneCanary, /needs:\s*release-ref/);
  assert.match(standaloneCanary, /environment:\s*production-canary/);
});

test('OIDC only promotes the exact tested candidate artifact', () => {
  const candidate = jobBlock(publishWorkflow, 'candidate', 'publish');
  const publish = jobBlock(publishWorkflow, 'publish', 'verify_registry');
  const verifyRegistry = jobBlock(publishWorkflow, 'verify_registry');

  assert.doesNotMatch(candidate, /id-token:\s*write/);
  assert.match(candidate, /sha256sum/);
  assert.match(candidate, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(candidate, /production-canary\.mjs/);

  assert.match(publish, /id-token:\s*write/);
  assert.match(publish, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(publish, /sha256sum --check/);
  assert.match(
    publish,
    /npm publish "\$STARREVIEW_CANDIDATE_TARBALL" --access public --provenance --ignore-scripts/,
  );
  assert.match(publish, /Node[^]*22\.14\.0/);
  assert.match(publish, /npm[^]*11\.5\.1/);
  assert.doesNotMatch(publish, /\bnpm (?:install|ci|test|run)\b/);
  assert.doesNotMatch(publish, /\bnpm (?:view|pack)\b/);
  assert.doesNotMatch(publish, /actions\/checkout/);

  assert.match(verifyRegistry, /needs:[^]*candidate[^]*publish/);
  assert.doesNotMatch(verifyRegistry, /id-token:\s*write/);
  assert.match(verifyRegistry, /npm view "\$package_spec" version/);
  assert.match(verifyRegistry, /npm pack "\$package_spec"/);
  assert.match(verifyRegistry, /registry_sha256/);
});

test('all GitHub Actions are pinned to immutable commit SHAs', () => {
  for (const [name, workflow] of [
    ['ci', ciWorkflow],
    ['npm-publish', publishWorkflow],
    ['production-canary', canaryWorkflow],
  ]) {
    const refs = [...workflow.matchAll(/^\s*-\s+uses:\s+\S+@(\S+)\s*$/gm)]
      .map((match) => match[1]);
    assert.ok(refs.length > 0, `${name} has no external actions`);
    for (const ref of refs) {
      assert.match(ref, /^[0-9a-f]{40}$/, `${name} uses mutable action ref ${ref}`);
    }
  }
});
