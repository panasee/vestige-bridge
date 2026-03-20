import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectMaterializedIds,
  loadMaterializationLedger,
  resolveLedgerPath,
  saveMaterializationLedger,
  updateMaterializationLedger,
} from '../src/ledger.js';

test('loadMaterializationLedger returns empty ledger when file missing', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-ledger-'));
  const ledgerPath = resolveLedgerPath({ rootDir });
  const result = await loadMaterializationLedger({ rootDir });

  assert.equal(result.path, ledgerPath);
  assert.deepEqual(result.data.items, {});
});

test('updateMaterializationLedger writes successful items and preserves metadata', async () => {
  const now = '2026-03-20T00:00:00Z';
  const updated = updateMaterializationLedger({
    ledgerData: { items: {} },
    exportPath: '/tmp/export.json',
    envelope: {
      generation_id: 'gen-1',
      generated_at: now,
      items: [
        {
          vestige_id: 'pref-1',
          shard_key: 'global/preferences',
          category: 'preference',
          statement: 'User prefers concise answers.',
          transfer_reason: 'preference_tagged',
          confidence: 0.9,
        },
      ],
    },
    materialized: {
      generation_id: 'gen-1',
      generated_at: now,
      callback_payload: {
        items: [{ vestige_id: 'pref-1', shard_key: 'global/preferences' }],
      },
    },
    now,
  });

  assert.equal(updated.items['pref-1'].shard_key, 'global/preferences');
  assert.equal(updated.items['pref-1'].source_export_path, '/tmp/export.json');
  assert.equal(updated.items['pref-1'].materialized_at, now);
});

test('saveMaterializationLedger persists ledger to disk', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-ledger-save-'));
  const ledgerPath = resolveLedgerPath({ rootDir });

  const saved = await saveMaterializationLedger(ledgerPath, {
    updated_at: '2026-03-20T00:00:00Z',
    items: {
      'pref-2': {
        shard_key: 'global/preferences',
        generation_id: 'gen-2',
      },
    },
  });

  const reloaded = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  assert.equal(saved.path, ledgerPath);
  assert.equal(reloaded.items['pref-2'].shard_key, 'global/preferences');
  const ids = collectMaterializedIds(saved.data);
  assert.ok(ids.has('pref-2'));
});
