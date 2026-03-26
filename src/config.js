import path from 'node:path';

const DEFAULT_BUCKET_PRIORITY = Object.freeze([
  'active_project_stable',
  'global_constraints',
  'global_preferences',
  'personal_stable',
  'other_stable',
  'library_reference',
  'recent-project-momentum',
  'recent-constraint',
  'recent-preference',
  'recent-life',
  'recent-other',
]);

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  enabledAgents: [],
  baseUrl: 'http://127.0.0.1:3928',
  authTokenPath: path.join(process.env.HOME || '', '.local', 'share', 'core', 'auth_token'),
  timeoutMs: 5000,
  debug: false,
  recallMode: 'provider',
  recall: Object.freeze({
    maxResults: 4,
    maxTokens: 280,
    softTarget: 240,
    hardCap: 320,
    skipMaterialized: true,
    maxTailMessages: 8,
  }),
  export: Object.freeze({
    rootDir: 'memory/vestige',
    ledgerPath: undefined,
    tmpSuffix: '.tmp',
    enableExplicit: true,
    keepSourceExports: false,
  }),
  packing: Object.freeze({
    bucketPriority: DEFAULT_BUCKET_PRIORITY,
  }),
  behavior: Object.freeze({
    failSoft: true,
    enableAgentEndIngest: false,
    triggerIngestOnSessionEnd: true,
    triggerIngestOnCommandNew: true,
    triggerIngestOnCommandReset: true,
    triggerIngestOnCommandCompact: true,
    triggerIngestOnTime: true,
    triggerIntervalHours: 12,
    lcmDbPath: '',
    triggerLedgerPath: '',
  }),
});

function env(name) {
  const value = process.env[name];
  return value === undefined || value === null ? undefined : value;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function parseBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function parseInteger(value, fallback, { min, max } = {}) {
  const raw =
    typeof value === 'string' && value.trim().length > 0
      ? Number.parseInt(value.trim(), 10)
      : typeof value === 'number'
        ? Math.trunc(value)
        : Number.NaN;

  if (!Number.isFinite(raw)) {
    return fallback;
  }

  let normalized = raw;
  if (Number.isFinite(min)) {
    normalized = Math.max(min, normalized);
  }
  if (Number.isFinite(max)) {
    normalized = Math.min(max, normalized);
  }
  return normalized;
}

function parseString(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeBaseUrl(value, fallback) {
  const candidate = parseString(value, fallback);
  try {
    const url = new URL(candidate);
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function normalizeEnabledAgents(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeRecallMode(value) {
  const normalized = parseString(value, DEFAULT_CONFIG.recallMode);
  return normalized === 'provider' ? 'provider' : 'injector';
}

function normalizeBucketPriority(value) {
  if (!Array.isArray(value)) {
    return [...DEFAULT_BUCKET_PRIORITY];
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const item = entry.trim();
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    normalized.push(item);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_BUCKET_PRIORITY];
}

function resolveRootDir(value, workspaceDir) {
  const rootDir = parseString(value, DEFAULT_CONFIG.export.rootDir);
  return path.isAbsolute(rootDir) ? rootDir : path.resolve(workspaceDir, rootDir);
}

export function resolvePluginConfig(rawConfig = {}, workspaceDir = process.cwd()) {
  const enabled = parseBoolean(firstDefined(rawConfig.enabled, env('VESTIGE_BRIDGE_ENABLED')), DEFAULT_CONFIG.enabled);
  const enabledAgents = normalizeEnabledAgents(rawConfig.enabledAgents);
  const baseUrl = normalizeBaseUrl(
    firstDefined(rawConfig.baseUrl, env('VESTIGE_BRIDGE_BASE_URL'), env('VESTIGE_BASE_URL')),
    DEFAULT_CONFIG.baseUrl,
  );
  const authTokenPath = parseString(
    firstDefined(rawConfig.authTokenPath, env('VESTIGE_BRIDGE_AUTH_TOKEN_PATH')),
    DEFAULT_CONFIG.authTokenPath,
  );
  const timeoutMs = parseInteger(
    firstDefined(rawConfig.timeoutMs, env('VESTIGE_BRIDGE_TIMEOUT_MS')),
    DEFAULT_CONFIG.timeoutMs,
    { min: 100 },
  );
  const debug = parseBoolean(firstDefined(rawConfig.debug, env('VESTIGE_BRIDGE_DEBUG')), DEFAULT_CONFIG.debug);
  const recallMode = normalizeRecallMode(firstDefined(rawConfig.recallMode, env('VESTIGE_BRIDGE_RECALL_MODE')));

  const rawRecall = rawConfig?.recall ?? {};
  const recallHardCap = parseInteger(
    firstDefined(rawRecall.hardCap, env('VESTIGE_BRIDGE_RECALL_HARD_CAP')),
    DEFAULT_CONFIG.recall.hardCap,
    { min: 1 },
  );
  const recall = {
    maxResults: parseInteger(
      firstDefined(rawRecall.maxResults, env('VESTIGE_BRIDGE_RECALL_MAX_RESULTS')),
      DEFAULT_CONFIG.recall.maxResults,
      { min: 1 },
    ),
    maxTokens: parseInteger(
      firstDefined(rawRecall.maxTokens, env('VESTIGE_BRIDGE_RECALL_MAX_TOKENS')),
      DEFAULT_CONFIG.recall.maxTokens,
      { min: 1 },
    ),
    softTarget: parseInteger(
      firstDefined(rawRecall.softTarget, env('VESTIGE_BRIDGE_RECALL_SOFT_TARGET')),
      DEFAULT_CONFIG.recall.softTarget,
      { min: 1, max: recallHardCap },
    ),
    hardCap: recallHardCap,
    skipMaterialized: parseBoolean(
      firstDefined(rawRecall.skipMaterialized, env('VESTIGE_BRIDGE_RECALL_SKIP_MATERIALIZED')),
      DEFAULT_CONFIG.recall.skipMaterialized,
    ),
    maxTailMessages: parseInteger(
      firstDefined(rawRecall.maxTailMessages, env('VESTIGE_BRIDGE_RECALL_MAX_TAIL_MESSAGES')),
      DEFAULT_CONFIG.recall.maxTailMessages,
      { min: 1 },
    ),
  };

  const rawIngest = rawConfig?.ingest ?? {};
  const ingest = {
    maxTailMessages: parseInteger(
      firstDefined(rawIngest.maxTailMessages, env('VESTIGE_BRIDGE_INGEST_MAX_TAIL_MESSAGES')),
      6,
      { min: 1 },
    ),
    maxPendingMessages: parseInteger(
      firstDefined(rawIngest.maxPendingMessages, env('VESTIGE_BRIDGE_INGEST_MAX_PENDING_MESSAGES')),
      24,
      { min: 1, max: 500 },
    ),
    maxPendingCharacters: parseInteger(
      firstDefined(rawIngest.maxPendingCharacters, env('VESTIGE_BRIDGE_INGEST_MAX_PENDING_CHARACTERS')),
      12000,
      { min: 500, max: 200000 },
    ),
    gateModel: parseString(firstDefined(rawIngest.gateModel, env('VESTIGE_BRIDGE_INGEST_GATE_MODEL')), ''),
    extractModel: parseString(firstDefined(rawIngest.extractModel, env('VESTIGE_BRIDGE_INGEST_EXTRACT_MODEL')), ''),
  };

  const rawExport = rawConfig?.export ?? {};
  const rootDir = resolveRootDir(firstDefined(rawExport.rootDir, env('VESTIGE_BRIDGE_EXPORT_ROOT_DIR')), workspaceDir);
  const ledgerPathRaw = parseString(
    firstDefined(rawExport.ledgerPath, env('VESTIGE_BRIDGE_EXPORT_LEDGER_PATH')),
    DEFAULT_CONFIG.export.ledgerPath,
  );
  const exportConfig = {
    rootDir,
    ledgerPath: ledgerPathRaw,
    tmpSuffix: parseString(firstDefined(rawExport.tmpSuffix, env('VESTIGE_BRIDGE_EXPORT_TMP_SUFFIX')), DEFAULT_CONFIG.export.tmpSuffix),
    enableExplicit: parseBoolean(
      firstDefined(rawExport.enableExplicit, env('VESTIGE_BRIDGE_EXPORT_ENABLE_EXPLICIT')),
      DEFAULT_CONFIG.export.enableExplicit,
    ),
    keepSourceExports: parseBoolean(
      firstDefined(rawExport.keepSourceExports, env('VESTIGE_BRIDGE_EXPORT_KEEP_SOURCE_EXPORTS')),
      DEFAULT_CONFIG.export.keepSourceExports,
    ),
  };

  const rawPacking = rawConfig?.packing ?? {};
  const packing = {
    bucketPriority: normalizeBucketPriority(rawPacking.bucketPriority),
  };

  const rawBehavior = rawConfig?.behavior ?? {};
  const behavior = {
    failSoft: parseBoolean(firstDefined(rawBehavior.failSoft, env('VESTIGE_BRIDGE_FAIL_SOFT')), DEFAULT_CONFIG.behavior.failSoft),
    enableAgentEndIngest: parseBoolean(
      firstDefined(rawBehavior.enableAgentEndIngest, env('VESTIGE_BRIDGE_ENABLE_AGENT_END_INGEST')),
      DEFAULT_CONFIG.behavior.enableAgentEndIngest,
    ),
    triggerIngestOnSessionEnd: parseBoolean(
      firstDefined(rawBehavior.triggerIngestOnSessionEnd, env('VESTIGE_BRIDGE_TRIGGER_ON_SESSION_END')),
      DEFAULT_CONFIG.behavior.triggerIngestOnSessionEnd,
    ),
    triggerIngestOnCommandNew: parseBoolean(
      firstDefined(rawBehavior.triggerIngestOnCommandNew, env('VESTIGE_BRIDGE_TRIGGER_ON_COMMAND_NEW')),
      DEFAULT_CONFIG.behavior.triggerIngestOnCommandNew,
    ),
    triggerIngestOnCommandReset: parseBoolean(
      firstDefined(rawBehavior.triggerIngestOnCommandReset, env('VESTIGE_BRIDGE_TRIGGER_ON_COMMAND_RESET')),
      DEFAULT_CONFIG.behavior.triggerIngestOnCommandReset,
    ),
    triggerIngestOnCommandCompact: parseBoolean(
      firstDefined(rawBehavior.triggerIngestOnCommandCompact, env('VESTIGE_BRIDGE_TRIGGER_ON_COMMAND_COMPACT')),
      DEFAULT_CONFIG.behavior.triggerIngestOnCommandCompact,
    ),
    triggerIngestOnTime: parseBoolean(
      firstDefined(rawBehavior.triggerIngestOnTime, env('VESTIGE_BRIDGE_TRIGGER_ON_TIME')),
      DEFAULT_CONFIG.behavior.triggerIngestOnTime,
    ),
    triggerIntervalHours: parseInteger(
      firstDefined(rawBehavior.triggerIntervalHours, env('VESTIGE_BRIDGE_TRIGGER_INTERVAL_HOURS')),
      DEFAULT_CONFIG.behavior.triggerIntervalHours,
      { min: 1, max: 168 },
    ),
    lcmDbPath: parseString(
      firstDefined(rawBehavior.lcmDbPath, env('VESTIGE_BRIDGE_LCM_DB_PATH')),
      DEFAULT_CONFIG.behavior.lcmDbPath,
    ),
    triggerLedgerPath: parseString(
      firstDefined(rawBehavior.triggerLedgerPath, env('VESTIGE_BRIDGE_TRIGGER_LEDGER_PATH')),
      DEFAULT_CONFIG.behavior.triggerLedgerPath,
    ),
  };

  return {
    enabled,
    enabledAgents,
    baseUrl,
    authTokenPath,
    timeoutMs,
    debug,
    recallMode,
    recall,
    ingest,
    export: exportConfig,
    packing,
    behavior,
    workspaceDir,
  };
}

export function shouldApplyToAgent(enabledAgents, agentId) {
  if (!Array.isArray(enabledAgents) || enabledAgents.length === 0) {
    return true;
  }
  if (!agentId || typeof agentId !== 'string') {
    return false;
  }
  return enabledAgents.includes(agentId);
}
