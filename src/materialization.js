import fs from 'node:fs/promises';
import path from 'node:path';

import {
  groupItemsByShard,
  renderShardSnapshot,
  validateExportEnvelope,
} from './shards.js';

function normalizeTmpSuffix(tmpSuffix) {
  if (typeof tmpSuffix !== 'string' || tmpSuffix.trim().length === 0) {
    return '.tmp';
  }

  return tmpSuffix.replace(/[\\/]/gu, '-').trim();
}

async function writeTextFileAtomic(filePath, content, options = {}) {
  const tmpSuffix = normalizeTmpSuffix(options.tmpSuffix);
  const directory = path.dirname(filePath);
  const uniqueTag = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const tempPath = `${filePath}${tmpSuffix}.${uniqueTag}`;

  await fs.mkdir(directory, { recursive: true });

  let handle;
  try {
    handle = await fs.open(tempPath, 'w', 0o644);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    return { filePath, tempPath, bytesWritten: Buffer.byteLength(content) };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function buildMarkMaterializedPayload({ generation_id, generated_at, successfulShards }) {
  return {
    generation_id,
    generated_at,
    items: successfulShards.flatMap((entry) =>
      entry.items.map((item) => ({
        vestige_id: item.vestige_id,
        shard_key: item.shard_key,
      })),
    ),
    written_shards: successfulShards.map((entry) => entry.shard_key),
  };
}

async function materializeExport({
  envelope,
  rootDir,
  tmpSuffix = '.tmp',
  writeFileAtomic = writeTextFileAtomic,
  markMaterialized,
}) {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new TypeError('rootDir must be a non-empty string');
  }
  if (typeof writeFileAtomic !== 'function') {
    throw new TypeError('writeFileAtomic must be a function');
  }
  if (markMaterialized !== undefined && typeof markMaterialized !== 'function') {
    throw new TypeError('markMaterialized must be a function when provided');
  }

  const validated = validateExportEnvelope(envelope);
  const grouped = groupItemsByShard(validated.items);
  const successfulShards = [];
  const failedShards = [];

  for (const [shard_key, group] of grouped.entries()) {
    const targetPath = path.join(rootDir, group.shard.relative_path);
    const content = renderShardSnapshot({
      shard: group.shard,
      generation_id: validated.generation_id,
      generated_at: validated.generated_at,
      items: group.items,
    });

    try {
      const writeResult = await writeFileAtomic(targetPath, content, { tmpSuffix, shard: group.shard });
      successfulShards.push({
        shard_key,
        file_path: targetPath,
        bytes_written: writeResult?.bytesWritten ?? Buffer.byteLength(content),
        items: group.items,
      });
    } catch (error) {
      failedShards.push({
        shard_key,
        file_path: targetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const callbackPayload = buildMarkMaterializedPayload({
    generation_id: validated.generation_id,
    generated_at: validated.generated_at,
    successfulShards,
  });

  let callbackError = null;
  if (callbackPayload.items.length > 0 && markMaterialized) {
    try {
      await markMaterialized(callbackPayload);
    } catch (error) {
      callbackError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    generation_id: validated.generation_id,
    generated_at: validated.generated_at,
    shard_count: grouped.size,
    item_count: validated.items.length,
    written_shards: successfulShards.map((entry) => entry.shard_key),
    failed_shards: failedShards,
    callback_payload: callbackPayload,
    callback_error: callbackError,
  };
}

async function materializeExportEnvelope(envelope, exportConfig, { sidecarClient } = {}) {
  return materializeExport({
    envelope,
    rootDir: exportConfig?.rootDir,
    tmpSuffix: exportConfig?.tmpSuffix,
    markMaterialized: sidecarClient
      ? async (payload) => sidecarClient.markMaterialized(payload)
      : undefined,
  });
}

export {
  buildMarkMaterializedPayload,
  materializeExport,
  materializeExportEnvelope,
  writeTextFileAtomic,
};
