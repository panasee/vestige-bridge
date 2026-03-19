import { resolvePluginConfig, shouldApplyToAgent } from './config.js';
import { createLogger } from './logger.js';
import { materializeExportEnvelope } from './materialization.js';
import { buildAgentEndPayload, buildRecentRecallPacket } from './recall.js';
import { VestigeSidecarClient } from './sidecar-client.js';

async function runExplicitExport(runtime, payload = {}) {
  const { sidecarClient, config, logger } = runtime;
  if (!config.export.enableExplicit) {
    return { ok: false, reason: 'explicit_export_disabled' };
  }

  await sidecarClient.consolidate({
    session_key: payload.sessionKey,
    reason: payload.reason ?? 'explicit_export',
  });
  const envelope = await sidecarClient.exportStable({
    session_key: payload.sessionKey,
    reason: payload.reason ?? 'explicit_export',
  });
  if (!envelope || envelope.ok === false) {
    return {
      ok: false,
      reason: 'export_stable_failed',
      envelope,
    };
  }

  return materializeExportEnvelope(envelope, config.export, {
    logger,
    sidecarClient,
  });
}

const plugin = {
  id: 'vestige-bridge',
  name: 'Vestige Bridge',
  description: 'Vestige recent-memory bridge with explicit stable export materialization.',
  register(api) {
    const config = resolvePluginConfig(api.pluginConfig ?? {}, api.config?.workspaceDir ?? process.cwd());
    const logger = createLogger(api.logger, { debug: config.debug });
    const sidecarClient = new VestigeSidecarClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      logger,
      failSoft: config.behavior.failSoft,
    });

    const runtime = {
      api,
      config,
      logger,
      sidecarClient,
    };

    api.on('before_prompt_build', async (event, ctx) => {
      if (!shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) {
        return;
      }

      const result = await buildRecentRecallPacket({
        sidecarClient,
        config,
        messages: event?.messages ?? [],
        logger,
      });

      if (!result.packet) {
        return;
      }

      return {
        prependContext: result.packet,
      };
    });

    api.on('agent_end', async (event, ctx) => {
      if (!config.behavior.enableAgentEndIngest || !event?.success) {
        return;
      }
      if (!shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) {
        return;
      }

      const payload = buildAgentEndPayload({
        messages: event?.messages ?? [],
        ctx,
      });
      if (!payload.latest_user_turn) {
        return;
      }

      await sidecarClient.smartIngest(payload);
    });

    api.vestigeBridge = {
      exportStableNow: async (payload = {}) => runExplicitExport(runtime, payload),
      getConfig: () => config,
    };
  },
};

export default plugin;
export { runExplicitExport };
