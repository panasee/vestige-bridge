import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptExportFile,
  adaptExportedNodes,
  classifyKnowledgeNode,
} from '../src/export-adapter.js';

test('classifyKnowledgeNode maps tagged preference into global preferences shard', () => {
  const item = classifyKnowledgeNode({
    id: 'pref-1',
    content: 'User prefers concise, delta-first technical replies.',
    nodeType: 'fact',
    retentionStrength: 0.82,
    createdAt: '2026-03-20T00:00:00Z',
    tags: ['preference', 'workflow'],
  }, {
    exportPath: '/tmp/export.json',
  });

  assert.equal(item.shard_key, 'global/preferences');
  assert.equal(item.category, 'preference');
  assert.match(item.transfer_reason, /preference_/i);
  assert.equal(item.source_refs[0].export_path, '/tmp/export.json');
});

test('classifyKnowledgeNode maps project-tagged node into project shard', () => {
  const item = classifyKnowledgeNode({
    id: 'proj-1',
    content: 'Vestige bridge keeps a local materialization ledger for durable export.',
    nodeType: 'fact',
    retentionStrength: 0.7,
    createdAt: '2026-03-20T00:00:00Z',
    source: '/home/dongkai-claw/workspace/vestige-bridge/src/index.js',
    tags: ['project:vestige-bridge', 'constraint'],
  });

  assert.equal(item.shard_key, 'projects/vestige-bridge');
  assert.equal(item.category, 'project_constraint');
  assert.match(item.transfer_reason, /project_constraint/i);
});

test('adaptExportedNodes filters non-durable items and returns envelope', () => {
  const result = adaptExportedNodes({
    nodes: [
      {
        id: 'pref-1',
        content: 'User prefers short answers.',
        nodeType: 'fact',
        retentionStrength: 0.8,
        createdAt: '2026-03-20T00:00:00Z',
        tags: ['preference'],
      },
      {
        id: 'weak-1',
        content: 'Minor ephemeral note',
        nodeType: 'note',
        retentionStrength: 0.1,
        createdAt: '2026-03-20T00:00:00Z',
        tags: [],
      },
    ],
    exportPath: '/tmp/export.json',
    generationId: 'gen-1',
    generatedAt: '2026-03-20T00:00:00Z',
  });

  assert.equal(result.envelope.items.length, 1);
  assert.equal(result.envelope.items[0].vestige_id, 'pref-1');
  assert.equal(result.stats.skipped_nodes, 1);
});

test('adaptExportFile reads JSON export and produces envelope', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-bridge-export-'));
  const exportPath = path.join(rootDir, 'export.json');
  await fs.writeFile(exportPath, JSON.stringify([
    {
      id: 'pref-2',
      content: 'User prefers durable truth from file-backed memory.',
      nodeType: 'fact',
      retentionStrength: 0.78,
      createdAt: '2026-03-20T00:00:00Z',
      tags: ['preference'],
    },
  ], null, 2));

  const result = await adaptExportFile({
    exportPath,
    generationId: 'gen-2',
    generatedAt: '2026-03-20T00:00:00Z',
  });

  assert.equal(result.envelope.items.length, 1);
  assert.equal(result.envelope.items[0].vestige_id, 'pref-2');
  assert.equal(result.stats.total_nodes, 1);
});
