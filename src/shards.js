const STABLE_SNAPSHOT_VERSION = 1;

const RESERVED_PROJECT_SLUGS = new Set([
  'global',
  'personal',
  'projects',
  'misc',
  'other',
  'temp',
  'unknown',
  'default',
  'none',
  'null',
]);

const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const FIXED_SHARDS = {
  'global/profile': {
    lane: 'global',
    scope: 'global',
    title: 'Global profile',
    description: 'Durable assistant-operational profile memory materialized from Vestige stable export.',
  },
  'global/preferences': {
    lane: 'global',
    scope: 'global',
    title: 'Global preferences',
    description: 'Durable assistant collaboration preferences materialized from Vestige stable export.',
  },
  'global/constraints': {
    lane: 'global',
    scope: 'global',
    title: 'Global constraints',
    description: 'Durable assistant-operational constraints materialized from Vestige stable export.',
  },
  'personal/people': {
    lane: 'personal',
    scope: 'personal',
    title: 'Personal people',
    description: 'Durable personal relationship memory materialized from Vestige stable export.',
  },
  'personal/routines': {
    lane: 'personal',
    scope: 'personal',
    title: 'Personal routines',
    description: 'Durable personal routine memory materialized from Vestige stable export.',
  },
  'personal/notable-events': {
    lane: 'personal',
    scope: 'personal',
    title: 'Personal notable events',
    description: 'Durable personal event memory materialized from Vestige stable export.',
  },
};

const REQUIRED_ITEM_FIELDS = [
  'vestige_id',
  'shard_key',
  'category',
  'statement',
  'transfer_reason',
  'confidence',
];

const REQUIRED_ENVELOPE_FIELDS = ['generation_id', 'generated_at', 'items'];

const OPTIONAL_ITEM_FIELD_ORDER = [
  'retention',
  'importance',
  'first_seen_at',
  'last_reinforced_at',
  'supersedes',
  'tags',
  'why_durable',
  'event_date',
  'project_slug',
  'decision_status',
  'source_refs',
];

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertTimestamp(value, label) {
  const text = assertNonEmptyString(value, label);
  if (!ISO_DATE_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp`);
  }
  return text;
}

function assertDateOrTimestamp(value, label) {
  const text = assertNonEmptyString(value, label);
  if (ISO_DATE_ONLY_PATTERN.test(text)) {
    return text;
  }
  return assertTimestamp(text, label);
}

function assertFiniteUnitInterval(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new RangeError(`${label} must be between 0 and 1 inclusive`);
  }
  return value;
}

function normalizeStringList(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const items = Array.isArray(value) ? value : [value];
  const normalized = items
    .map((item) => {
      if (typeof item !== 'string') {
        throw new TypeError(`${label} entries must be strings`);
      }
      return item.trim();
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function stableValueComparator(left, right) {
  const leftString = JSON.stringify(left);
  const rightString = JSON.stringify(right);
  if (leftString < rightString) {
    return -1;
  }
  if (leftString > rightString) {
    return 1;
  }
  return 0;
}

function normalizeJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = normalizeJsonValue(value[key]);
        return result;
      }, {});
  }

  return value;
}

function pickOptionalFields(item) {
  const optional = {};

  if (item.retention !== undefined) {
    optional.retention = assertFiniteUnitInterval(item.retention, 'item.retention');
  }
  if (item.importance !== undefined) {
    optional.importance = assertFiniteUnitInterval(item.importance, 'item.importance');
  }
  if (item.first_seen_at !== undefined) {
    optional.first_seen_at = assertTimestamp(item.first_seen_at, 'item.first_seen_at');
  }
  if (item.last_reinforced_at !== undefined) {
    optional.last_reinforced_at = assertTimestamp(item.last_reinforced_at, 'item.last_reinforced_at');
  }
  if (item.supersedes !== undefined) {
    optional.supersedes = normalizeStringList(item.supersedes, 'item.supersedes');
  }
  if (item.tags !== undefined) {
    optional.tags = normalizeStringList(item.tags, 'item.tags');
  }
  if (item.why_durable !== undefined) {
    optional.why_durable = assertNonEmptyString(item.why_durable, 'item.why_durable');
  }
  if (item.event_date !== undefined) {
    optional.event_date = assertDateOrTimestamp(item.event_date, 'item.event_date');
  }
  if (item.project_slug !== undefined) {
    optional.project_slug = validateProjectSlug(item.project_slug, 'item.project_slug');
  }
  if (item.decision_status !== undefined) {
    optional.decision_status = assertNonEmptyString(item.decision_status, 'item.decision_status');
  }
  if (item.source_refs !== undefined) {
    optional.source_refs = Array.isArray(item.source_refs)
      ? item.source_refs.map((entry) => normalizeJsonValue(entry))
      : [normalizeJsonValue(item.source_refs)];
  }

  const extras = {};
  for (const [key, value] of Object.entries(item)) {
    if (REQUIRED_ITEM_FIELDS.includes(key) || OPTIONAL_ITEM_FIELD_ORDER.includes(key)) {
      continue;
    }
    extras[key] = normalizeJsonValue(value);
  }

  if (Object.keys(extras).length > 0) {
    optional.extra = extras;
  }

  return optional;
}

function humanizeSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function quoteYamlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return quoteYamlString(value);
}

function renderYamlFrontmatter(frontmatter) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${formatScalar(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function renderListValue(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function renderMetadataValue(value) {
  if (Array.isArray(value)) {
    return renderListValue(value);
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '');
  }

  return String(value);
}

function compareItems(left, right) {
  const byId = left.vestige_id.localeCompare(right.vestige_id);
  if (byId !== 0) {
    return byId;
  }

  const byStatement = left.statement.localeCompare(right.statement);
  if (byStatement !== 0) {
    return byStatement;
  }

  return stableValueComparator(left, right);
}

function compareShardKeys(left, right) {
  return left.localeCompare(right);
}

function getShardDefinition(shardKey) {
  if (FIXED_SHARDS[shardKey]) {
    return {
      ...FIXED_SHARDS[shardKey],
      shard_key: shardKey,
      relative_path: `${shardKey}.md`,
    };
  }

  const segments = shardKey.split('/');
  if (segments.length !== 2 || segments[0] !== 'projects') {
    throw new TypeError(`Unsupported shard_key: ${shardKey}`);
  }

  const slug = validateProjectSlug(segments[1], 'project shard slug');

  return {
    lane: 'projects',
    scope: 'projects',
    shard_key: shardKey,
    slug,
    title: `Project ${humanizeSlug(slug)}`,
    description: 'Durable project memory materialized from Vestige stable export.',
    relative_path: `${shardKey}.md`,
  };
}

function normalizeProjectSlug(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48);
}

function validateProjectSlug(value, label = 'project_slug') {
  const slug = normalizeProjectSlug(assertNonEmptyString(value, label));
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new TypeError(`${label} must use lowercase ASCII kebab-case`);
  }
  if (RESERVED_PROJECT_SLUGS.has(slug)) {
    throw new RangeError(`${label} is reserved: ${slug}`);
  }
  return slug;
}

function parseShardKey(shardKey) {
  const key = assertNonEmptyString(shardKey, 'item.shard_key');
  if (FIXED_SHARDS[key]) {
    return getShardDefinition(key);
  }

  const segments = key.split('/');
  if (segments.length !== 2 || segments[0] !== 'projects') {
    throw new TypeError(`item.shard_key is not allowed: ${key}`);
  }

  return getShardDefinition(`projects/${segments[1]}`);
}

function validateExportItem(item, index = 0) {
  assertRecord(item, `items[${index}]`);

  const vestigeId = assertNonEmptyString(item.vestige_id, `items[${index}].vestige_id`);
  const shard = parseShardKey(item.shard_key);
  const category = assertNonEmptyString(item.category, `items[${index}].category`);
  const statement = assertNonEmptyString(item.statement, `items[${index}].statement`);
  const transferReason = assertNonEmptyString(item.transfer_reason, `items[${index}].transfer_reason`);
  const confidence = assertFiniteUnitInterval(item.confidence, `items[${index}].confidence`);
  const optional = pickOptionalFields(item);

  if (shard.lane === 'projects') {
    if (optional.project_slug && optional.project_slug !== shard.slug) {
      throw new RangeError(`items[${index}].project_slug must match shard slug ${shard.slug}`);
    }
    optional.project_slug = shard.slug;
  }

  return {
    vestige_id: vestigeId,
    shard_key: shard.shard_key,
    category,
    statement,
    transfer_reason: transferReason,
    confidence,
    ...optional,
  };
}

function validateExportEnvelope(envelope) {
  assertRecord(envelope, 'export envelope');

  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (!(field in envelope)) {
      throw new TypeError(`export envelope missing required field: ${field}`);
    }
  }

  const generation_id = assertNonEmptyString(envelope.generation_id, 'generation_id');
  const generated_at = assertTimestamp(envelope.generated_at, 'generated_at');

  if (!Array.isArray(envelope.items)) {
    throw new TypeError('items must be an array');
  }

  const items = envelope.items.map((item, index) => validateExportItem(item, index));

  return {
    generation_id,
    generated_at,
    items,
  };
}

function groupItemsByShard(items) {
  const groups = new Map();

  for (const item of items) {
    const shard = parseShardKey(item.shard_key);
    if (!groups.has(shard.shard_key)) {
      groups.set(shard.shard_key, {
        shard,
        items: [],
      });
    }
    groups.get(shard.shard_key).items.push(item);
  }

  return new Map(
    [...groups.entries()]
      .sort(([left], [right]) => compareShardKeys(left, right))
      .map(([key, group]) => [
        key,
        {
          shard: group.shard,
          items: [...group.items].sort(compareItems),
        },
      ]),
  );
}

function collectEntryMetadata(item) {
  const metadata = [
    ['statement', item.statement],
    ['category', item.category],
    ['confidence', item.confidence],
    ['transfer_reason', item.transfer_reason],
    ['vestige_id', item.vestige_id],
    ['shard_key', item.shard_key],
  ];

  for (const field of OPTIONAL_ITEM_FIELD_ORDER) {
    if (item[field] !== undefined) {
      metadata.push([field, item[field]]);
    }
  }

  if (item.extra && typeof item.extra === 'object') {
    for (const key of Object.keys(item.extra).sort()) {
      metadata.push([key, item.extra[key]]);
    }
  }

  return metadata;
}

function renderShardSnapshot({ shard, generation_id, generated_at, items }) {
  if (!shard || typeof shard !== 'object') {
    throw new TypeError('shard is required');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError(`renderShardSnapshot requires at least one item for ${shard.shard_key}`);
  }

  const frontmatter = renderYamlFrontmatter({
    source: 'vestige',
    type: 'stable-memory-snapshot',
    version: STABLE_SNAPSHOT_VERSION,
    generated_at,
    generation_id,
    scope: shard.scope,
    shard_key: shard.shard_key,
  });

  const sections = [
    frontmatter,
    `# ${shard.title}`,
    '',
    shard.description,
    'Current-truth snapshot. Regenerated by shard overwrite.',
  ];

  for (const item of [...items].sort(compareItems)) {
    sections.push('', `## ${item.vestige_id}`);
    for (const [key, value] of collectEntryMetadata(item)) {
      sections.push(`- ${key}: ${renderMetadataValue(value)}`);
    }
  }

  sections.push('');
  return sections.join('\n');
}

export {
  FIXED_SHARDS,
  OPTIONAL_ITEM_FIELD_ORDER,
  PROJECT_SLUG_PATTERN,
  RESERVED_PROJECT_SLUGS,
  REQUIRED_ENVELOPE_FIELDS,
  REQUIRED_ITEM_FIELDS,
  STABLE_SNAPSHOT_VERSION,
  getShardDefinition,
  groupItemsByShard,
  normalizeProjectSlug,
  parseShardKey,
  renderShardSnapshot,
  validateExportEnvelope,
  validateExportItem,
  validateProjectSlug,
};
