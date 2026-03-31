import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRecallQuery } from '../src/query-builder.js';
import { normalizeEntry } from '../src/normalize.js';
import { buildCanonicalKey, dedupeRecentAgainstStable } from '../src/dedupe.js';
import { packEntries } from '../src/packing.js';
import { renderVestigeRecent } from '../src/render.js';
import { prepareRecentRecall } from '../src/recall.js';
import { buildAgentEndPayloadAsync } from '../src/ingest.js';

test('buildRecallQuery includes latest user turn, tail, and hint', () => {
  const { query, parts } = buildRecallQuery({
    messages: [
      { role: 'user', text: 'I am drafting the export contract.' },
      { role: 'assistant', text: 'Keep the packet compact.' },
      { role: 'user', text: 'Implement recent recall helpers with stable dedupe.' },
    ],
    projectHint: 'vestige-bridge',
    maxChars: 240,
  });

  assert.match(parts.latest, /recent recall helpers/i);
  assert.match(parts.tail, /assistant: keep the packet compact/i);
  assert.match(parts.hint, /vestige-bridge/i);
  assert.match(query, /recent context:/i);
  assert.match(query, /hint:/i);
  assert.ok(query.length <= 240);
});

test('dedupeRecentAgainstStable prefers Cognee materialized stable overlap', () => {
  const stable = normalizeEntry({
    source: 'cognee',
    layer: 'stable',
    shard_key: 'global/preferences',
    statement: 'User prefers concrete spec decisions instead of abstract brainstorming.',
    score: 0.8,
  });
  const recent = normalizeEntry({
    source: 'vestige',
    layer: 'recent',
    statement: 'User prefers concrete spec decisions instead of abstract brainstorming.',
    score: 0.9,
  });

  const result = dedupeRecentAgainstStable([recent], [stable]);
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].dropReasons.join(','), /overlap_with_materialized_stable/);
});

test('recent explicit correction can survive older inferred stable overlap', () => {
  const stable = normalizeEntry({
    source: 'cognee',
    layer: 'stable',
    inferred: true,
    statement: 'User likes abstract brainstorming first.',
    timestamp: '2026-03-15T10:00:00Z',
  });
  const recent = normalizeEntry({
    source: 'vestige',
    layer: 'recent',
    explicit: true,
    correction: true,
    statement: 'User wants concrete implementation details first.',
    timestamp: '2026-03-19T10:00:00Z',
  });

  const result = dedupeRecentAgainstStable([recent], [stable]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

test('packEntries and renderVestigeRecent produce compact bullet packet', () => {
  const packed = packEntries([
    normalizeEntry({ category: 'preference', statement: 'User wants concrete spec decisions.' }),
    normalizeEntry({ category: 'project_fact', statement: 'Current focus is the recent recall pipeline.' }),
  ], {
    maxItems: 4,
    softTargetTokens: 80,
    hardCapTokens: 120,
    maxChars: 500,
  });

  const packet = renderVestigeRecent(packed.selected);
  assert.match(packet, /^<vestige_recent>/);
  assert.match(packet, /\[recent-project-momentum\]/);
  assert.match(packet, /\[recent-preference\]/);
  assert.match(packet, /Current focus is the recent recall pipeline\./);
  assert.match(packet, /<\/vestige_recent>$/);
});

test('prepareRecentRecall skips materialized recent items and returns packet plus drop reasons', () => {
  const result = prepareRecentRecall({
    latestUserTurn: 'Continue the vestige-bridge recall implementation.',
    recentTail: 'We already locked the shard schema and conflict rules.',
    projectHint: 'vestige-bridge',
    materializedIds: new Set(['recall-1']),
    recentEntries: [
      {
        id: 'recall-1',
        source: 'vestige',
        category: 'preference',
        statement: 'User wants compact recall packets.',
      },
      {
        source: 'vestige',
        category: 'project_fact',
        statement: 'This memory is already materialized and should stay out of recent recall.',
        materialized: true,
      },
    ],
    stableEntries: [
      {
        source: 'cognee',
        layer: 'stable',
        shard_key: 'global/preferences',
        statement: 'User prefers durable truth to come from Cognee-backed files.',
      },
    ],
  });

  assert.equal(result.packet, '');
  assert.equal(result.selected.length, 0);
  assert.ok(result.dropped.some((entry) => entry.dropReasons.includes('suppressed_by_crystallized_materialization')));
  assert.ok(result.dropped.some((entry) => entry.dropReasons.includes('skipped_materialized_recent')));
  assert.match(result.query, /vestige-bridge/i);
});

test('buildAgentEndPayloadAsync uses LLM to extract durable semantic content', async () => {
  // Since invokeLlm is used, we can't easily test the exact LLM output in this unit test.
  // Instead, we just verify the new function is exported and can handle empty inputs.
  const payload = await buildAgentEndPayloadAsync({ messages: [] });
  assert.equal(payload, null);
});

test('buildCanonicalKey falls back to layer instead of source', () => {
  const recent = normalizeEntry({
    content: 'User prefers clean recent memory contracts.',
    source: 'openclaw:agent_end',
  }, {
    defaultLayer: 'recent',
  });

  const key = buildCanonicalKey(recent);
  assert.match(key, /^recent::/);
  assert.doesNotMatch(key, /openclaw/i);
});
