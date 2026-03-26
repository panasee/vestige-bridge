/**
 * src/ingest.js
 * LCM-aware memory ingestion logic.
 * Step 1: Gate LLM decides if durable memory extraction is needed.
 * Step 2: Extraction LLM extracts durable memory items.
 */

import { invokeLlm } from './llm.js';

function compactWhitespace(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripInjectedBlocks(text) {
  return text
    .replace(/<vestige_recent>[\s\S]*?<\/vestige_recent>/gi, '')
    .replace(/<cognee_recall>[\s\S]*?<\/cognee_recall>/gi, '')
    .trim();
}

function messageRole(message) {
  return String(message?.role || message?.author || message?.type || 'message').toLowerCase();
}

function asMessageText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => asMessageText(item)).filter(Boolean).join(' ');
  }

  if (value && typeof value === 'object') {
    return [
      value.text,
      value.content,
      value.summary,
      value.body,
      value.message,
      value.value,
    ]
      .map((item) => asMessageText(item))
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function normalizeMessage(message) {
  const role = messageRole(message);
  const text = compactWhitespace(stripInjectedBlocks(asMessageText(message)));
  if (!text || role === 'system') return null;
  return {
    role: role === 'user' ? 'User' : 'Assistant',
    text,
  };
}

function normalizeSummary(summary) {
  const text = compactWhitespace(stripInjectedBlocks(asMessageText(summary)));
  if (!text) return null;
  const summaryId = typeof summary?.summaryId === 'string' ? summary.summaryId : null;
  const createdAt = typeof summary?.createdAt === 'string' ? summary.createdAt : null;
  return { summaryId, createdAt, text };
}

function renderRecentRawSection(messages = [], tailLimit = 12) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  const normalized = messages
    .map(normalizeMessage)
    .filter(Boolean)
    .slice(-Math.abs(tailLimit));

  if (normalized.length === 0) {
    return '';
  }

  return normalized.map((msg) => `${msg.role}: ${msg.text}`).join('\n\n');
}

function renderRecentSummarySection(summaries = [], summaryLimit = 8) {
  if (!Array.isArray(summaries) || summaries.length === 0) {
    return '';
  }

  const normalized = summaries
    .map(normalizeSummary)
    .filter(Boolean)
    .slice(-Math.abs(summaryLimit));

  if (normalized.length === 0) {
    return '';
  }

  return normalized
    .map((summary, index) => {
      const meta = [summary.summaryId, summary.createdAt].filter(Boolean).join(' | ');
      const prefix = meta ? `- [${meta}]` : `- [summary ${index + 1}]`;
      return `${prefix} ${summary.text}`;
    })
    .join('\n');
}

function buildEvaluationContext({ messages = [], summaries = [], trigger = {}, config = {} }) {
  const tailLimit = config?.ingest?.maxTailMessages || 12;
  const summaryLimit = config?.ingest?.maxSummaryItems || 8;
  const rawSection = renderRecentRawSection(messages, tailLimit);
  const summarySection = renderRecentSummarySection(summaries, summaryLimit);

  if (!rawSection && !summarySection) {
    return '';
  }

  const sections = [];
  const triggerKind = trigger?.kind || 'unknown';
  const triggerAt = trigger?.at || null;
  const summaryAdvanced = trigger?.summaryAdvanced;
  const newMessages = trigger?.newMessages;

  sections.push('Trigger Context:');
  sections.push(`- kind: ${triggerKind}`);
  if (triggerAt) sections.push(`- at: ${triggerAt}`);
  if (typeof summaryAdvanced === 'boolean') sections.push(`- summary_advanced: ${summaryAdvanced}`);
  if (typeof newMessages === 'number') sections.push(`- new_messages_since_watermark: ${newMessages}`);

  if (rawSection) {
    sections.push('');
    sections.push('Recent Raw Conversation:');
    sections.push(rawSection);
  }

  if (summarySection) {
    sections.push('');
    sections.push('Recent LCM Summaries:');
    sections.push(summarySection);
  }

  return sections.join('\n');
}

export async function buildAgentEndPayloadAsync({ messages = [], summaries = [], trigger = {}, config = {}, ctx, logger, runtime }) {
  const gateModel = config?.ingest?.gateModel || '';
  const extractModel = config?.ingest?.extractModel || '';
  const agentId = ctx?.agentId || '';

  const evaluationContext = buildEvaluationContext({ messages, summaries, trigger, config });
  if (!evaluationContext) {
    return null;
  }

  logger?.info('[vestige-bridge/ingest] Evaluating LCM-aware memory context', {
    triggerKind: trigger?.kind || 'unknown',
    rawMessages: Array.isArray(messages) ? messages.length : 0,
    summaries: Array.isArray(summaries) ? summaries.length : 0,
  });

  const gateSystemPrompt = `You are a long-term memory gate for an assistant.
Your job is to decide whether the provided context contains durable memories worth storing.

Durable memories include:
- Explicit remember requests
- Stable user preferences or dislikes
- Hard rules, constraints, and non-negotiables
- Important persistent project facts or ongoing project momentum
- Verified root causes or reusable fix patterns
- Stable life/work/environment facts
- Explicit corrections to previous remembered behavior

Do NOT open the gate for:
- Ephemeral debugging chatter
- Transient intermediate hypotheses
- One-off task steps with no reuse value
- Repetition of already-obvious short-lived context

The input may contain both recent raw conversation and recent LCM summaries.
Use both. Summaries may carry cross-turn distilled context; raw conversation may contain newer facts not yet summarized.

Reply ONLY with "TRUE" if there is at least one durable memory worth extracting, or "FALSE" otherwise.`;

  let gateResult = '';
  try {
    gateResult = await invokeLlm({
      model: gateModel,
      system: gateSystemPrompt,
      messages: [{ role: 'user', content: evaluationContext }],
      temperature: 0.1,
      maxTokens: 10,
      agentId,
      runtime,
      logger,
    });
  } catch (error) {
    logger?.warn(`[vestige-bridge/ingest] Gate LLM failed: ${error.message}`);
    return null;
  }

  const shouldExtract = gateResult.trim().toUpperCase() === 'TRUE';
  if (!shouldExtract) {
    logger?.info('[vestige-bridge/ingest] Gate closed (FALSE), skipping extraction.');
    return null;
  }

  const extractSystemPrompt = `You are a cognitive memory extractor for an assistant.
Analyze the provided context and extract only durable, reusable memories.

The input may include:
- Recent raw conversation
- Recent LCM summaries
- Trigger metadata

Use the summaries for cross-turn context and the raw conversation for newer unsummarized facts.
Prefer stable, verified takeaways over intermediate chatter.
If raw conversation and summaries conflict, prefer the more recent explicit correction in the raw conversation; otherwise prefer the more stable summarized fact.
Do not duplicate the same idea in multiple phrasings.

Output format: one fact per line. Prefix each line with a category tag when applicable:
  [project]    - active project context or durable work momentum
  [constraint] - hard rules, must-do/never-do constraints, non-negotiables
  [preference] - user likes, dislikes, or style preferences
  [life]       - personal facts, routines, relationships, life events
  (no prefix)  - other durable facts that do not fit the above

Rules:
- Be concise, direct, and factual.
- Write from the assistant's remembering perspective.
- Extract only facts worth retaining beyond the current session.
- Do NOT include temporary task steps, transient debugging noise, stack traces, file paths, or code snippets unless they encode a reusable long-term rule or stable environment fact.
- Do NOT wrap the output with prose or explanations.`;

  let extractResult = '';
  try {
    extractResult = await invokeLlm({
      model: extractModel,
      system: extractSystemPrompt,
      messages: [{ role: 'user', content: evaluationContext }],
      temperature: 0.2,
      maxTokens: 700,
      agentId,
      runtime,
      logger,
    });
  } catch (error) {
    logger?.warn(`[vestige-bridge/ingest] Extract LLM failed: ${error.message}`);
    return null;
  }

  const finalContent = extractResult.trim();
  if (!finalContent) {
    logger?.info('[vestige-bridge/ingest] Extractor returned empty content.');
    return null;
  }

  const items = parseExtractedLines(finalContent);
  if (items.length === 0) {
    logger?.info('[vestige-bridge/ingest] Extractor produced no parseable items.');
    return null;
  }

  logger?.info('[vestige-bridge/ingest] Extraction successful', {
    items: items.length,
    triggerKind: trigger?.kind || 'unknown',
  });

  return { items, evaluationContext };
}

const CATEGORY_PREFIX_RE = /^\[([a-z]+)\]\s+/i;

function parseExtractedLines(text) {
  const items = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(CATEGORY_PREFIX_RE);
    if (match) {
      const category = match[1].toLowerCase();
      const content = line.slice(match[0].length).trim();
      if (content) {
        items.push({ content, category });
      }
    } else {
      items.push({ content: line, category: null });
    }
  }
  return items;
}
