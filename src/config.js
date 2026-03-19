import path from 'node:path';

const DEFAULT_BUCKET_PRIORITY = [
  'active_project_stable',
  'global_constraints',
  'global_preferences',
  'personal_stable',
  'other_stable',
  'library_reference',
  'recent',
  'other',
];

export function resolvePluginConfig(rawConfig = {}, workspaceDir = process.cwd()) {
  const enabledAgents = Array.isArray(rawConfig?.enabledAgents)
    ? rawConfig.enabledAgents.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];

  const baseUrl = normalizeBaseUrl(rawConfig?.baseUrl ?? 'http://127.0.0.1:8765');
  const timeoutMs = clampInt(rawConfig?.timeoutMs, 500, 30000, 5000);
  const debug = Boolean(rawConfig?.debug);

  const recall = {
    maxResults: clampInt(rawConfig?.recall?.maxResults, 1, 20, 4),
    maxTokens: clampInt(rawConfig?.recall?.maxTokens, 64, 4096, 280),
    softTarget: clampInt(rawConfig?.recall?.softTarget, 64, 4096, 240),
    hardCap: clampInt(rawConfig?.recall?.hardCap, 64, 4096, 320),
    skipMaterialized: rawConfig?.recall?.skipMaterialized !== false,
    maxTailMessages: clampInt(rawConfig?.recall?.maxTailMessages, 1, 30, 8),
  };

  const exportRoot = typeof rawConfig?.export?.rootDir === 'string' && rawConfig.export.rootDir.trim().length > 0
    ? rawConfig.export.rootDir.trim()
    : path.join(workspaceDir, 'memory', 'vestige');

  const exportConfig = {
    rootDir: path.resolve(workspaceDir, exportRoot),
    tmpSuffix: normalizeTmpSuffix(rawConfig?.export?.tmpSuffix),
    enableExplicit: rawConfig?.export?.enableExplicit !== false,
  };

  const behavior = {
    failSoft: rawConfig?.behavior?.failSoft !== false,
    enableAgentEndIngest: rawConfig?.behavior?.enableAgentEndIngest !== false,
  };

  const packing = {
    bucketPriority: Array.isArray(rawConfig?.packing?.bucketPriority)
      ? rawConfig.packing.bucketPriority.filter((value) => typeof value === 'string' && value.trim().length > 0)
      : DEFAULT_BUCKET_PRIORITY,
  };

  return {
    enabledAgents,
    baseUrl,
    timeoutMs,
    debug,
    recall,
    export: exportConfig,
    behavior,
    packing,
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

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeBaseUrl(value) {
  const text = typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'http://127.0.0.1:8765';
  return text.replace(/\/$/, '');
}

function normalizeTmpSuffix(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return '.tmp';
  }
  return value.startsWith('.') ? value.trim() : `.${value.trim()}`;
}
