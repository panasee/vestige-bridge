import { collectCrystallizedVestigeIds, loadCrystallizerMaterializedSources } from './crystallizer-ledger.js';
import { normalizeEntries, hashNormalizedText } from './normalize.js';
import { collapseDuplicates } from './dedupe.js';
import { deriveBucket } from './packing.js';
import { renderVestigeBullet } from './render.js';
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

async function loadSuppressedVestigeIds(logger) {
  try {
    const crystallizerLedger = await loadCrystallizerMaterializedSources();
    const ids = collectCrystallizedVestigeIds(crystallizerLedger.data);
    logger?.debug?.('using crystallizer materialized-sources ledger for recent suppress', {
      path: crystallizerLedger.path,
      count: ids.length,
    });
    return ids;
  } catch (error) {
    logger?.warn?.(`failed to load crystallizer materialized-sources ledger: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function mapBucketName(bucket) {
  const normalized = String(bucket || 'recent-other').trim().toLowerCase();
  switch (normalized) {
    case 'recent-project-momentum':
      return 'recent_project_momentum';
    case 'recent-constraint':
      return 'recent_constraint';
    case 'recent-preference':
      return 'recent_preference';
    case 'recent-life':
      return 'recent_life';
    case 'recent-other':
    default:
      return 'recent_other';
  }
}

export function buildRecentRecallCandidates({
  entries = [],
  materializedIds,
  skipMaterialized = true,
} = {}) {
  const normalizedRecent = normalizeEntries(entries, {
    defaultSource: 'vestige',
    defaultLayer: 'recent',
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
  const kept = collapsed.kept.map((entry) => {
    const bucket = mapBucketName(deriveBucket(entry));
    const text = renderVestigeBullet({ ...entry, label: bucket });
    return {
      canonicalKey: entry.id ? `vestige:${entry.id}` : `vestige:${hashNormalizedText(entry.text)}`,
      lane: 'recent',
      bucket,
      score: typeof entry.score === 'number' ? entry.score : (typeof entry.confidence === 'number' ? entry.confidence : 0.5),
      tokenEstimate: Math.max(1, Math.ceil(String(text || entry.text || '').length / 4)),
      text,
      provider: 'vestige-bridge',
      meta: {
        source: entry.source,
        category: entry.category,
        timestamp: entry.timestamp,
        routeHint: entry.routeHint,
        projectHint: entry.projectHint,
      },
    };
  }).filter((candidate) => candidate.text);

  return {
    candidates: kept,
    dropped: [...dropped, ...collapsed.dropped],
    stats: {
      inputRecent: normalizedRecent.length,
      selectedCount: kept.length,
      droppedCount: dropped.length + collapsed.dropped.length,
    },
  };
}

export async function collectRecentRecallCandidates({
  sidecarClient,
  config,
  query,
  logger,
} = {}) {
  const queryText = typeof query?.queryText === 'string' ? query.queryText.trim() : '';
  if (!queryText) {
    return [];
  }

  const suppressedVestigeIds = await loadSuppressedVestigeIds(logger);
  const response = await sidecarClient.search({
    query: queryText,
    maxResults: config.recall.maxResults,
    maxTokens: config.recall.maxTokens,
    skipMaterialized: config.recall.skipMaterialized,
  });

  if (!response?.ok) {
    logger?.warn?.(`recent recall search failed: ${response?.error || 'unknown error'}`);
    return [];
  }

  const rawEntries = extractSearchItems(response.data);

  // Attach stored category before normalization so deriveBucket can route correctly.
  const entryIds = rawEntries.map((e) => e?.id).filter(Boolean);
  const categoryMap = await lookupCategories(entryIds).catch(() => new Map());
  const recentEntries = rawEntries.map((entry) => {
    if (!entry?.id || !categoryMap.has(entry.id)) return entry;
    return { ...entry, category: categoryMap.get(entry.id) };
  });

  const result = buildRecentRecallCandidates({
    entries: recentEntries,
    materializedIds: suppressedVestigeIds,
    skipMaterialized: config.recall.skipMaterialized,
  });

  logger?.debug?.('provider recent recall candidates prepared', {
    query: queryText,
    selected: result.candidates.length,
    dropped: result.dropped.length,
  });

  return result.candidates;
}

export function createVestigeRecallProvider({ client, config, logger }) {
  return {
    id: 'vestige-bridge',
    lane: 'recent',
    async recall(query) {
      return collectRecentRecallCandidates({
        sidecarClient: client,
        config,
        query,
        logger,
      });
    },
  };
}
