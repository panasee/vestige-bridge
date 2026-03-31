import { buildRecallQuery } from './query-builder.js';
import { normalizeEntries } from './normalize.js';
import { collapseDuplicates, dedupeRecentAgainstStable } from './dedupe.js';
import { packEntries } from './packing.js';
import { renderVestigeRecent } from './render.js';
import { lookupCategories } from './category-store.js';

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
      dropped.push(dropWithReason(entry, 'suppressed_by_crystallized_materialization'));
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

  const rawEntries = extractSearchItems(response.data);

  // Attach stored category to each entry so deriveBucket can route it correctly.
  const entryIds = rawEntries.map((e) => e?.id).filter(Boolean);
  const categoryMap = await lookupCategories(entryIds).catch(() => new Map());
  const recentEntries = rawEntries.map((entry) => {
    if (!entry?.id || !categoryMap.has(entry.id)) return entry;
    return { ...entry, category: categoryMap.get(entry.id) };
  });

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


