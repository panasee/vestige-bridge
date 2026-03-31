import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createVestigeBridgeRuntime } from '../src/index.js';

async function makeTranscript(lines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vestige-trigger-'));
  const file = path.join(dir, 'session.jsonl');
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return { dir, file };
}

test('commandReset does not crash when previous session transcript exists', async () => {
  const { dir, file } = await makeTranscript([
    { type: 'message', message: { role: 'user', content: 'First question' } },
    { type: 'message', message: { role: 'assistant', content: 'First answer' } },
  ]);

  try {
    const runtime = createVestigeBridgeRuntime({
      pluginConfig: {
        enabled: true,
        behavior: {
          failSoft: true,
          triggerIngestOnCommandReset: true,
        },
      },
      fetchImpl: async () => {
        throw new Error('network should not be reached in this smoke test');
      },
    });

    await assert.doesNotReject(() => runtime.commandReset({
      type: 'command',
      action: 'reset',
      previousSessionEntry: {
        sessionId: 'sess-old',
        sessionFile: file,
      },
    }, {}));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sessionEnd does not crash when session transcript exists', async () => {
  const { dir, file } = await makeTranscript([
    { type: 'message', message: { role: 'user', content: 'Need durable memory cleanup' } },
    { type: 'message', message: { role: 'assistant', content: 'I will inspect the trigger path' } },
  ]);

  try {
    const runtime = createVestigeBridgeRuntime({
      pluginConfig: {
        enabled: true,
        behavior: {
          failSoft: true,
          triggerIngestOnSessionEnd: true,
        },
      },
      fetchImpl: async () => {
        throw new Error('network should not be reached in this smoke test');
      },
    });

    await assert.doesNotReject(() => runtime.sessionEnd({
      type: 'session',
      action: 'end',
      sessionEntry: {
        sessionId: 'sess-now',
        sessionFile: file,
      },
    }, {}));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
