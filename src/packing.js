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

export const DEFAULT_BUCKET_PRIORITY = [
  'recent-project-momentum',
  'recent-constraint',
  'recent-preference',
  'recent-life',
  'recent-other',
];

export function estimateTokens(value) {
  const chars = typeof value === 'number' ? value : String(value || '').length;
  return Math.max(1, Math.ceil(chars / 4));
}

export function deriveBucket(entry = {}) {
  if (entry.label) {
    return String(entry.label).toLowerCase();
  }

  const category = String(entry.category || '').toLowerCase();
  const shardKey = String(entry.shardKey || '').toLowerCase();
  const routeHint = String(entry.routeHint || '').toLowerCase();
  const projectHint = String(entry.projectHint || '').toLowerCase();

  if (
    category.includes('project')
    || shardKey.startsWith('projects/')
    || routeHint.includes('project')
    || projectHint
  ) {
    return 'recent-project-momentum';
  }

  if (category.includes('constraint')) {
    return 'recent-constraint';
  }

  if (category.includes('preference')) {
    return 'recent-preference';
  }

  if (
    category.includes('routine')
    || category.includes('event')
    || category.includes('person')
    || category.includes('life')
  ) {
    return 'recent-life';
  }

  return 'recent-other';
}

function sortEntries(entries, bucketPriority) {
  const priorityIndex = new Map(bucketPriority.map((bucket, index) => [bucket, index]));

  return [...entries].sort((left, right) => {
    const leftBucket = deriveBucket(left);
    const rightBucket = deriveBucket(right);
    const bucketDelta = (priorityIndex.get(leftBucket) ?? bucketPriority.length)
      - (priorityIndex.get(rightBucket) ?? bucketPriority.length);

    if (bucketDelta !== 0) {
      return bucketDelta;
    }

    if ((left.explicit || left.correction) !== (right.explicit || right.correction)) {
      return (right.explicit || right.correction) - (left.explicit || left.correction);
    }

    const leftScore = typeof left.score === 'number' ? left.score : 0;
    const rightScore = typeof right.score === 'number' ? right.score : 0;
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    const leftTime = left.timestamp ? Date.parse(left.timestamp) || 0 : 0;
    const rightTime = right.timestamp ? Date.parse(right.timestamp) || 0 : 0;
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    return (left.debug?.index || 0) - (right.debug?.index || 0);
  });
}

function estimateEntryChars(entry) {
  const bucket = deriveBucket(entry);
  const labelChars = bucket ? bucket.length + 4 : 0;
  return 4 + labelChars + (entry.text?.length || 0);
}

export function packEntries(entries = [], options = {}) {
  const {
    bucketPriority = DEFAULT_BUCKET_PRIORITY,
    maxItems = 4,
    softTargetTokens = 180,
    hardCapTokens = 280,
    maxChars = 1200,
  } = options;

  const sorted = sortEntries(entries, bucketPriority);
  const selected = [];
  const dropped = [];
  let totalTokens = 0;
  let totalChars = 0;

  for (const entry of sorted) {
    const bucket = deriveBucket(entry);
    const entryChars = estimateEntryChars(entry);
    const entryTokens = estimateTokens(entryChars);

    if (selected.length >= maxItems) {
      dropped.push(withDropReason(entry, 'dropped_by_max_items', { bucket }));
      continue;
    }

    if (totalTokens >= softTargetTokens && bucket !== bucketPriority[0]) {
      dropped.push(withDropReason(entry, 'dropped_by_soft_target', { bucket }));
      continue;
    }

    if (totalTokens + entryTokens > hardCapTokens || totalChars + entryChars > maxChars) {
      dropped.push(withDropReason(entry, 'dropped_by_hard_cap', { bucket }));
      continue;
    }

    selected.push({
      ...entry,
      label: bucket,
    });
    totalTokens += entryTokens;
    totalChars += entryChars;
  }

  return {
    selected,
    dropped,
    stats: {
      totalTokens,
      totalChars,
      selectedCount: selected.length,
      droppedCount: dropped.length,
    },
  };
}
