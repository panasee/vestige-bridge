function ensureSentence(text) {
  const value = String(text || '').trim();
  if (!value) {
    return '';
  }
  if (/[.!?]$/.test(value)) {
    return value;
  }
  return `${value}.`;
}

function sanitizeLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value.trim());
    return Number.isFinite(date.getTime()) ? date : null;
  }
  return null;
}

function ageInDays(value, now = new Date()) {
  const timestamp = parseTimestamp(value);
  if (!timestamp) {
    return null;
  }
  const diffMs = now.getTime() - timestamp.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return null;
  }
  return Math.floor(diffMs / 86400000);
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

const TIME_SENSITIVE_BUCKETS = new Set([
  'recent_project_momentum',
  'recent-project-momentum',
  'library_reference',
  'library-reference',
]);

const STABLE_NON_TIME_SENSITIVE_BUCKETS = new Set([
  'recent_constraint',
  'recent-constraint',
  'recent_preference',
  'recent-preference',
  'global_constraints',
  'global_preferences',
  'personal_stable',
]);

const TIME_SENSITIVE_TEXT_PATTERNS = [
  'current ',
  'currently ',
  'now ',
  'at the moment',
  'config',
  'configuration',
  'path',
  'file',
  'directory',
  'environment',
  'tooling',
  'version',
  'located at',
  'depends on',
  'endpoint',
  'database',
  'schema',
  'runtime',
  'repo',
  'repository',
  'code path',
  'workflow',
];

const STABLE_PREFERENCE_TEXT_PATTERNS = [
  'prefer',
  'preference',
  'likes ',
  'dislikes ',
  'must ',
  'must not',
  'never ',
  'always ',
  'should usually',
  'non-negotiable',
  'constraint',
  'rule',
];

export function isTimeSensitiveMemory(entry) {
  const bucket = String(entry?.bucket || entry?.label || entry?.category || '').trim().toLowerCase();
  if (bucket && STABLE_NON_TIME_SENSITIVE_BUCKETS.has(bucket)) {
    return false;
  }
  if (bucket && TIME_SENSITIVE_BUCKETS.has(bucket)) {
    return true;
  }

  const text = String(entry?.text || entry?.statement || '').trim().toLowerCase();
  if (!text) {
    return false;
  }

  if (entry?.explicit || entry?.correction) {
    return false;
  }

  const hasTimeSensitiveCue = includesAny(text, TIME_SENSITIVE_TEXT_PATTERNS);
  if (!hasTimeSensitiveCue) {
    return false;
  }

  const hasStablePreferenceCue = includesAny(text, STABLE_PREFERENCE_TEXT_PATTERNS);
  if (hasStablePreferenceCue && !includesAny(text, ['config', 'path', 'directory', 'environment', 'version', 'database', 'schema', 'runtime', 'repo', 'repository'])) {
    return false;
  }

  return true;
}

export function buildFreshnessHint(entry, options = {}) {
  const enabled = options?.enabled !== false;
  if (!enabled || !isTimeSensitiveMemory(entry)) {
    return '';
  }

  const thresholdDays = Number.isInteger(options?.thresholdDays) ? options.thresholdDays : 14;
  const days = ageInDays(entry?.timestamp || entry?.meta?.timestamp, options?.now instanceof Date ? options.now : new Date());
  if (days === null || days < thresholdDays) {
    return '';
  }

  return `Recorded ${days} days ago; verify against current code/config before relying on it.`;
}

export function renderVestigeBullet(entry, options = {}) {
  const text = ensureSentence(entry?.text || entry?.statement);
  if (!text) {
    return '';
  }

  const hint = ensureSentence(buildFreshnessHint(entry, options));
  const rendered = hint ? `${text} ${hint}` : text;

  const label = sanitizeLabel(entry?.label);
  if (!label) {
    return `- ${rendered}`;
  }

  return `- [${label}] ${rendered}`;
}

export function renderVestigeRecent(entries = [], options = {}) {
  const { maxChars = 1400 } = options;
  const lines = entries
    .map((entry) => renderVestigeBullet(entry, options))
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }

  const packet = `<vestige_recent>\n${lines.join('\n')}\n</vestige_recent>`;
  if (packet.length <= maxChars) {
    return packet;
  }

  const boundedLines = [];
  let total = '<vestige_recent>\n</vestige_recent>'.length;

  for (const line of lines) {
    const lineSize = line.length + 1;
    if (total + lineSize > maxChars) {
      break;
    }

    boundedLines.push(line);
    total += lineSize;
  }

  if (boundedLines.length === 0) {
    return '';
  }

  return `<vestige_recent>\n${boundedLines.join('\n')}\n</vestige_recent>`;
}
