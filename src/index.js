import { resolvePluginConfig, shouldApplyToAgent } from './config.js';
import { createLogger } from './logger.js';
import { materializeExportEnvelope } from './materialization.js';
import { buildAgentEndPayload, buildRecentRecallPacket } from './recall.js';
import { createSidecarClient } from './sidecar-client.js';

const PLUGIN_ID = 'vestige-bridge';
const PLUGIN_NAME = 'Vestige Bridge';
const PLUGIN_DESCRIPTION = 'Vestige recent-memory bridge with explicit stable export materialization.';

function buildSessionMetadata(ctx) {
  const metadata = {
    agentId: ctx?.agentId,
    sessionId: ctx?.sessionId,
    sessionKey: ctx?.sessionKey,
    workspaceDir: ctx?.workspaceDir,
    trigger: ctx?.trigger,
    channelId: ctx?.channelId,
    messageProvider: ctx?.messageProvider,
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
  );
}

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

async function runExplicitExport(runtime, payload = {}) {
  const { client, config } = runtime;
  if (!config.export.enableExplicit) {
    return {
      ok: false,
      skipped: true,
      reason: 'explicit_export_disabled',
    };
  }

  const consolidate = payload.consolidate === false
    ? { ok: true, skipped: true, reason: 'consolidate_disabled' }
    : await client.consolidate({
        ...(payload.consolidatePayload && typeof payload.consolidatePayload === 'object' ? payload.consolidatePayload : {}),
        session_key: payload.sessionKey,
        reason: payload.reason ?? 'explicit_export',
      });

  const exportResult = await client.exportStable({
    ...(payload.exportPayload && typeof payload.exportPayload === 'object' ? payload.exportPayload : {}),
    session_key: payload.sessionKey,
    reason: payload.reason ?? 'explicit_export',
  });

  if (!exportResult?.ok) {
    return {
      ok: false,
      consolidate,
      export: exportResult,
      reason: 'export_stable_failed',
    };
  }

  const materialized = await materializeExportEnvelope(exportResult.data, config.export, {
    sidecarClient: client,
  });

  return {
    ok: materialized.failed_shards.length === 0,
    consolidate,
    export: exportResult,
    materialized,
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
    timeoutMs: config.timeoutMs,
    logger,
    fetchImpl: options.fetchImpl,
  });

  async function beforePromptBuild(event, ctx) {
    if (!config.enabled) {
      return undefined;
    }
    if (!shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) {
      return undefined;
    }

    return failSoft({ config, logger, client }, 'before_prompt_build', async () => {
      const result = await buildRecentRecallPacket({
        sidecarClient: client,
        config,
        messages: Array.isArray(event?.messages) ? event.messages : [],
        latestUserTurn: typeof event?.prompt === 'string' ? event.prompt : '',
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
      const ingestPayload = buildAgentEndPayload({
        messages: Array.isArray(event?.messages) ? event.messages : [],
        ctx,
        event,
      });

      if (ingestPayload.latest_user_turn || ingestPayload.recent_tail) {
        await runBestEffortOperation('smartIngest', {
          ...ingestPayload,
          metadata: buildSessionMetadata(ctx),
        }, { config, logger, client }, 'agent_end');
      }

      const promotePayload = toOperationPayload(
        readVestigeInstruction(event, 'promoteMemory', 'promote_memory', 'promote-memory'),
      );
      const demotePayload = toOperationPayload(
        readVestigeInstruction(event, 'demoteMemory', 'demote_memory', 'demote-memory'),
      );
      const consolidatePayload = toOperationPayload(
        readVestigeInstruction(event, 'consolidate'),
        { metadata: buildSessionMetadata(ctx) },
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

    api.on('before_prompt_build', async (event, ctx) => runtime.beforePromptBuild(event, ctx));
    api.on('agent_end', async (event, ctx) => runtime.agentEnd(event, ctx));

    api.vestigeBridge = {
      exportStableNow: async (payload = {}) => runtime.explicitExport(payload),
      health: () => runtime.health(),
      getConfig: () => runtime.config,
    };
  },
};

export default plugin;
