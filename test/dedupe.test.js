import test from 'node:test';
import assert from 'node:assert/strict';

import { dedupeCandidates } from '../src/dedupe.js';

test('dedupe prefers cognee materialized item over vestige recent overlap', () => {
  const result = dedupeCandidates([
    { source: 'vestige', statement: 'User prefers zsh.' },
    { source: 'cognee', statement: 'User prefers zsh.', materialized: true, shardKey: 'global/preferences' },
  ]);

  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].source, 'cognee');
  assert.equal(result.kept[0].materialized, true);
  assert.equal(result.dropped.length, 1);
});
