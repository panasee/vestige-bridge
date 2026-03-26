import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_STATE = Object.freeze({
  lastExtractAttemptAt: null,
  lastExtractSuccessAt: null,
  lastSummaryWatermarkByConversation: {},
  lastMessageWatermark: {},
  processedFingerprints: {},
});

function cloneDefaultState() {
  return {
    lastExtractAttemptAt: DEFAULT_STATE.lastExtractAttemptAt,
    lastExtractSuccessAt: DEFAULT_STATE.lastExtractSuccessAt,
    lastSummaryWatermarkByConversation: {},
    lastMessageWatermark: {},
    processedFingerprints: {},
  };
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function resolveTriggerLedgerPath(config = {}) {
  const explicit = typeof config?.behavior?.triggerLedgerPath === 'string' ? config.behavior.triggerLedgerPath.trim() : '';
  if (explicit) return explicit;
  const stateHome = process.env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'openclaw', 'vestige-bridge', 'trigger-ledger.json');
}

export async function loadTriggerLedger(config = {}) {
  const ledgerPath = resolveTriggerLedgerPath(config);
  try {
    const raw = await fs.readFile(ledgerPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      path: ledgerPath,
      state: {
        lastExtractAttemptAt: typeof parsed?.lastExtractAttemptAt === 'string' ? parsed.lastExtractAttemptAt : null,
        lastExtractSuccessAt: typeof parsed?.lastExtractSuccessAt === 'string' ? parsed.lastExtractSuccessAt : null,
        lastSummaryWatermarkByConversation: normalizeObject(parsed?.lastSummaryWatermarkByConversation),
        lastMessageWatermark: normalizeObject(parsed?.lastMessageWatermark),
        processedFingerprints: normalizeObject(parsed?.processedFingerprints),
      },
    };
  } catch {
    return { path: ledgerPath, state: cloneDefaultState() };
  }
}

export async function saveTriggerLedger(ledgerPath, state) {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const tmpPath = `${ledgerPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tmpPath, ledgerPath);
  return { path: ledgerPath, state };
}

export function pruneProcessedFingerprints(processedFingerprints = {}, ttlMs = 7 * 24 * 60 * 60 * 1000, nowMs = Date.now()) {
  const next = {};
  for (const [fingerprint, iso] of Object.entries(processedFingerprints)) {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    if (nowMs - ts <= ttlMs) next[fingerprint] = iso;
  }
  return next;
}

export function markProcessedFingerprint(state, fingerprint, atIso) {
  return {
    ...state,
    processedFingerprints: {
      ...normalizeObject(state?.processedFingerprints),
      [fingerprint]: atIso,
    },
  };
}

export function hasProcessedFingerprint(state, fingerprint) {
  return Boolean(state?.processedFingerprints && state.processedFingerprints[fingerprint]);
}

export function getSummaryWatermarkForConversation(state, conversationId) {
  if (conversationId === null || conversationId === undefined) {
    return { latestCreatedAt: null, latestSummaryId: null };
  }
  const key = String(conversationId);
  const raw = normalizeObject(state?.lastSummaryWatermarkByConversation)?.[key];
  return {
    latestCreatedAt: typeof raw?.latestCreatedAt === 'string' ? raw.latestCreatedAt : null,
    latestSummaryId: typeof raw?.latestSummaryId === 'string' ? raw.latestSummaryId : null,
  };
}

export function updateSummaryWatermark(state, conversationId, watermark) {
  if (conversationId === null || conversationId === undefined) {
    return state;
  }
  const key = String(conversationId);
  return {
    ...state,
    lastSummaryWatermarkByConversation: {
      ...normalizeObject(state?.lastSummaryWatermarkByConversation),
      [key]: {
        latestCreatedAt: watermark?.latestCreatedAt ?? null,
        latestSummaryId: watermark?.latestSummaryId ?? null,
      },
    },
  };
}

export function updateMessageWatermark(state, messageWatermark) {
  return {
    ...state,
    lastMessageWatermark: {
      ...normalizeObject(state?.lastMessageWatermark),
      ...normalizeObject(messageWatermark),
    },
  };
}
