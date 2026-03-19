import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRecallQuery, buildRecentTail, extractLatestUserText } from '../src/query-builder.js';

test('extractLatestUserText finds latest user content', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: [{ text: 'latest ask' }] },
  ];
  assert.equal(extractLatestUserText(messages), 'latest ask');
});

test('buildRecentTail formats a compact role-tagged window', () => {
  const tail = buildRecentTail([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ], 4);
  assert.match(tail, /user: a/);
  assert.match(tail, /assistant: b/);
});

test('buildRecallQuery includes latest, tail, and hints', () => {
  const query = buildRecallQuery({
    latestUserText: 'fix the memory bridge',
    recentTail: 'assistant: planning',
    routeHint: 'code_mod',
    projectHint: 'vestige-bridge',
  });
  assert.match(query, /latest user turn:/);
  assert.match(query, /project hint:/);
  assert.match(query, /route hint:/);
});
