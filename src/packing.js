const DEFAULT_CHAR_RATIO = 4;

function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / DEFAULT_CHAR_RATIO);
}

export function packCandidates(candidates = [], { bucketPriority = [], softTarget = 240, hardCap = 320 } = {}) {
  const bucketOrder = new Map(bucketPriority.map((bucket, index) => [bucket, index]));
  const ordered = [...candidates].sort((left, right) => {
    const leftBucket = bucketOrder.has(left.bucket) ? bucketOrder.get(left.bucket) : Number.MAX_SAFE_INTEGER;
    const rightBucket = bucketOrder.has(right.bucket) ? bucketOrder.get(right.bucket) : Number.MAX_SAFE_INTEGER;
    if (leftBucket !== rightBucket) {
      return leftBucket - rightBucket;
    }

    const leftScore = Number.isFinite(left.score) ? left.score : -Infinity;
    const rightScore = Number.isFinite(right.score) ? right.score : -Infinity;
    return rightScore - leftScore;
  });

  const kept = [];
  const dropped = [];
  let totalTokens = 0;

  for (const candidate of ordered) {
    const cost = estimateTokens(candidate.statement);
    const nextTotal = totalTokens + cost;
    const overSoftTarget = kept.length > 0 && nextTotal > softTarget;
    const overHardCap = nextTotal > hardCap;

    if (overHardCap || overSoftTarget) {
      dropped.push({ candidate, reason: overHardCap ? 'over_hard_cap' : 'over_soft_target' });
      continue;
    }

    kept.push({ ...candidate, estimatedTokens: cost });
    totalTokens = nextTotal;
  }

  return {
    kept,
    dropped,
    totalTokens,
  };
}
