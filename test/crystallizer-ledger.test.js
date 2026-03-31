import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  loadCrystallizerMaterializedSources,
  collectCrystallizedVestigeIds,
  resolveCrystallizerMaterializedSourcesPath,
} from '../src/crystallizer-ledger.js';

test('loadCrystallizerMaterializedSources returns empty ledger when file is absent', async () => {
  const originalReadFile = fs.readFile;
  fs.readFile = async (filePath, encoding) => {
    if (String(filePath) === resolveCrystallizerMaterializedSourcesPath()) {
      const error = new Error('missing file');
      error.code = 'ENOENT';
      throw error;
    }
    return originalReadFile(filePath, encoding);
  };

  try {
    const result = await loadCrystallizerMaterializedSources();
    assert.equal(result.path, resolveCrystallizerMaterializedSourcesPath());
    assert.deepEqual(result.data, {
      version: 1,
      updatedAt: null,
      items: {},
    });
  } finally {
    fs.readFile = originalReadFile;
  }
});

test('loadCrystallizerMaterializedSources reads canonical ledger shape and tolerates extra fields', async () => {
  const originalReadFile = fs.readFile;
  fs.readFile = async (filePath, encoding) => {
    if (String(filePath) === resolveCrystallizerMaterializedSourcesPath()) {
      return JSON.stringify({
        version: 1,
        updatedAt: '2026-03-31T06:00:00.000Z',
        items: {
          'cand-1': {
            materializedAt: '2026-03-31T06:00:00.000Z',
            runId: 'run-1',
            notePaths: ['/tmp/a.md'],
          },
          'cand-2': {
            materializedAt: '2026-03-31T06:01:00.000Z',
            runId: 'run-1',
            notePaths: [],
            ignoredFutureField: true,
          },
        },
        ignoredTopLevelField: 'ok',
      });
    }
    return originalReadFile(filePath, encoding);
  };

  try {
    const result = await loadCrystallizerMaterializedSources();
    assert.equal(result.data.version, 1);
    assert.equal(result.data.updatedAt, '2026-03-31T06:00:00.000Z');
    assert.deepEqual(Object.keys(result.data.items).sort(), ['cand-1', 'cand-2']);
    assert.deepEqual(collectCrystallizedVestigeIds(result.data).sort(), ['cand-1', 'cand-2']);
  } finally {
    fs.readFile = originalReadFile;
  }
});

test('collectCrystallizedVestigeIds ignores invalid item keys', () => {
  const ids = collectCrystallizedVestigeIds({
    items: {
      'cand-1': { materializedAt: '2026-03-31T06:00:00.000Z', runId: 'run-1', notePaths: ['/tmp/a.md'] },
      '': { materializedAt: '2026-03-31T06:00:00.000Z', runId: 'run-1', notePaths: [] },
      '   ': { materializedAt: '2026-03-31T06:00:00.000Z', runId: 'run-1', notePaths: [] },
    },
  });

  assert.deepEqual(ids, ['cand-1']);
});
