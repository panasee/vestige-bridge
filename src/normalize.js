import crypto from 'node:crypto';

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeStatement(value) {
  return normalizeWhitespace(value).toLowerCase();
}

export function normalizedTextHash(value) {
  return crypto.createHash('sha1').update(normalizeStatement(value)).digest('hex').slice(0, 12);
}

export function bucketForCandidate(candidate = {}) {
  if (candidate.bucket && typeof candidate.bucket === 'string') {
    return candidate.bucket;
  }
  if (candidate.source === 'cognee' && candidate.materialized) {
    return 'other_stable';
  }
  if (candidate.source === 'vestige') {
    return 'recent';
  }
  return 'other';
}

export function canonicalKey(candidate = {}) {
  const statement = candidate.statement ?? candidate.text ?? '';
  const shardKey = typeof candidate.shardKey === 'string' ? candidate.shardKey.trim() : '';
  const source = typeof candidate.source === 'string' ? candidate.source.trim() : 'unknown';
  const hash = normalizedTextHash(statement);

  if (shardKey) {
    return `${shardKey}::${hash}`;
  }
  return `${source}::${hash}`;
}

export function normalizeCandidate(candidate = {}) {
  const statement = normalizeWhitespace(candidate.statement ?? candidate.text ?? '');
  const source = typeof candidate.source === 'string' && candidate.source.trim().length > 0
    ? candidate.source.trim()
    : 'vestige';
  const score = Number.isFinite(candidate.score) ? Number(candidate.score) : undefined;
  const materialized = Boolean(candidate.materialized);
  const shardKey = typeof candidate.shardKey === 'string' ? candidate.shardKey.trim() : '';

  return {
    ...candidate,
    source,
    statement,
    score,
    materialized,
    shardKey,
    bucket: bucketForCandidate({ ...candidate, source, materialized }),
    canonicalKey: canonicalKey({ ...candidate, source, statement, materialized, shardKey }),
  };
}
