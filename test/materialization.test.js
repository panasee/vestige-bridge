import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMarkMaterializedPayload,
  materializeExport,
  writeTextFileAtomic,
} from '../src/materialization.js';

function buildEnvelope() {
  return {
    generation_id: '2026-03-19T17:30:00+08:00--export0001',
    generated_at: '2026-03-19T17:30:00+08:00',
    items: [
      {
        vestige_id: 'mem_pref',
        shard_key: 'global/preferences',
        category: 'preference',
        statement: 'User prefers concise, delta-first responses.',
        transfer_reason: 'repeated_across_days',
        confidence: 0.87,
      },
      {
        vestige_id: 'mem_project',
        shard_key: 'projects/vestige-bridge',
        category: 'project_constraint',
        statement: 'Vestige bridge uses shard overwrite snapshots for durable export.',
        transfer_reason: 'project_stabilized',
        confidence: 0.91,
      },
    ],
  };
}

test('writeTextFileAtomic writes content without leaving temp files behind', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-bridge-atomic-'));
  const filePath = path.join(rootDir, 'memory/vestige/global/preferences.md');

  const result = await writeTextFileAtomic(filePath, 'hello world\n', { tmpSuffix: '.tmp' });
  const content = await fs.readFile(filePath, 'utf8');
  const files = await fs.readdir(path.dirname(filePath));

  assert.equal(content, 'hello world\n');
  assert.equal(result.filePath, filePath);
  assert.deepEqual(files, ['preferences.md']);
});

test('materializeExport writes shard files and invokes callback with successful items only', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-bridge-materialize-'));
  const seenPayloads = [];

  const summary = await materializeExport({
    envelope: buildEnvelope(),
    rootDir,
    markMaterialized: async (payload) => {
      seenPayloads.push(payload);
    },
  });

  const preferenceFile = await fs.readFile(path.join(rootDir, 'global/preferences.md'), 'utf8');
  const projectFile = await fs.readFile(path.join(rootDir, 'projects/vestige-bridge.md'), 'utf8');

  assert.equal(summary.failed_shards.length, 0);
  assert.deepEqual(summary.written_shards, ['global/preferences', 'projects/vestige-bridge']);
  assert.equal(seenPayloads.length, 1);
  assert.deepEqual(seenPayloads[0].written_shards, ['global/preferences', 'projects/vestige-bridge']);
  assert.equal(seenPayloads[0].items.length, 2);
  assert.match(preferenceFile, /Global preferences/u);
  assert.match(projectFile, /Project Vestige Bridge/u);
});

test('materializeExport keeps partial failures recoverable and narrows callback payload', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-bridge-partial-'));
  const captured = [];
  const failingShard = path.join(rootDir, 'projects/vestige-bridge.md');

  const summary = await materializeExport({
    envelope: buildEnvelope(),
    rootDir,
    writeFileAtomic: async (filePath, content, options) => {
      if (filePath === failingShard) {
        throw new Error('simulated shard failure');
      }
      return writeTextFileAtomic(filePath, content, options);
    },
    markMaterialized: async (payload) => {
      captured.push(payload);
    },
  });

  assert.deepEqual(summary.written_shards, ['global/preferences']);
  assert.equal(summary.failed_shards.length, 1);
  assert.equal(summary.failed_shards[0].shard_key, 'projects/vestige-bridge');
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0],
    buildMarkMaterializedPayload({
      generation_id: summary.generation_id,
      generated_at: summary.generated_at,
      successfulShards: [
        {
          shard_key: 'global/preferences',
          items: [{ vestige_id: 'mem_pref', shard_key: 'global/preferences' }],
        },
      ],
    }),
  );

  const preferenceFile = await fs.readFile(path.join(rootDir, 'global/preferences.md'), 'utf8');
  assert.match(preferenceFile, /mem_pref/u);
  await assert.rejects(() => fs.readFile(failingShard, 'utf8'));
});
