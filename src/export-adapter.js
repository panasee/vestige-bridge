import fs from 'node:fs/promises';
import path from 'node:path';

import { cleanDisplayText, normalizeText } from './normalize.js';
import { normalizeProjectSlug } from './shards.js';

const MIN_RETENTION = 0.55;
const MIN_STRONG_SIGNAL_RETENTION = 0.35;
const MAX_STATEMENT_LENGTH = 400;
const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function clampUnit(value, fallback = null) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, number));
}

function ensureIsoTimestamp(value) {
  const text = compactWhitespace(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function normalizeTags(tags) {
  return uniqueStrings(
    asArray(tags).map((tag) => compactWhitespace(tag).toLowerCase()),
  );
}

function hasAnyTag(tags, candidates) {
  return candidates.some((candidate) => tags.includes(candidate));
}

function extractProjectSlugFromTags(tags) {
  for (const tag of tags) {
    const match = tag.match(/^(?:project|repo|workspace)[:/](.+)$/i);
    if (!match) {
      continue;
    }
    const slug = normalizeProjectSlug(match[1]);
    if (slug) {
      return slug;
    }
  }
  return null;
}

function extractProjectSlugFromSource(source) {
  const text = compactWhitespace(source);
  if (!text) {
    return null;
  }

  const patterns = [
    /\/workspace\/([a-z0-9][a-z0-9-]{1,47})(?:\/|$)/i,
    /repo:([a-z0-9][a-z0-9-]{1,47})/i,
    /project:([a-z0-9][a-z0-9-]{1,47})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) {
      continue;
    }
    const slug = normalizeProjectSlug(match[1]);
    if (slug) {
      return slug;
    }
  }

  return null;
}

function inferProjectSlug(node, options = {}) {
  const explicitProjectSlug = normalizeProjectSlug(
    options.projectSlug
    || options.project_slug
    || node?.raw?.projectSlug
    || node?.raw?.project_slug,
  );

  return explicitProjectSlug || extractProjectSlugFromTags(node.tags) || extractProjectSlugFromSource(node.source);
}

function normalizeKnowledgeNode(raw = {}) {
  const content = cleanDisplayText(raw.content || raw.text || '');
  return {
    id: compactWhitespace(raw.id),
    content,
    normalizedContent: normalizeText(content),
    nodeType: compactWhitespace(raw.nodeType || raw.node_type || 'fact').toLowerCase(),
    createdAt: ensureIsoTimestamp(raw.createdAt || raw.created_at),
    updatedAt: ensureIsoTimestamp(raw.updatedAt || raw.updated_at),
    lastAccessed: ensureIsoTimestamp(raw.lastAccessed || raw.last_accessed),
    retentionStrength: clampUnit(raw.retentionStrength || raw.retention_strength, null),
    retrievalStrength: clampUnit(raw.retrievalStrength || raw.retrieval_strength, null),
    storageStrength: clampUnit(raw.storageStrength || raw.storage_strength, null),
    source: compactWhitespace(raw.source),
    tags: normalizeTags(raw.tags),
    validFrom: ensureIsoTimestamp(raw.validFrom || raw.valid_from),
    validUntil: ensureIsoTimestamp(raw.validUntil || raw.valid_until),
    utilityScore: clampUnit(raw.utilityScore || raw.utility_score, null),
    raw,
  };
}

function looksLikeProfileStatement(content) {
  return /^(?:user is|the user is|i am|i'm|用户是|用户为)/i.test(content);
}

function looksLikeConstraintStatement(content) {
  return /\b(?:always|never|do not|don't|before|after|must|should|need to|remember to|if)\b/i.test(content)
    || /总是|从不|不要|不能|必须|应该|需要|规则|约束/i.test(content);
}

function looksLikePreferenceStatement(content) {
  return /\b(?:prefer|prefers|preferred|preference|likes?|wants?|doesn't want|avoid|priority|prioritize)\b/i.test(content)
    || /更喜欢|偏好|优先/i.test(content);
}

function looksLikeDecisionStatement(content) {
  return /\b(?:decision|decided|agreed|accepted|rejected|approved|finalized|resolved)\b/i.test(content)
    || /决定|已决定|同意|拒绝|通过|最终确定/i.test(content);
}

function determineLifecycleReason(node, label, signals = {}) {
  const retention = node.retentionStrength ?? 0;
  if (retention >= 0.75) {
    return `${label}_high_retention`;
  }
  if (signals.tagged) {
    return `${label}_tagged`;
  }
  if (signals.semantic) {
    return `${label}_semantic`;
  }
  return `${label}_eligible`;
}

function buildBaseItem(node, classification) {
  const tags = uniqueStrings(node.tags);
  const sourceRefs = node.source
    ? [
        {
          vestige_id: node.id,
          source: node.source,
        },
      ]
    : undefined;

  return {
    vestige_id: node.id,
    shard_key: classification.shard_key,
    category: classification.category,
    statement: node.content.slice(0, MAX_STATEMENT_LENGTH).trim(),
    transfer_reason: classification.transfer_reason,
    confidence: classification.confidence,
    retention: node.retentionStrength ?? undefined,
    importance: node.utilityScore ?? undefined,
    first_seen_at: node.createdAt ?? undefined,
    last_reinforced_at: node.lastAccessed ?? node.updatedAt ?? undefined,
    tags: tags.length > 0 ? tags : undefined,
    why_durable: classification.why_durable,
    project_slug: classification.project_slug ?? undefined,
    decision_status: classification.decision_status ?? undefined,
    source_refs: sourceRefs,
  };
}

function classifyProjectNode(node, projectSlug) {
  if (!projectSlug) {
    return null;
  }

  const tags = node.tags;
  const content = node.content;
  const retention = node.retentionStrength ?? 0;
  const taggedProjectSignal = hasAnyTag(tags, ['decision', 'constraint', 'preference', 'project']);
  const semanticProjectSignal = looksLikeDecisionStatement(content)
    || looksLikeConstraintStatement(content)
    || looksLikePreferenceStatement(content);
  const signalStrength = retention >= MIN_RETENTION || taggedProjectSignal || semanticProjectSignal;
  if (!signalStrength) {
    return null;
  }

  let category = 'project_fact';
  let label = 'project_fact';
  let why = 'Project-scoped memory with explicit project slug and stable retention.';
  let confidence = retention >= 0.75 ? 0.9 : 0.82;
  let signals = { tagged: taggedProjectSignal, semantic: semanticProjectSignal };

  if (hasAnyTag(tags, ['decision', 'decision-made', 'decided']) || looksLikeDecisionStatement(content)) {
    category = 'project_decision';
    label = 'project_decision';
    why = hasAnyTag(tags, ['decision', 'decision-made', 'decided'])
      ? 'Project-scoped decision tagged explicitly for durable export.'
      : 'Project-scoped decision inferred from semantic content.';
    confidence = hasAnyTag(tags, ['decision', 'decision-made', 'decided']) ? 0.93 : 0.84;
    signals = {
      tagged: hasAnyTag(tags, ['decision', 'decision-made', 'decided']),
      semantic: looksLikeDecisionStatement(content),
    };
  } else if (hasAnyTag(tags, ['constraint', 'rule', 'policy', 'guardrail']) || looksLikeConstraintStatement(content)) {
    category = 'project_constraint';
    label = 'project_constraint';
    why = hasAnyTag(tags, ['constraint', 'rule', 'policy', 'guardrail'])
      ? 'Project-scoped constraint/rule tagged explicitly for durable export.'
      : 'Project-scoped constraint inferred from semantic content.';
    confidence = hasAnyTag(tags, ['constraint', 'rule', 'policy', 'guardrail']) ? 0.91 : 0.82;
    signals = {
      tagged: hasAnyTag(tags, ['constraint', 'rule', 'policy', 'guardrail']),
      semantic: looksLikeConstraintStatement(content),
    };
  } else if (hasAnyTag(tags, ['preference', 'workflow']) || looksLikePreferenceStatement(content)) {
    category = 'project_preference';
    label = 'project_preference';
    why = hasAnyTag(tags, ['preference', 'workflow'])
      ? 'Project-scoped preference/workflow memory tagged explicitly for durable export.'
      : 'Project-scoped preference inferred from semantic content.';
    confidence = hasAnyTag(tags, ['preference', 'workflow']) ? 0.88 : 0.8;
    signals = {
      tagged: hasAnyTag(tags, ['preference', 'workflow']),
      semantic: looksLikePreferenceStatement(content),
    };
  }

  return {
    shard_key: `projects/${projectSlug}`,
    category,
    transfer_reason: determineLifecycleReason(node, label, signals),
    confidence,
    why_durable: why,
    project_slug: projectSlug,
  };
}

function classifyGlobalNode(node) {
  const tags = node.tags;
  const retention = node.retentionStrength ?? 0;
  const content = node.content;

  const profileTagged = hasAnyTag(tags, ['profile', 'identity', 'persona']);
  const profileSemantic = looksLikeProfileStatement(content);
  if ((profileTagged || profileSemantic) && retention >= MIN_STRONG_SIGNAL_RETENTION) {
    return {
      shard_key: 'global/profile',
      category: 'profile',
      transfer_reason: determineLifecycleReason(node, 'profile', { tagged: profileTagged, semantic: profileSemantic }),
      confidence: profileTagged ? 0.9 : 0.78,
      why_durable: 'Profile/identity statement suitable for long-term durable memory.',
    };
  }

  const constraintTagged = hasAnyTag(tags, ['constraint', 'rule', 'policy', 'guardrail', 'verification']);
  const constraintSemantic = looksLikeConstraintStatement(content);
  if ((constraintTagged || constraintSemantic) && retention >= MIN_STRONG_SIGNAL_RETENTION) {
    return {
      shard_key: 'global/constraints',
      category: 'constraint',
      transfer_reason: determineLifecycleReason(node, 'constraint', { tagged: constraintTagged, semantic: constraintSemantic }),
      confidence: constraintTagged ? 0.91 : 0.79,
      why_durable: 'Constraint/rule statement belongs in global durable constraints.',
    };
  }

  const preferenceTagged = hasAnyTag(tags, ['preference', 'workflow', 'tools']);
  const preferenceSemantic = looksLikePreferenceStatement(content);
  if ((preferenceTagged || preferenceSemantic) && retention >= MIN_STRONG_SIGNAL_RETENTION) {
    return {
      shard_key: 'global/preferences',
      category: 'preference',
      transfer_reason: determineLifecycleReason(node, 'preference', { tagged: preferenceTagged, semantic: preferenceSemantic }),
      confidence: preferenceTagged ? 0.9 : 0.77,
      why_durable: 'Preference/workflow statement belongs in global durable preferences.',
    };
  }

  return null;
}

function classifyPersonalNode(node) {
  const tags = node.tags;
  const retention = node.retentionStrength ?? 0;
  if (retention < MIN_STRONG_SIGNAL_RETENTION) {
    return null;
  }

  if (hasAnyTag(tags, ['person', 'people', 'family', 'friend', 'contact', 'relationship'])) {
    return {
      shard_key: 'personal/people',
      category: 'person',
      transfer_reason: determineLifecycleReason(node, 'person', { tagged: true }),
      confidence: 0.88,
      why_durable: 'Personal relationship/person memory tagged explicitly for durable storage.',
    };
  }

  if (hasAnyTag(tags, ['routine', 'habit', 'schedule'])) {
    return {
      shard_key: 'personal/routines',
      category: 'routine',
      transfer_reason: determineLifecycleReason(node, 'routine', { tagged: true }),
      confidence: 0.88,
      why_durable: 'Routine/habit memory tagged explicitly for durable storage.',
    };
  }

  if (hasAnyTag(tags, ['event', 'milestone', 'travel', 'birthday'])) {
    const eventDate = node.validFrom && ISO_DATE_ONLY_PATTERN.test(node.validFrom.slice(0, 10)) ? node.validFrom.slice(0, 10) : undefined;
    return {
      shard_key: 'personal/notable-events',
      category: 'life_event',
      transfer_reason: determineLifecycleReason(node, 'event', { tagged: true }),
      confidence: 0.86,
      why_durable: 'Tagged personal event/milestone suitable for durable storage.',
      event_date: eventDate,
    };
  }

  return null;
}

export function classifyKnowledgeNode(rawNode, options = {}) {
  const node = normalizeKnowledgeNode(rawNode);
  if (!node.id || !node.content || node.content.length > MAX_STATEMENT_LENGTH) {
    return null;
  }

  const projectSlug = inferProjectSlug(node, options);
  const projectClassification = classifyProjectNode(node, projectSlug);
  const fallbackClassification = projectClassification || classifyGlobalNode(node) || classifyPersonalNode(node);
  if (!fallbackClassification) {
    return null;
  }

  const item = buildBaseItem(node, fallbackClassification);
  if (fallbackClassification.event_date) {
    item.event_date = fallbackClassification.event_date;
  }
  return item;
}

export async function readExportedKnowledgeNodes(exportPath) {
  const text = await fs.readFile(exportPath, 'utf8');
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  }

  return trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function adaptExportedNodes({ nodes = [], exportPath = null, generationId, generatedAt, projectSlug = null } = {}) {
  const seenIds = new Set();
  const seenStatements = new Set();
  const items = [];
  const skipped = [];

  for (const rawNode of nodes) {
    const classified = classifyKnowledgeNode(rawNode, { exportPath, projectSlug });
    const nodeId = compactWhitespace(rawNode?.id);
    if (!classified) {
      skipped.push({ id: nodeId || null, reason: 'not_durable_enough' });
      continue;
    }

    if (seenIds.has(classified.vestige_id)) {
      skipped.push({ id: classified.vestige_id, reason: 'duplicate_id' });
      continue;
    }

    const statementKey = `${classified.shard_key}::${normalizeText(classified.statement)}`;
    if (seenStatements.has(statementKey)) {
      skipped.push({ id: classified.vestige_id, reason: 'duplicate_statement' });
      continue;
    }

    seenIds.add(classified.vestige_id);
    seenStatements.add(statementKey);
    items.push(classified);
  }

  items.sort((left, right) => {
    const shard = left.shard_key.localeCompare(right.shard_key);
    if (shard !== 0) {
      return shard;
    }
    return left.vestige_id.localeCompare(right.vestige_id);
  });

  return {
    envelope: {
      generation_id: generationId,
      generated_at: generatedAt,
      items,
    },
    stats: {
      total_nodes: nodes.length,
      eligible_items: items.length,
      skipped_nodes: skipped.length,
    },
    skipped,
  };
}

export async function adaptExportFile({ exportPath, generationId, generatedAt } = {}) {
  const nodes = await readExportedKnowledgeNodes(exportPath);
  return adaptExportedNodes({ nodes, exportPath, generationId, generatedAt });
}
