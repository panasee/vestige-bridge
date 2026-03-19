import fs from 'node:fs/promises';
import path from 'node:path';

import { renderShardSnapshot } from './render.js';
import { groupExportItemsByShard, shardPathForKey, validateExportEnvelope } from './shards.js';

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function atomicWriteFile(filePath, content, tmpSuffix) {
  const tempPath = `${filePath}${tmpSuffix}`;
  await ensureParentDir(filePath);
  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
  return { filePath, tempPath };
}

export function buildMarkMaterializedPayload({ envelope, writtenShards, successfulItems }) {
  return {
    generation_id: envelope.generation_id,
    generated_at: envelope.generated_at,
    written_shards: writtenShards,
    items: successfulItems.map((item) => ({
      vestige_id: item.vestige_id,
      shard_key: item.shard_key,
    })),
  };
}

export async function materializeExportEnvelope(envelope, config, { logger, sidecarClient } = {}) {
  const validated = validateExportEnvelope(envelope);
  const shardGroups = groupExportItemsByShard(validated.items);
  const successfulItems = [];
  const failures = [];
  const writtenShards = [];

  for (const group of shardGroups) {
    const filePath = shardPathForKey(config.rootDir, group.shardKey);
    const content = renderShardSnapshot({
      shardKey: group.shardKey,
      scope: group.scope,
      generationId: validated.generation_id,
      generatedAt: validated.generated_at,
      items: group.items,
    });

    try {
      await atomicWriteFile(filePath, content, config.tmpSuffix);
      writtenShards.push({ shard_key: group.shardKey, path: filePath, count: group.items.length });
      successfulItems.push(...group.items);
    } catch (error) {
      failures.push({ shard_key: group.shardKey, error: String(error?.message ?? error) });
      logger?.warn?.(`failed to write shard ${group.shardKey}: ${String(error?.message ?? error)}`);
    }
  }

  const markMaterializedPayload = buildMarkMaterializedPayload({
    envelope: validated,
    writtenShards,
    successfulItems,
  });

  let callbackResult = null;
  if (sidecarClient && successfulItems.length > 0) {
    callbackResult = await sidecarClient.markMaterialized(markMaterializedPayload);
  }

  return {
    ok: failures.length === 0,
    generationId: validated.generation_id,
    writtenShards,
    successfulItems,
    failures,
    markMaterializedPayload,
    callbackResult,
  };
}
