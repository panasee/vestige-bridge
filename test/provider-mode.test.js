import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRecentRecallCandidates } from '../src/provider.js';
import { createVestigeBridgeRuntime } from '../src/index.js';
import { resolvePluginConfig } from '../src/config.js';

test('buildRecentRecallCandidates returns structured recent-lane candidates', () => {
  const result = buildRecentRecallCandidates({
    entries: [
      {
        id: 'pref-1',
        source: 'vestige',
        category: 'preference',
        statement: 'User wants concrete implementation details first.',
        score: 0.91,
      },
      {
        id: 'proj-1',
        source: 'vestige',
        category: 'project_fact',
        statement: 'Current focus is wiring provider-mode recall into orchestrator.',
        score: 0.83,
      },
    ],
  });

  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].lane, 'recent');
  assert.ok(result.candidates.some((candidate) => candidate.bucket === 'recent_preference'));
  assert.ok(result.candidates.some((candidate) => candidate.bucket === 'recent_project_momentum'));
  assert.ok(result.candidates.every((candidate) => candidate.provider === 'vestige-bridge'));
  assert.ok(result.candidates.every((candidate) => candidate.text.startsWith('- [')));
});

test('buildRecentRecallCandidates suppresses materialized recent items', () => {
  const result = buildRecentRecallCandidates({
    entries: [
      {
        id: 'mat-1',
        source: 'vestige',
        category: 'preference',
        statement: 'Already materialized preference.',
      },
      {
        id: 'keep-1',
        source: 'vestige',
        category: 'life_event',
        statement: 'Fresh recent item that should remain visible.',
      },
    ],
    materializedIds: new Set(['mat-1']),
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].canonicalKey, 'vestige:keep-1');
  assert.ok(result.dropped.some((entry) => entry.dropReasons.includes('suppressed_by_materialization_ledger')));
});

test('provider mode is the default config and disables direct before_prompt_build injection', async () => {
  const resolved = resolvePluginConfig({ enabled: true });
  assert.equal(resolved.recallMode, 'provider');

  const runtime = createVestigeBridgeRuntime({
    pluginConfig: {
      enabled: true,
      recallMode: 'provider',
    },
    logger: {},
    fetchImpl: async () => {
      throw new Error('fetch should not be called in provider-mode beforePromptBuild guard');
    },
  });

  const result = await runtime.beforePromptBuild({ prompt: 'hello', messages: [] }, { agentId: 'main' });
  assert.equal(result, undefined);
  assert.equal(runtime.getRecallProvider().id, 'vestige-bridge');
});
