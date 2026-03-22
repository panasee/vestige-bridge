import { hashNormalizedText } from './normalize.js';

function withDropReason(entry, reason, extra = {}) {
  return {
    ...entry,
    dropReasons: [...(entry.dropReasons || []), reason],
    debug: {
      ...(entry.debug || {}),
      ...extra,
    },
  };
}

function timestampScore(entry) {
  if (!entry?.timestamp) {
    return 0;
  }
  const value = Date.parse(entry.timestamp);
  return Number.isFinite(value) ? value : 0;
}

function boundedScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(value, 1));
}

function isStable(entry) {
  return entry?.layer === 'stable';
}

function isRecent(entry) {
  return entry?.layer === 'recent';
}

function isCogneeMaterializedStable(entry) {
  return isStable(entry)
    && (entry?.source === 'cognee' || entry?.materialized || Boolean(entry?.shardKey));
}

function isExplicitOverride(entry) {
  return isRecent(entry) && (entry?.explicit || entry?.correction) && !entry?.inferred;
}

function tokenSet(text) {
  return new Set(String(text || '').split(/\s+/).filter((token) => token.length >= 3));
}

export function buildCanonicalKey(entry) {
  const normalizedText = entry?.normalizedText || '';
  const hash = hashNormalizedText(normalizedText);

  if (entry?.shardKey) {
    return `${entry.shardKey}::${hash}`;
  }

  const bucket = entry?.dataset || entry?.layer || 'memory';
  return `${bucket}::${hash}`;
}

export function compareEntryPriority(left, right) {
  if (isExplicitOverride(left) && right?.inferred && !isExplicitOverride(right)) {
    return 1;
  }
  if (isExplicitOverride(right) && left?.inferred && !isExplicitOverride(left)) {
    return -1;
  }
  if (isCogneeMaterializedStable(left) && !isCogneeMaterializedStable(right)) {
    return 1;
  }
  if (isCogneeMaterializedStable(right) && !isCogneeMaterializedStable(left)) {
    return -1;
  }
  if (isStable(left) && !isStable(right)) {
    return 1;
  }
  if (isStable(right) && !isStable(left)) {
    return -1;
  }
  if ((left?.explicit || left?.correction) && !(right?.explicit || right?.correction)) {
    return 1;
  }
  if ((right?.explicit || right?.correction) && !(left?.explicit || left?.correction)) {
    return -1;
  }

  const scoreDelta = boundedScore(left?.score) - boundedScore(right?.score);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const confidenceDelta = boundedScore(left?.confidence) - boundedScore(right?.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const timestampDelta = timestampScore(left) - timestampScore(right);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }

  const leftLength = left?.text?.length || 0;
  const rightLength = right?.text?.length || 0;
  if (leftLength !== rightLength) {
    return rightLength - leftLength;
  }

  return (right?.debug?.index || 0) - (left?.debug?.index || 0);
}

export function areNearDuplicate(left, right) {
  if (!left?.normalizedText || !right?.normalizedText) {
    return false;
  }

  if (buildCanonicalKey(left) === buildCanonicalKey(right)) {
    return true;
  }

  const stableVsRecent = (isStable(left) && !isStable(right)) || (isStable(right) && !isStable(left));
  if (!stableVsRecent) {
    return false;
  }

  const leftText = left.normalizedText;
  const rightText = right.normalizedText;
  const shorter = leftText.length <= rightText.length ? leftText : rightText;
  const longer = shorter === leftText ? rightText : leftText;

  if (shorter.length >= 48 && longer.includes(shorter)) {
    return true;
  }

  const leftTokens = tokenSet(leftText);
  const rightTokens = tokenSet(rightText);
  const minSize = Math.min(leftTokens.size, rightTokens.size);

  if (minSize < 6) {
    return false;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / minSize >= 0.9;
}

export function collapseDuplicates(entries = []) {
  const kept = [];
  const dropped = [];

  for (const entry of entries) {
    const duplicateIndex = kept.findIndex((candidate) => areNearDuplicate(candidate, entry));

    if (duplicateIndex === -1) {
      kept.push(entry);
      continue;
    }

    const existing = kept[duplicateIndex];
    const comparison = compareEntryPriority(entry, existing);

    if (comparison > 0) {
      kept[duplicateIndex] = entry;
      dropped.push(withDropReason(existing, 'duplicate_replaced_by_higher_priority', {
        replacedBy: entry.id || entry.text,
      }));
      continue;
    }

    dropped.push(withDropReason(entry, 'duplicate_lower_priority', {
      duplicateOf: existing.id || existing.text,
    }));
  }

  return { kept, dropped };
}

export function dedupeRecentAgainstStable(recentEntries = [], stableEntries = []) {
  const kept = [];
  const dropped = [];

  for (const entry of recentEntries) {
    const overlap = stableEntries.find((candidate) => areNearDuplicate(candidate, entry));

    if (!overlap) {
      kept.push(entry);
      continue;
    }

    const comparison = compareEntryPriority(entry, overlap);

    if (comparison > 0) {
      kept.push({
        ...entry,
        debug: {
          ...(entry.debug || {}),
          overridesStable: overlap.id || overlap.text,
        },
      });
      continue;
    }

    dropped.push(withDropReason(entry, 'overlap_with_materialized_stable', {
      overlappedWith: overlap.id || overlap.text,
      overlappedSource: overlap.source,
      overlappedShardKey: overlap.shardKey || null,
    }));
  }

  return { kept, dropped };
}
