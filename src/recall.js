import { buildRecallQuery } from './query-builder.js';
import { normalizeEntries } from './normalize.js';
import { collapseDuplicates, dedupeRecentAgainstStable } from './dedupe.js';
import { packEntries } from './packing.js';
import { renderVestigeRecent } from './render.js';

function dropWithReason(entry, reason, extra = {}) {
  return {
    ...entry,
    dropReasons: [...(entry.dropReasons || []), reason],
    debug: {
      ...(entry.debug || {}),
      ...extra,
    },
  };
}

function extractSearchItems(payload) {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  const candidateArrays = [payload.items, payload.results, payload.memories, payload.matches, payload.data];
  for (const candidate of candidateArrays) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === 'object') {
      const nested = extractSearchItems(candidate);
      if (nested.length > 0) {
        return nested;
      }
    }
  }
  return [];
}

export function prepareRecentRecall(input = {}) {
  const {
    messages,
    latestUserTurn,
    recentTail,
    routeHint,
    projectHint,
    recentEntries = [],
    stableEntries = [],
    materializedIds = undefined,
    skipMaterialized = true,
    queryOptions = {},
    packOptions = {},
    renderOptions = {},
  } = input;

  const { query, parts } = buildRecallQuery({
    messages,
    latestUserTurn,
    recentTail,
    routeHint,
    projectHint,
    ...queryOptions,
  });

  const normalizedRecent = normalizeEntries(recentEntries, {
    defaultSource: 'vestige',
    defaultLayer: 'recent',
  });
  const normalizedStable = normalizeEntries(stableEntries, {
    defaultSource: 'cognee',
    defaultLayer: 'stable',
  });

  const filteredRecent = [];
  const dropped = [];
  const materializedIdSet = materializedIds instanceof Set
    ? materializedIds
    : new Set(Array.isArray(materializedIds) ? materializedIds.filter(Boolean) : []);

  for (const entry of normalizedRecent) {
    if (entry.id && materializedIdSet.has(entry.id)) {
      dropped.push(dropWithReason(entry, 'suppressed_by_materialization_ledger'));
      continue;
    }

    if (skipMaterialized && entry.materialized) {
      dropped.push(dropWithReason(entry, 'skipped_materialized_recent'));
      continue;
    }

    filteredRecent.push(entry);
  }

  const collapsed = collapseDuplicates(filteredRecent);
  const crossSource = dedupeRecentAgainstStable(collapsed.kept, normalizedStable);
  const packed = packEntries(crossSource.kept, packOptions);
  const packet = renderVestigeRecent(packed.selected, renderOptions);

  return {
    query,
    queryParts: parts,
    packet,
    selected: packed.selected,
    dropped: [
      ...dropped,
      ...collapsed.dropped,
      ...crossSource.dropped,
      ...packed.dropped,
    ],
    recent: normalizedRecent,
    stable: normalizedStable,
    stats: {
      ...packed.stats,
      inputRecent: normalizedRecent.length,
      inputStable: normalizedStable.length,
    },
  };
}

export async function buildRecentRecallPacket({
  sidecarClient,
  config,
  messages = [],
  latestUserTurn = '',
  recentTail = '',
  routeHint,
  projectHint,
  stableEntries = [],
  materializedIds,
  logger,
}) {
  const { query } = buildRecallQuery({
    messages,
    latestUserTurn,
    recentTail,
    routeHint,
    projectHint,
    maxChars: 600,
  });

  if (!query) {
    return { query: '', packet: '', selected: [], dropped: [], stats: { inputRecent: 0, inputStable: stableEntries.length } };
  }

  const response = await sidecarClient.search({
    query,
    maxResults: config.recall.maxResults,
    maxTokens: config.recall.maxTokens,
    skipMaterialized: config.recall.skipMaterialized,
  });

  if (!response?.ok) {
    logger?.warn?.(`recent recall search failed: ${response?.error || 'unknown error'}`);
    return { query, packet: '', selected: [], dropped: [], stats: { inputRecent: 0, inputStable: stableEntries.length }, response };
  }

  const recentEntries = extractSearchItems(response.data);
  const result = prepareRecentRecall({
    messages,
    latestUserTurn,
    recentTail,
    routeHint,
    projectHint,
    recentEntries,
    stableEntries,
    materializedIds,
    skipMaterialized: config.recall.skipMaterialized,
    packOptions: {
      bucketPriority: config.packing.bucketPriority,
      maxItems: config.recall.maxResults,
      softTargetTokens: config.recall.softTarget,
      hardCapTokens: config.recall.hardCap,
      maxChars: Math.max(config.recall.hardCap * 4, 800),
    },
    renderOptions: {
      maxChars: Math.max(config.recall.hardCap * 4, 800),
    },
  });

  logger?.debug?.(`recent recall query=${query} selected=${result.selected.length} dropped=${result.dropped.length}`);
  return {
    ...result,
    response,
  };
}

function compactWhitespace(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function messageRole(message) {
  return String(message?.role || message?.author || message?.type || 'message').toLowerCase();
}

function asMessageText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => asMessageText(item)).filter(Boolean).join(' ');
  }

  if (value && typeof value === 'object') {
    return [
      value.text,
      value.content,
      value.summary,
      value.body,
      value.message,
      value.value,
    ]
      .map((item) => asMessageText(item))
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function splitIntoStatements(text) {
  return String(text || '')
    .split(/(?<=[.!?。！？;；])\s+|\n+/)
    .map((segment) => compactWhitespace(segment))
    .filter(Boolean);
}

function sanitizeStatement(text) {
  return compactWhitespace(text)
    .replace(/^(?:user|assistant|system|developer|tool):\s*/i, '')
    .replace(/^(?:latest_user_turn|latest_assistant_turn):\s*/i, '')
    .trim();
}

function isForbiddenStatement(text) {
  return /^(?:conversation info|sender|openclaw turn checkpoint|source:|lane:|<\/??vestige_recent>)/i.test(text)
    || /session[_ -]?key|session[_ -]?id|agent[_ -]?id|messageProvider|workspaceDir/i.test(text);
}

function isDurableSemanticStatement(text) {
  if (!text || text.length < 12) {
    return false;
  }

  if (/[?？]\s*$/.test(text)) {
    return false;
  }

  return /\b(prefer|preference|preferably|likes?|wants?|doesn't want|avoid|priority|prioritize|always|never|must|should|need to|do not|don't|keep|remove|drop|skip|forbid|allow|rule|constraint|decision|decided|agreed|reject|rejected|accept|accepted|important)\b/i.test(text)
    || /更喜欢|偏好|优先|总是|从不|必须|应该|需要|不要|不能|规则|约束|决定|已决定|同意|拒绝|删除|移除|去掉|保留|跳过|重要/i.test(text);
}

function extractRecentSemanticStatements(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  const candidates = [];
  for (let index = Math.max(0, messages.length - 6); index < messages.length; index += 1) {
    const message = messages[index];
    const role = messageRole(message);
    if (role !== 'user') {
      continue;
    }

    const text = compactWhitespace(asMessageText(message));
    if (!text) {
      continue;
    }

    for (const statement of splitIntoStatements(text)) {
      const cleaned = sanitizeStatement(statement);
      if (!cleaned || isForbiddenStatement(cleaned) || !isDurableSemanticStatement(cleaned)) {
        continue;
      }
      candidates.push(cleaned);
    }
  }

  return [...new Set(candidates)].slice(-4);
}


