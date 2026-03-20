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

test('loadMaterializationLedger returns empty ledger in user state dir when file missing', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-ledger-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-state-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;

  try {
    const ledgerPath = resolveLedgerPath({ rootDir });
    const result = await loadMaterializationLedger({ rootDir });

    assert.equal(result.path, ledgerPath);
    assert.match(ledgerPath, /openclaw[\\/]vestige-bridge[\\/]ledgers[\\/]/u);
    assert.deepEqual(result.data.items, {});
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
  }
});

test('updateMaterializationLedger writes only minimal successful-item metadata', async () => {
  const now = '2026-03-20T00:00:00Z';
  const updated = updateMaterializationLedger({
    ledgerData: { items: {} },
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

  assert.deepEqual(updated.items['pref-1'], {
    vestige_id: 'pref-1',
    shard_key: 'global/preferences',
    generation_id: 'gen-1',
    generated_at: now,
    materialized_at: now,
  });
});

test('saveMaterializationLedger persists private ledger to disk', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-ledger-save-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-state-save-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;

  try {
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
    const fileStat = await fs.stat(ledgerPath);
    const dirStat = await fs.stat(path.dirname(ledgerPath));
    assert.equal(saved.path, ledgerPath);
    assert.equal(reloaded.items['pref-2'].shard_key, 'global/preferences');
    assert.equal(reloaded.items['pref-2'].vestige_id, undefined);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.equal(dirStat.mode & 0o777, 0o700);
    const ids = collectMaterializedIds(saved.data);
    assert.ok(ids.has('pref-2'));
  } finally {
    if (previous === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previous;
    }
  }
});
