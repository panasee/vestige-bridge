import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProjectSlug,
  renderShardSnapshot,
  validateExportEnvelope,
  validateProjectSlug,
} from '../src/shards.js';

test('normalizeProjectSlug produces kebab-case slug', () => {
  assert.equal(normalizeProjectSlug(' My Project__Name '), 'my-project-name');
});

test('validateProjectSlug rejects reserved slugs', () => {
  assert.throws(() => validateProjectSlug('global'));
});

test('validateExportEnvelope accepts minimal valid payload', () => {
  const envelope = validateExportEnvelope({
    generation_id: 'gen-1',
    generated_at: '2026-03-20T00:00:00Z',
    items: [
      {
        vestige_id: 'v1',
        shard_key: 'global/preferences',
        category: 'preference',
        statement: 'User prefers zsh.',
        transfer_reason: 'explicitly_confirmed',
        confidence: 0.92,
      },
    ],
  });
  assert.equal(envelope.items.length, 1);
});

test('renderShardSnapshot emits frontmatter and stable sections', () => {
  const rendered = renderShardSnapshot({
    shard: {
      scope: 'global',
      shard_key: 'global/preferences',
      title: 'Global preferences',
      description: 'Test description.',
    },
    generation_id: 'gen-1',
    generated_at: '2026-03-20T00:00:00Z',
    items: [
      {
        vestige_id: 'v1',
        shard_key: 'global/preferences',
        category: 'preference',
        statement: 'User prefers zsh.',
        transfer_reason: 'explicitly_confirmed',
        confidence: 0.92,
      },
    ],
  });

  assert.match(rendered, /^---/);
  assert.match(rendered, /stable-memory-snapshot/);
  assert.match(rendered, /## v1/);
  assert.match(rendered, /User prefers zsh\./);
});
