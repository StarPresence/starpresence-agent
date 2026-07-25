import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const COPY_FILES = [
  'README.md',
  'SKILL.md',
  'src/cli.js',
  'src/mcp.js',
];

test('public CLI copy never claims negative reviews must always remain pending', () => {
  const forbiddenClaims = [
    /\bnegative(?:\s+and\s+sensitive)?\s+reviews?\s+always\s+(?:wait|remain)\b/i,
    /\bnegative reviews?\b[^.!?\n]{0,120}\b(?:always|must)\b[^.!?\n]{0,80}\b(?:approval|human|pending|wait)\b/i,
  ];

  for (const file of COPY_FILES) {
    const copy = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const forbidden of forbiddenClaims) {
      assert.doesNotMatch(copy, forbidden, `${file} contains a negative-always-pending claim`);
    }
  }
});

test('skill documents owner-opted low-rating automation and the actual always-pending cases', () => {
  const skill = readFileSync(new URL('../SKILL.md', import.meta.url), 'utf8');
  assert.match(
    skill,
    /eligible, unedited StarReview draft for a 1–2-star review may be scheduled only when the owner explicitly opted into that automation/i,
  );
  assert.match(skill, /Safety-held, agent-written, and edited replies always remain pending/i);
});
