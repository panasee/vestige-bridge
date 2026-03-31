import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createLcmInspector, validateLcmSchema } from '../src/lcm-trigger.js';

async function createTempDb() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'vestige-lcm-'));
  const dbPath = path.join(tempDir, 'lcm.db');
  return {
    tempDir,
    dbPath,
    async cleanup() {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function sqlite(dbPath, sql) {
  execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
}

test('validateLcmSchema accepts expected lossless-claw schema', async () => {
  const fixture = await createTempDb();
  try {
    sqlite(fixture.dbPath, `
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY,
        session_id TEXT,
        created_at TEXT
      );
      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY,
        conversation_id INTEGER,
        seq INTEGER,
        role TEXT,
        created_at TEXT
      );
      CREATE TABLE message_parts (
        message_id INTEGER,
        part_type TEXT,
        text_content TEXT,
        tool_output TEXT,
        metadata TEXT,
        ordinal INTEGER
      );
      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER,
        created_at TEXT,
        kind TEXT,
        depth INTEGER,
        content TEXT
      );
      INSERT INTO conversations (conversation_id, session_id, created_at)
      VALUES (1, 'sess-1', '2026-03-30T10:00:00Z');
      INSERT INTO messages (message_id, conversation_id, seq, role, created_at)
      VALUES (10, 1, 1, 'user', '2026-03-30T10:01:00Z');
      INSERT INTO message_parts (message_id, part_type, text_content, tool_output, metadata, ordinal)
      VALUES (10, 'text', 'hello', NULL, '{}', 0);
      INSERT INTO summaries (summary_id, conversation_id, created_at, kind, depth, content)
      VALUES ('sum_1', 1, '2026-03-30T10:02:00Z', 'condensed', 1, 'summary');
    `);

    const schema = validateLcmSchema({ behavior: { lcmDbPath: fixture.dbPath } });
    const inspector = createLcmInspector({ behavior: { lcmDbPath: fixture.dbPath } });

    assert.equal(schema.ok, true);
    assert.equal(schema.dbPath, fixture.dbPath);
    assert.equal(inspector.schema.ok, true);
    assert.deepEqual(inspector.getConversationForSession('sess-1'), {
      conversationId: 1,
      sessionId: 'sess-1',
      createdAt: '2026-03-30T10:00:00Z',
    });
  } finally {
    await fixture.cleanup();
  }
});

test('validateLcmSchema throws explicit drift error when required columns are missing', async () => {
  const fixture = await createTempDb();
  try {
    sqlite(fixture.dbPath, `
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY,
        session_id TEXT,
        created_at TEXT
      );
      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY,
        conversation_id INTEGER,
        seq INTEGER,
        role TEXT,
        created_at TEXT
      );
      CREATE TABLE message_parts (
        message_id INTEGER,
        part_type TEXT,
        metadata TEXT,
        ordinal INTEGER
      );
      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER,
        created_at TEXT,
        kind TEXT,
        depth INTEGER,
        content TEXT
      );
    `);

    assert.throws(
      () => validateLcmSchema({ behavior: { lcmDbPath: fixture.dbPath } }),
      (error) => {
        assert.equal(error?.name, 'LcmSchemaValidationError');
        assert.equal(error?.code, 'LCM_SCHEMA_INVALID');
        assert.match(String(error?.message || ''), /missing required column message_parts\.text_content/u);
        assert.match(String(error?.message || ''), /lossless-claw schema likely drifted/u);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('createLcmInspector fails fast when sqlite database is unavailable', async () => {
  const fixture = await createTempDb();
  try {
    await writeFile(fixture.dbPath, 'not a sqlite database\n', 'utf8');

    assert.throws(
      () => createLcmInspector({ behavior: { lcmDbPath: fixture.dbPath } }),
      (error) => {
        assert.equal(error?.name, 'LcmSchemaValidationError');
        assert.equal(error?.code, 'LCM_SCHEMA_INVALID');
        assert.match(String(error?.message || ''), /unable to open or inspect sqlite database/u);
        assert.match(String(error?.message || ''), /update vestige-bridge before continuing/u);
        return true;
      },
    );
  } finally {
    await fixture.cleanup();
  }
});
