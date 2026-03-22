import fs from 'node:fs/promises';

import { resolvePluginConfig, shouldApplyToAgent } from './config.js';
import { adaptExportFile } from './export-adapter.js';
import {
  collectMaterializedIds,
  loadMaterializationLedger,
  saveMaterializationLedger,
  updateMaterializationLedger,
} from './ledger.js';
import { createLogger } from './logger.js';
import { materializeExportEnvelope } from './materialization.js';
import { buildRecentRecallPacket } from './recall.js';
import { buildAgentEndPayloadAsync } from './ingest.js';
import { createVestigeRecallProvider } from './provider.js';
import { createSidecarClient } from './sidecar-client.js';
import { registerSharedRecallProvider } from './shared-recall-registry.js';

const PLUGIN_ID = 'vestige-bridge';
const PLUGIN_NAME = 'Vestige Bridge';
const PLUGIN_DESCRIPTION = 'Vestige recent-memory bridge with explicit stable export materialization.';

function toOperationPayload(value, fallbackPayload) {
  if (value === undefined || value === null || value === false) {
    return null;
  }
  if (value === true) {
    return fallbackPayload ?? {};
  }
  if (typeof value === 'string') {
    return { text: value };
  }
  if (typeof value === 'object') {
    return value;
  }
  return fallbackPayload ?? { value };
}

function readVestigeInstruction(event, ...keys) {
  const sources = [event?.vestige, event?.memory, event];
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    for (const key of keys) {
      if (key in source) {
        return source[key];
      }
    }
  }

  return undefined;
}

async function runBestEffortOperation(methodName, payload, runtime, hookName) {
  if (!payload) {
    return null;
  }

  const result = await runtime.client[methodName](payload);
  if (!result?.ok) {
    runtime.logger.warn(`${hookName} ${methodName} failed`, {
      status: result?.status,
      error: result?.error,
      retriable: result?.retriable,
    });
  }
  return result;
}

async function failSoft(runtime, hookName, work) {
  try {
    return await work();
  } catch (error) {
    if (!runtime.config.behavior.failSoft) {
      throw error;
    }

    runtime.logger.exception(`${hookName} failed soft`, error);
    return undefined;
  }
}

function buildGenerationId(generatedAt) {
  return `${generatedAt}--vestige-export`;
}

function buildExportFileName(generatedAt) {
  return `vestige-bridge-${generatedAt.replace(/[:.]/g, '-').replace(/\+00-00$/, 'Z')}.json`;
}

async function runExplicitExport(runtime, payload = {}) {
  const { client, config } = runtime;
  if (!config.export.enableExplicit) {
    return {
      ok: false,
      skipped: true,
      reason: 'explicit_export_disabled',
    };
  }

  const generatedAt = new Date().toISOString();
  const generationId = buildGenerationId(generatedAt);
  const exportFilePath = typeof payload.exportPayload?.path === 'string' && payload.exportPayload.path.trim().length > 0
    ? payload.exportPayload.path.trim()
    : buildExportFileName(generatedAt);

  const consolidate = payload.consolidate === false
    ? { ok: true, skipped: true, reason: 'consolidate_disabled' }
    : await client.consolidate({
        ...(payload.consolidatePayload && typeof payload.consolidatePayload === 'object' ? payload.consolidatePayload : {}),
      });

  const exportResult = await client.exportMemories({
    format: 'json',
    ...(payload.exportPayload && typeof payload.exportPayload === 'object' ? payload.exportPayload : {}),
    path: exportFilePath,
  });

  if (!exportResult?.ok) {
    return {
      ok: false,
      consolidate,
      export: exportResult,
      reason: 'export_failed',
    };
  }

  const resolvedExportPath = exportResult.data?.path;
  if (!resolvedExportPath) {
    return {
      ok: false,
      consolidate,
      export: exportResult,
      reason: 'export_missing_path',
    };
  }

  const adapted = await adaptExportFile({
    exportPath: resolvedExportPath,
    generationId,
    generatedAt,
  });

  const materialized = await materializeExportEnvelope(adapted.envelope, config.export);
  const loadedLedger = await loadMaterializationLedger(config.export);
  const nextLedger = updateMaterializationLedger({
    ledgerData: loadedLedger.data,
    materialized,
    envelope: adapted.envelope,
  });
  const savedLedger = await saveMaterializationLedger(loadedLedger.path, nextLedger);

  if (!config.export.keepSourceExports && resolvedExportPath && (!payload.exportPayload || !payload.exportPayload.path)) {
    await fs.rm(resolvedExportPath, { force: true }).catch(() => undefined);
  }

  return {
    ok: materialized.failed_shards.length === 0,
    consolidate,
    export: exportResult,
    adapted,
    materialized,
    ledger: {
      path: savedLedger.path,
      count: Object.keys(savedLedger.data.items).length,
    },
  };
}

export function createVestigeBridgeRuntime(options = {}) {
  const config = resolvePluginConfig(options.pluginConfig ?? {}, options.workspaceDir ?? process.cwd());
  const logger = createLogger(options.logger, {
    debug: config.debug,
    prefix: `[${PLUGIN_ID}]`,
  });
  const client = createSidecarClient({
    baseUrl: config.baseUrl,
    authTokenPath: config.authTokenPath,
    timeoutMs: config.timeoutMs,
    logger,
    fetchImpl: options.fetchImpl,
  });

  const recallProvider = createVestigeRecallProvider({ client, config, logger });

  async function beforePromptBuild(event, ctx) {
    if (!config.enabled || config.recallMode !== 'injector') {
      return undefined;
    }
    if (!shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) {
      return undefined;
    }

    return failSoft({ config, logger, client }, 'before_prompt_build', async () => {
      const ledger = await loadMaterializationLedger(config.export);
      const result = await buildRecentRecallPacket({
        sidecarClient: client,
        config,
        messages: Array.isArray(event?.messages) ? event.messages : [],
        latestUserTurn: typeof event?.prompt === 'string' ? event.prompt : '',
        materializedIds: collectMaterializedIds(ledger.data),
        logger,
      });

      if (!result.packet) {
        return undefined;
      }

      logger.debug('before_prompt_build recall packet prepared', {
        selected: result.selected?.length ?? 0,
        dropped: result.dropped?.length ?? 0,
        chars: result.packet.length,
      });

      return { prependContext: result.packet };
    });
  }

  async function agentEnd(event, ctx) {
    if (!config.enabled || !config.behavior.enableAgentEndIngest || !event?.success) {
      return undefined;
    }
    if (!shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) {
      return undefined;
    }

    return failSoft({ config, logger, client }, 'agent_end', async () => {
      const ingestPayload = await buildAgentEndPayloadAsync({
        messages: Array.isArray(event?.messages) ? event.messages : [],
        config,
        ctx,
        logger,
      });

      if (ingestPayload?.content) {
        await runBestEffortOperation('smartIngest', ingestPayload, { config, logger, client }, 'agent_end');
      }

      const promotePayload = toOperationPayload(
        readVestigeInstruction(event, 'promoteMemory', 'promote_memory', 'promote-memory'),
      );
      const demotePayload = toOperationPayload(
        readVestigeInstruction(event, 'demoteMemory', 'demote_memory', 'demote-memory'),
      );
      const consolidatePayload = toOperationPayload(
        readVestigeInstruction(event, 'consolidate'),
        {},
      );
      const markMaterializedPayload = toOperationPayload(
        readVestigeInstruction(event, 'markMaterialized', 'mark_materialized', 'mark-materialized'),
      );

      await runBestEffortOperation('promoteMemory', promotePayload, { config, logger, client }, 'agent_end');
      await runBestEffortOperation('demoteMemory', demotePayload, { config, logger, client }, 'agent_end');
      await runBestEffortOperation('consolidate', consolidatePayload, { config, logger, client }, 'agent_end');
      await runBestEffortOperation('markMaterialized', markMaterializedPayload, { config, logger, client }, 'agent_end');

      return undefined;
    });
  }

  return {
    config,
    logger,
    client,
    health() {
      return client.health();
    },
    getRecallProvider() {
      return recallProvider;
    },
    beforePromptBuild,
    agentEnd,
    explicitExport(payload = {}) {
      return failSoft({ config, logger, client }, 'explicit_export', () => runExplicitExport({ config, logger, client }, payload));
    },
  };
}

const plugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  register(api) {
    const runtime = createVestigeBridgeRuntime({
      pluginConfig: api.pluginConfig ?? {},
      logger: api.logger,
      workspaceDir: api.config?.workspaceDir ?? api.workspaceDir ?? process.cwd(),
      fetchImpl: api.fetch,
    });

    if (runtime.config.recallMode === 'provider') {
      registerSharedRecallProvider(runtime.getRecallProvider());
    } else {
      api.on('before_prompt_build', async (event, ctx) => runtime.beforePromptBuild(event, ctx));
    }
    api.on('agent_end', async (event, ctx) => runtime.agentEnd(event, ctx));

    api.vestigeBridge = {
      exportStableNow: async (payload = {}) => runtime.explicitExport(payload),
      health: () => runtime.health(),
      getConfig: () => runtime.config,
      getRecallProvider: () => runtime.getRecallProvider(),
    };
  },
};

export default plugin;
