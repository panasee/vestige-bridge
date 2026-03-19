import path from 'node:path';

const RESERVED_PROJECT_SLUGS = new Set(['global', 'personal', 'projects', 'misc', 'other', 'temp', 'unknown', 'default', 'none', 'null']);
const PROJECT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeProjectSlug(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export function isValidProjectSlug(value) {
  return PROJECT_SLUG_RE.test(value) && !RESERVED_PROJECT_SLUGS.has(value);
}

export function classifyScopeFromShardKey(shardKey) {
  if (typeof shardKey !== 'string' || shardKey.trim().length === 0) {
    throw new Error('Invalid shard_key: empty');
  }

  const normalized = shardKey.trim();
  if (normalized.startsWith('global/')) {
    return 'global';
  }
  if (normalized.startsWith('personal/')) {
    return 'personal';
  }
  if (normalized.startsWith('projects/')) {
    return 'projects';
  }

  throw new Error(`Invalid shard_key lane: ${normalized}`);
}

export function validateShardKey(shardKey) {
  const scope = classifyScopeFromShardKey(shardKey);
  if (scope === 'projects') {
    const projectSlug = shardKey.slice('projects/'.length);
    if (!isValidProjectSlug(projectSlug)) {
      throw new Error(`Invalid project shard slug: ${projectSlug}`);
    }
  }
  if (/\b(?:misc|other)\b/.test(shardKey)) {
    throw new Error(`Invalid shard_key bucket: ${shardKey}`);
  }
  return { shardKey, scope };
}

export function groupExportItemsByShard(items = []) {
  const groups = new Map();

  for (const item of items) {
    validateExportItem(item);
    const { shardKey, scope } = validateShardKey(item.shard_key);
    const bucket = groups.get(shardKey) ?? { shardKey, scope, items: [] };
    bucket.items.push(item);
    groups.set(shardKey, bucket);
  }

  return Array.from(groups.values()).sort((left, right) => left.shardKey.localeCompare(right.shardKey));
}

export function shardPathForKey(rootDir, shardKey) {
  return path.join(rootDir, `${shardKey}.md`);
}

export function validateExportEnvelope(envelope = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Invalid export envelope');
  }
  if (typeof envelope.generation_id !== 'string' || envelope.generation_id.trim().length === 0) {
    throw new Error('Missing generation_id');
  }
  if (typeof envelope.generated_at !== 'string' || envelope.generated_at.trim().length === 0) {
    throw new Error('Missing generated_at');
  }
  if (!Array.isArray(envelope.items)) {
    throw new Error('Missing items array');
  }

  for (const item of envelope.items) {
    validateExportItem(item);
  }

  return envelope;
}

export function validateExportItem(item = {}) {
  if (!item || typeof item !== 'object') {
    throw new Error('Invalid export item');
  }

  const requiredStringFields = ['vestige_id', 'shard_key', 'category', 'statement', 'transfer_reason'];
  for (const field of requiredStringFields) {
    if (typeof item[field] !== 'string' || item[field].trim().length === 0) {
      throw new Error(`Missing ${field}`);
    }
  }

  if (!Number.isFinite(item.confidence)) {
    throw new Error('Missing confidence');
  }

  validateShardKey(item.shard_key);
  return item;
}
