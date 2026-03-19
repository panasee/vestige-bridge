import { normalizeCandidate, normalizedTextHash } from './normalize.js';

function compareCandidates(left, right) {
  const leftPriority = priorityFor(left);
  const rightPriority = priorityFor(right);
  if (leftPriority !== rightPriority) {
    return rightPriority - leftPriority;
  }

  const leftScore = Number.isFinite(left.score) ? left.score : -Infinity;
  const rightScore = Number.isFinite(right.score) ? right.score : -Infinity;
  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  return String(left.statement).localeCompare(String(right.statement));
}

function priorityFor(candidate) {
  if (candidate.source === 'cognee' && candidate.materialized) {
    return 100;
  }
  if (candidate.source === 'vestige' && !candidate.materialized) {
    return 60;
  }
  if (candidate.source === 'cognee') {
    return 50;
  }
  return 10;
}

function semanticKeyFor(candidate) {
  return normalizedTextHash(candidate.statement);
}

export function dedupeCandidates(candidates = []) {
  const dropped = [];
  const byKey = new Map();
  const bySemanticKey = new Map();

  for (const rawCandidate of Array.isArray(candidates) ? candidates : []) {
    const candidate = normalizeCandidate(rawCandidate);
    if (!candidate.statement) {
      dropped.push({ candidate, reason: 'empty_statement' });
      continue;
    }

    const duplicateKeys = [candidate.canonicalKey, semanticKeyFor(candidate)];
    let existing = null;
    for (const key of duplicateKeys) {
      if (byKey.has(key)) {
        existing = byKey.get(key);
        break;
      }
      if (bySemanticKey.has(key)) {
        existing = bySemanticKey.get(key);
        break;
      }
    }

    if (!existing) {
      byKey.set(candidate.canonicalKey, candidate);
      bySemanticKey.set(semanticKeyFor(candidate), candidate);
      continue;
    }

    const ordered = [existing, candidate].sort(compareCandidates);
    const kept = ordered[0];
    const removed = ordered[1];

    byKey.set(kept.canonicalKey, kept);
    bySemanticKey.set(semanticKeyFor(kept), kept);
    dropped.push({ candidate: removed, kept, reason: 'duplicate_statement' });
  }

  const unique = new Map();
  for (const candidate of bySemanticKey.values()) {
    unique.set(semanticKeyFor(candidate), candidate);
  }

  return {
    kept: Array.from(unique.values()).sort(compareCandidates),
    dropped,
  };
}
