import { createHash } from 'node:crypto';

function asText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => asText(item))
      .filter(Boolean)
      .join(' ');
  }

  if (value && typeof value === 'object') {
    return [
      value.statement,
      value.text,
      value.content,
      value.summary,
      value.body,
      value.message,
      value.value,
    ]
      .map((item) => asText(item))
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (!lowered) {
      return false;
    }
    return ['1', 'true', 'yes', 'y', 'on'].includes(lowered);
  }
  return false;
}

function normalizeUnicode(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00A0/g, ' ');
}

function stripWrappers(text) {
  return normalizeUnicode(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?(?:vestige_recent|cognee_stable)[^>]*>/gi, ' ')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\[(?:recent|stable|memory|preference|constraint|project)[^\]]*\]\s*/gi, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanDisplayText(text) {
  return stripWrappers(asText(text))
    .replace(/^[:;,.\-\s]+/, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

export function normalizeText(text) {
  return cleanDisplayText(text)
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[()[\]{}<>]/g, ' ')
    .replace(/[.,;:!?/\\|]+/g, ' ')
    .replace(/\s+-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashNormalizedText(text) {
  return createHash('sha1').update(normalizeText(text)).digest('hex');
}

export function pickEntryText(entry) {
  if (typeof entry === 'string') {
    return entry;
  }
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  return asText([
    entry.statement,
    entry.text,
    entry.content,
    entry.summary,
    entry.body,
    entry.message,
    entry.value,
  ]);
}

function normalizeSource(entry, fallbackSource) {
  const source = entry?.source || entry?.provider || entry?.origin || fallbackSource || 'unknown';
  return String(source).toLowerCase();
}

function normalizeLayer(entry, fallbackLayer) {
  if (entry?.layer) {
    return String(entry.layer).toLowerCase();
  }
  if (entry?.materialized || entry?.materialized_generation || entry?.shard_key || entry?.shardKey) {
    return 'stable';
  }
  if (entry?.source === 'cognee') {
    return 'stable';
  }
  if (entry?.source === 'vestige') {
    return 'recent';
  }
  return fallbackLayer || 'recent';
}

function normalizeTimestamp(entry) {
  return (
    entry?.timestamp
    || entry?.updated_at
    || entry?.updatedAt
    || entry?.last_seen_at
    || entry?.lastSeenAt
    || entry?.last_reinforced_at
    || entry?.lastReinforcedAt
    || entry?.created_at
    || entry?.createdAt
    || null
  );
}

function cloneDropReasons(entry) {
  if (!Array.isArray(entry?.dropReasons)) {
    return [];
  }
  return [...entry.dropReasons];
}

export function normalizeEntry(entry, options = {}) {
  const {
    defaultSource,
    defaultLayer,
    index = 0,
  } = options;

  const raw = typeof entry === 'string' ? { text: entry } : (entry || {});
  const text = cleanDisplayText(pickEntryText(raw));
  const normalizedText = normalizeText(text);

  return {
    raw,
    id: raw.id || raw.vestige_id || raw.memory_id || raw.memoryId || null,
    source: normalizeSource(raw, defaultSource),
    layer: normalizeLayer(raw, defaultLayer),
    category: raw.category || raw.type || raw.kind || null,
    label: raw.label || raw.bucket || raw.tag || null,
    dataset: raw.dataset || raw.bucket || null,
    shardKey: raw.shardKey || raw.shard_key || null,
    text,
    normalizedText,
    statement: text,
    score: toNumber(raw.score ?? raw.relevance ?? raw.retrieval_score),
    confidence: toNumber(raw.confidence),
    materialized: toBoolean(raw.materialized)
      || Boolean(raw.materialized_generation)
      || Boolean(raw.shardKey || raw.shard_key),
    explicit: toBoolean(raw.explicit)
      || toBoolean(raw.user_confirmed)
      || toBoolean(raw.userConfirmed)
      || toBoolean(raw.explicit_user)
      || toBoolean(raw.explicitUser),
    inferred: toBoolean(raw.inferred) || toBoolean(raw.inference),
    correction: toBoolean(raw.correction) || toBoolean(raw.isCorrection),
    timestamp: normalizeTimestamp(raw),
    projectHint: raw.projectHint || raw.project_hint || null,
    routeHint: raw.routeHint || raw.route_hint || null,
    dropReasons: cloneDropReasons(raw),
    debug: {
      index,
      rawSource: raw.source || null,
      rawLayer: raw.layer || null,
    },
  };
}

export function normalizeEntries(entries = [], options = {}) {
  return entries
    .map((entry, index) => normalizeEntry(entry, { ...options, index }))
    .filter((entry) => entry.text);
}
