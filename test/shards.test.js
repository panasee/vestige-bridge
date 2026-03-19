import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { materializeExportEnvelope } from '../src/materialization.js';
import { normalizeProjectSlug, validateExportEnvelope } from '../src/shards.js';

test('normalizeProjectSlug produces kebab-case slug', () => {
  assert.equal(normalizeProjectSlug(' My Project__Name '), 'my-project-name');
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

test('materializeExportEnvelope writes markdown shard snapshot', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-bridge-'));
  const envelope = {
    generation_id: 'gen-2',
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
  };

  const sidecarClient = {
    async markMaterialized(payload) {
      return { ok: true, payload };
    },
  };

  const result = await materializeExportEnvelope(envelope, { rootDir: tempRoot, tmpSuffix: '.tmp' }, { sidecarClient });
  const outputPath = path.join(tempRoot, 'global', 'preferences.md');
  const written = await fs.readFile(outputPath, 'utf8');

  assert.equal(result.writtenShards.length, 1);
  assert.match(written, /stable-memory-snapshot/);
  assert.match(written, /User prefers zsh\./);
});
