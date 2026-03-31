import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const HOUR_MS = 60 * 60 * 1000;

import { resolvePluginConfig, shouldApplyToAgent } from './config.js';
import { collectCrystallizedVestigeIds, loadCrystallizerMaterializedSources } from './crystallizer-ledger.js';
import { createLogger } from './logger.js';
import { buildRecentRecallPacket } from './recall.js';
import { buildRecallQuery } from './query-builder.js';
import { buildAgentEndPayloadAsync } from './ingest.js';
import { mergeCategoryEntries } from './category-store.js';
import { createVestigeRecallProvider } from './provider.js';
import { createSidecarClient } from './sidecar-client.js';
import { registerSharedRecallProvider } from './shared-recall-registry.js';
import {
  getSummaryWatermarkForConversation,
  hasProcessedFingerprint,
  loadTriggerLedger,
  markProcessedFingerprint,
  pruneProcessedFingerprints,
  saveTriggerLedger,
  updateMessageWatermark,
  updateSummaryWatermark,
} from './trigger-ledger.js';
import { createLcmInspector, validateLcmSchema } from './lcm-trigger.js';

const PLUGIN_ID = 'vestige-bridge';
const PLUGIN_NAME = 'Vestige Bridge';
const PLUGIN_DESCRIPTION = 'Vestige recent-memory bridge for recent recall, ingest, and LCM-triggered maintenance.';

async function readRecentMessagesFromSessionFile(sessionFile, limit = 6) {
  if (!sessionFile || typeof sessionFile !== 'string') {
    return [];
  }

  const candidates = [sessionFile];
  try {
    const dir = path.dirname(sessionFile);
    const base = path.basename(sessionFile);
    const siblings = await fs.readdir(dir);
    const resetCandidates = siblings
      .filter((name) => name.startsWith(`${base}.reset.`))
      .sort()
      .reverse()
      .map((name) => path.join(dir, name));
    candidates.push(...resetCandidates);
  } catch {
    // ignore reset-fallback discovery failure
  }

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const messages = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry?.type !== 'message' || !entry?.message) {
            continue;
          }
          const role = entry.message.role;
          if (role !== 'user' && role !== 'assistant' && role !== 'system') {
            continue;
          }
          const content = Array.isArray(entry.message.content)
            ? entry.message.content.find((part) => part?.type === 'text')?.text
            : entry.message.content;
          const text = typeof content === 'string' ? content.trim() : '';
          if (!text || text.startsWith('/')) {
            continue;
          }
          messages.push({ role, content: text });
        } catch {
          // ignore malformed transcript lines
        }
      }
      if (messages.length > 0) {
        return messages.slice(-Math.max(1, limit));
      }
    } catch {
      // try next fallback candidate
    }
  }

  return [];
}

function buildEventForSessionEntry(event, sessionEntry, messages = []) {
  return {
    ...event,
    sessionEntry: sessionEntry || event?.sessionEntry || null,
    previousSessionEntry: event?.previousSessionEntry || null,
    messages,
    timestamp: event?.timestamp || new Date().toISOString(),
  };
}

function computeTimeTriggerDelayMs(nowMs = Date.now(), intervalHours = 12) {
  const intervalMs = Math.max(1, Number(intervalHours) || 12) * HOUR_MS;
  const nextBoundary = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
  return Math.max(1000, nextBoundary - nowMs);
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

export function createVestigeBridgeRuntime(options = {}) {
  const config = resolvePluginConfig(options.pluginConfig ?? {}, options.workspaceDir ?? process.cwd());
  const logger = createLogger(options.logger, {
    debug: config.debug,
    prefix: `[${PLUGIN_ID}]`,
  });
  const apiRuntime = options.apiRuntime ?? null;
  let timeTriggerTimer = null;
  const client = createSidecarClient({
    baseUrl: config.baseUrl,
    authTokenPath: config.authTokenPath,
    timeoutMs: config.timeoutMs,
    logger,
    fetchImpl: options.fetchImpl,
  });

  let lcmSchemaStatus;
  try {
    lcmSchemaStatus = validateLcmSchema(config);
    logger.info('LCM schema validation passed', {
      dbPath: lcmSchemaStatus.dbPath,
      tables: lcmSchemaStatus.tables,
    });
  } catch (error) {
    logger.error('LCM schema validation failed', {
      code: error?.code || 'LCM_SCHEMA_INVALID',
      dbPath: error?.dbPath || config?.behavior?.lcmDbPath || null,
      issues: Array.isArray(error?.issues) ? error.issues : [error instanceof Error ? error.message : String(error)],
    });
    throw error;
  }

  const lcmInspector = createLcmInspector(config);
  const recallProvider = createVestigeRecallProvider({ client, config, logger });

  async function beforePromptBuild(event, ctx) {
    if (!config.enabled || config.recallMode !== 'injector') {
      return undefined;
    }
    if (!shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) {
      return undefined;
    }

    return failSoft({ config, logger, client }, 'before_prompt_build', async () => {
      const crystallizerLedger = await loadCrystallizerMaterializedSources();
      const result = await buildRecentRecallPacket({
        sidecarClient: client,
        config,
        messages: Array.isArray(event?.messages) ? event.messages : [],
        latestUserTurn: typeof event?.prompt === 'string' ? event.prompt : '',
        materializedIds: collectCrystallizedVestigeIds(crystallizerLedger.data),
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

  async function loadExistingMemorySynopsis(messages = [], loggerInstance = logger) {
    if (!config?.ingest?.includeExistingMemorySynopsis) {
      return [];
    }

    const { query } = buildRecallQuery({
      messages,
      maxChars: 320,
      latestChars: 180,
      tailChars: 120,
      hintChars: 60,
    });

    if (!query) {
      return [];
    }

    try {
      const response = await client.search({
        query,
        maxResults: config?.ingest?.existingMemoryMaxItems || 3,
        maxTokens: Math.max(80, Math.min(220, config?.recall?.maxTokens || 220)),
        skipMaterialized: false,
      });
      if (!response?.ok) {
        loggerInstance?.warn?.(`existing memory synopsis search failed: ${response?.error || 'unknown error'}`);
        return [];
      }
      const payload = response.data;
      const items = Array.isArray(payload)
        ? payload
        : payload?.items || payload?.results || payload?.memories || payload?.matches || payload?.data || [];
      return Array.isArray(items) ? items : [];
    } catch (error) {
      loggerInstance?.warn?.(`existing memory synopsis lookup failed: ${error?.message || String(error)}`);
      return [];
    }
  }

  async function runExistingIngestFlow(event, ctx, hookName = 'agent_end', ingestContext = {}) {
    const effectiveMessages = Array.isArray(ingestContext?.messages) ? ingestContext.messages : (Array.isArray(event?.messages) ? event.messages : []);
    const existingMemories = await loadExistingMemorySynopsis(effectiveMessages);
    const ingestPayload = await buildAgentEndPayloadAsync({
      messages: effectiveMessages,
      summaries: Array.isArray(ingestContext?.summaries) ? ingestContext.summaries : [],
      existingMemories,
      trigger: ingestContext?.trigger || { kind: hookName },
      config,
      ctx,
      logger,
      runtime: apiRuntime,
    });

    if (Array.isArray(ingestPayload?.items) && ingestPayload.items.length > 0) {
      const categoryEntries = {};
      for (const item of ingestPayload.items) {
        if (!item?.content) continue;
        const result = await client.smartIngest({ content: item.content });
        if (result?.ok) {
          const nodeId = result.data?.nodeId || result.data?.node_id;
          if (nodeId && item.category) {
            categoryEntries[nodeId] = item.category;
          }
        } else {
          logger.warn(`${hookName} smartIngest item failed: ${result?.error ?? 'unknown'}`, { error: result?.error });
        }
      }
      if (Object.keys(categoryEntries).length > 0) {
        await mergeCategoryEntries(categoryEntries).catch((err) => {
          logger.warn(`${hookName} category store write failed`, { error: err?.message });
        });
      }
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

    await runBestEffortOperation('promoteMemory', promotePayload, { config, logger, client }, hookName);
    await runBestEffortOperation('demoteMemory', demotePayload, { config, logger, client }, hookName);
    await runBestEffortOperation('consolidate', consolidatePayload, { config, logger, client }, hookName);
    await runBestEffortOperation('markMaterialized', markMaterializedPayload, { config, logger, client }, hookName);
  }

  function buildTriggerFingerprint(kind, event, ctx) {
    const sessionId = event?.previousSessionEntry?.sessionId || event?.sessionEntry?.sessionId || ctx?.sessionId || 'unknown';
    const rawStamp = event?.at || event?.timestamp || event?.endedAt || new Date().toISOString();
    const parsed = Date.parse(rawStamp);
    const bucketMs = kind === 'time' ? config.behavior.triggerIntervalHours * 60 * 60 * 1000 : 60 * 1000;
    const stamp = Number.isFinite(parsed) ? new Date(Math.floor(parsed / bucketMs) * bucketMs).toISOString() : String(rawStamp);
    return `${kind}:${sessionId}:${stamp}`;
  }

  async function maybeRunVestigeExtraction(trigger, event, ctx) {
    return failSoft({ config, logger, client }, trigger.kind, async () => {
      const loaded = await loadTriggerLedger(config);
      let state = {
        ...loaded.state,
        processedFingerprints: pruneProcessedFingerprints(loaded.state?.processedFingerprints),
      };

      if (hasProcessedFingerprint(state, trigger.fingerprint)) {
        logger.info('trigger deduped', { kind: trigger.kind, fingerprint: trigger.fingerprint });
        return undefined;
      }

      const sessionIdForDelta = event?.previousSessionEntry?.sessionId || event?.sessionEntry?.sessionId || ctx?.sessionId || null;
      const conversationForDelta = lcmInspector.getConversationForSession(sessionIdForDelta);
      const summaryWatermark = getSummaryWatermarkForConversation(state, conversationForDelta?.conversationId ?? null);
      const summaryCheck = lcmInspector.hasSummaryAdvanced(summaryWatermark, conversationForDelta?.conversationId ?? null);
      const conversationId = conversationForDelta?.conversationId ?? null;
      const messageDelta = lcmInspector.computeConversationMessageDelta(
        conversationId,
        state.lastMessageWatermark,
      );
      const nowIso = trigger.at || new Date().toISOString();
      const hoursSinceSuccess = state.lastExtractSuccessAt
        ? (Date.now() - Date.parse(state.lastExtractSuccessAt)) / (1000 * 60 * 60)
        : Number.POSITIVE_INFINITY;

      const shouldRunByTime = trigger.kind === 'time'
        && config.behavior.triggerIngestOnTime
        && hoursSinceSuccess >= config.behavior.triggerIntervalHours
        && (summaryCheck.advanced || messageDelta.newMessages > 0);

      const shouldRun =
        (trigger.kind === 'command:new' && config.behavior.triggerIngestOnCommandNew && (summaryCheck.advanced || messageDelta.newMessages > 0))
        || (trigger.kind === 'command:reset' && config.behavior.triggerIngestOnCommandReset && (summaryCheck.advanced || messageDelta.newMessages > 0))
        || (trigger.kind === 'session:end' && config.behavior.triggerIngestOnSessionEnd && (summaryCheck.advanced || messageDelta.newMessages > 0))
        || ((trigger.kind === 'session:compact' || trigger.kind === 'session:compact:after')
          && config.behavior.triggerIngestOnCommandCompact
          && (summaryCheck.advanced || messageDelta.newMessages > 0))
        || shouldRunByTime;

      logger.info('trigger evaluated', {
        kind: trigger.kind,
        fingerprint: trigger.fingerprint,
        conversationId,
        summaryAdvanced: summaryCheck.advanced,
        newMessages: messageDelta.newMessages,
        shouldRun,
      });

      state = {
        ...state,
        lastExtractAttemptAt: nowIso,
      };

      if (shouldRun) {
        const sessionId = sessionIdForDelta;
        const previousSeq = Number(state?.lastMessageWatermark?.[String(conversationId)] || 0);
        const lcmMessages = lcmInspector.getConversationMessagesSince(
          conversationId,
          previousSeq,
          config.ingest.maxPendingMessages || 24,
        );
        const pendingChars = lcmMessages.reduce((sum, msg) => sum + String(msg?.content || '').length, 0);
        const trimmedLcmMessages = [];
        let remainingChars = config.ingest.maxPendingCharacters || 12000;
        let skippedEmptyPendingMessages = 0;
        let truncatedByCharacterBudget = false;
        for (let i = lcmMessages.length - 1; i >= 0; i -= 1) {
          const msg = lcmMessages[i];
          const text = String(msg?.content || '');
          if (!text) {
            skippedEmptyPendingMessages += 1;
            continue;
          }
          if (trimmedLcmMessages.length > 0 && remainingChars <= 0) {
            truncatedByCharacterBudget = true;
            break;
          }
          trimmedLcmMessages.push(msg);
          remainingChars -= text.length;
        }
        trimmedLcmMessages.reverse();
        const droppedPendingMessages = Math.max(0, lcmMessages.length - trimmedLcmMessages.length - skippedEmptyPendingMessages);
        logger.info('trigger ingest run starting', {
          kind: trigger.kind,
          fingerprint: trigger.fingerprint,
          conversationId,
          sessionId,
          summaryWatermarkBefore: summaryWatermark,
          summaryWatermarkAfter: summaryCheck.latest,
          newMessages: messageDelta.newMessages,
          previousSeq,
          pendingMessagesFetched: lcmMessages.length,
          pendingMessagesSelected: trimmedLcmMessages.length,
          pendingMessagesDropped: droppedPendingMessages,
          skippedEmptyPendingMessages,
          pendingCharactersFetched: pendingChars,
          pendingCharactersBudget: config.ingest.maxPendingCharacters || 12000,
          pendingCharactersSelected: Math.max(0, (config.ingest.maxPendingCharacters || 12000) - remainingChars),
          pendingCharactersRemaining: remainingChars,
          truncatedByCharacterBudget,
        });
        const fallbackSessionMessages = lcmInspector.getRecentMessagesForSession(
          sessionId,
          config.ingest.maxTailMessages || 12,
        );
        const lcmSummaries = lcmInspector.getRecentSummariesSince(
          summaryWatermark,
          config.ingest.maxSummaryItems || 8,
          conversationId,
        );
        logger.info('trigger ingest context prepared', {
          kind: trigger.kind,
          fingerprint: trigger.fingerprint,
          conversationId,
          sessionId,
          selectedRawSource: trimmedLcmMessages.length > 0
            ? 'conversation_pending'
            : (fallbackSessionMessages.length > 0 ? 'session_fallback' : 'event_fallback'),
          rawMessagesCount: trimmedLcmMessages.length > 0
            ? trimmedLcmMessages.length
            : (fallbackSessionMessages.length > 0 ? fallbackSessionMessages.length : (Array.isArray(event?.messages) ? event.messages.length : 0)),
          summaryCount: lcmSummaries.length,
          summaryAdvanced: summaryCheck.advanced,
          newMessages: messageDelta.newMessages,
        });
        await runExistingIngestFlow(event, ctx, trigger.kind, {
          messages: trimmedLcmMessages.length > 0
            ? trimmedLcmMessages
            : (fallbackSessionMessages.length > 0
                ? fallbackSessionMessages
                : (Array.isArray(event?.messages) ? event.messages : [])),
          summaries: lcmSummaries,
          trigger: {
            kind: trigger.kind,
            at: nowIso,
            summaryAdvanced: summaryCheck.advanced,
            newMessages: messageDelta.newMessages,
            fingerprint: trigger.fingerprint,
            sessionId,
            conversationId,
          },
        });
        state = {
          ...state,
          lastExtractSuccessAt: nowIso,
        };
        logger.info('trigger ingest run finished', {
          kind: trigger.kind,
          fingerprint: trigger.fingerprint,
          conversationId,
          sessionId,
          lastExtractSuccessAt: nowIso,
          updatedMessageWatermark: messageDelta.nextWatermark,
          updatedSummaryWatermark: summaryCheck.latest,
        });
      } else {
        logger.info('trigger skipped', {
          kind: trigger.kind,
          fingerprint: trigger.fingerprint,
          reason: 'no_lcm_delta_or_trigger_disabled',
          summaryAdvanced: summaryCheck.advanced,
          newMessages: messageDelta.newMessages,
        });
      }

      state = updateSummaryWatermark(state, conversationId, summaryCheck.latest);
      state = updateMessageWatermark(state, messageDelta.nextWatermark);
      state = markProcessedFingerprint(state, trigger.fingerprint, nowIso);
      await saveTriggerLedger(loaded.path, state);
      logger.info('trigger ledger updated', {
        path: loaded.path,
        kind: trigger.kind,
        fingerprint: trigger.fingerprint,
        lastExtractAttemptAt: state.lastExtractAttemptAt,
        lastExtractSuccessAt: state.lastExtractSuccessAt,
        lastSummaryWatermarkByConversation: state.lastSummaryWatermarkByConversation,
      });
      return undefined;
    });
  }

  async function agentEnd(event, ctx) {
    if (!config.enabled || !config.behavior.enableAgentEndIngest || !event?.success) {
      return undefined;
    }
    logger.warn(`>>> AGENT_END_PROBE: success=${event?.success}, agent=${ctx?.agentId} <<<`);
    if (!shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) {
      return undefined;
    }

    return failSoft({ config, logger, client }, 'agent_end', async () => {
      await runExistingIngestFlow(event, ctx, 'agent_end');
      return undefined;
    });
  }

  async function commandNew(event, ctx) {
    if (!config.enabled || !shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) return undefined;
    const previousSessionEntry = event?.previousSessionEntry || event?.context?.previousSessionEntry;
    const messages = await readRecentMessagesFromSessionFile(previousSessionEntry?.sessionFile, config.ingest.maxTailMessages || 6);
    const eventForOldSession = buildEventForSessionEntry(event, previousSessionEntry || event?.sessionEntry, messages);
    const trigger = { kind: 'command:new', at: new Date().toISOString(), fingerprint: buildTriggerFingerprint('command:new', eventForOldSession, ctx) };
    return maybeRunVestigeExtraction(trigger, eventForOldSession, ctx);
  }

  async function commandReset(event, ctx) {
    if (!config.enabled || !shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) return undefined;
    const previousSessionEntry = event?.previousSessionEntry || event?.context?.previousSessionEntry;
    const messages = await readRecentMessagesFromSessionFile(previousSessionEntry?.sessionFile, config.ingest.maxTailMessages || 6);
    const eventForOldSession = buildEventForSessionEntry(event, previousSessionEntry || event?.sessionEntry, messages);
    const trigger = { kind: 'command:reset', at: new Date().toISOString(), fingerprint: buildTriggerFingerprint('command:reset', eventForOldSession, ctx) };
    return maybeRunVestigeExtraction(trigger, eventForOldSession, ctx);
  }

  async function commandCompact(event, ctx) {
    if (!config.enabled || !shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) return undefined;
    const triggerKind = event?.type === 'session' && event?.action === 'compact:after'
      ? 'session:compact:after'
      : 'session:compact';
    const trigger = { kind: triggerKind, at: new Date().toISOString(), fingerprint: buildTriggerFingerprint(triggerKind, event, ctx) };
    return maybeRunVestigeExtraction(trigger, event, ctx);
  }

  async function sessionEnd(event, ctx) {
    if (!config.enabled) return undefined;
    const kind = event?.type === 'time' ? 'time' : 'session:end';
    if (kind !== 'time' && !shouldApplyToAgent(config.enabledAgents, ctx?.agentId)) return undefined;
    const sessionEntry = event?.sessionEntry || event?.context?.sessionEntry;
    const messages = await readRecentMessagesFromSessionFile(sessionEntry?.sessionFile, config.ingest.maxTailMessages || 6);
    const eventForSession = buildEventForSessionEntry(event, sessionEntry, messages);
    const trigger = { kind, at: new Date().toISOString(), fingerprint: buildTriggerFingerprint(kind, eventForSession, ctx) };
    return maybeRunVestigeExtraction(trigger, eventForSession, ctx);
  }

  function cancelTimeTrigger() {
    if (timeTriggerTimer) {
      clearTimeout(timeTriggerTimer);
      timeTriggerTimer = null;
    }
  }

  function scheduleNextTimeTrigger(ctx = {}) {
    cancelTimeTrigger();
    if (!config.enabled || !config.behavior.triggerIngestOnTime) {
      return;
    }
    const delayMs = computeTimeTriggerDelayMs(Date.now(), config.behavior.triggerIntervalHours);
    logger.info('time trigger scheduled', {
      delayMs,
      triggerIntervalHours: config.behavior.triggerIntervalHours,
    });
    timeTriggerTimer = setTimeout(async () => {
      try {
        await sessionEnd({ type: 'time', action: 'time', timestamp: new Date().toISOString() }, ctx);
      } catch (error) {
        logger.warn('time trigger execution failed', { error: error?.message ?? String(error) });
      } finally {
        scheduleNextTimeTrigger(ctx);
      }
    }, delayMs);
    if (typeof timeTriggerTimer?.unref === 'function') {
      timeTriggerTimer.unref();
    }
  }

  return {
    config,
    logger,
    client,
    async health() {
      const sidecar = await client.health();
      return {
        ...sidecar,
        lcm: {
          ...(lcmSchemaStatus || {}),
          ok: lcmSchemaStatus?.ok === true,
        },
      };
    },
    getRecallProvider() {
      return recallProvider;
    },
    beforePromptBuild,
    agentEnd,
    commandNew,
    commandReset,
    commandCompact,
    sessionEnd,
    scheduleNextTimeTrigger,
    cancelTimeTrigger,
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
      apiRuntime: api.runtime,
    });

    if (runtime.config.recallMode === 'provider') {
      registerSharedRecallProvider(runtime.getRecallProvider());
    } else {
      api.on('before_prompt_build', async (event, ctx) => runtime.beforePromptBuild(event, ctx));
    }
    api.registerTool((ctx) => {
      if (ctx?.config?.plugins?.slots?.memory !== PLUGIN_ID) return null;
      return [
        {
          name: 'memory_store',
          label: 'Memory Store',
          description: 'Store a memory note into Vestige recent lane. Use for preferences, patterns, and short-term reminders.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Markdown content to store' },
              title: { type: 'string', description: 'Optional title hint (used as tag)' },
              path: { type: 'string', description: 'Ignored (compatibility field)' },
              dataset: { type: 'string', description: 'Ignored (compatibility field)' },
              pinned: { type: 'boolean', description: 'Ignored (compatibility field)' },
              scope: { type: 'string', description: 'Ignored (compatibility field)' },
            },
            required: ['text'],
            additionalProperties: false,
          },
          async execute(_toolCallId, params) {
            const result = await runtime.client.smartIngest({
              content: params.text,
              forceCreate: true,
              ...(params.title ? { tags: [params.title] } : {}),
            });
            if (!result?.ok) {
              return {
                content: [{ type: 'text', text: `Failed to store memory: ${result?.error ?? 'unknown'}` }],
                isError: true,
              };
            }
            return { content: [{ type: 'text', text: 'Memory stored in Vestige.' }] };
          },
        },
      ];
    }, { names: ['memory_store'] });

    api.vestigeBridge = {
      health: () => runtime.health(),
      getConfig: () => runtime.config,
      getRecallProvider: () => runtime.getRecallProvider(),
      triggerTimeIngestCheck: async (ctx = {}) => runtime.sessionEnd({ type: 'time', action: 'time', timestamp: new Date().toISOString() }, ctx),
    };
  },
};

export default plugin;
