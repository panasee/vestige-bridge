/**
 * src/ingest.js
 * LCM-aware memory ingestion logic.
 * Step 1: Gate LLM decides if durable memory extraction is needed.
 * Step 2: Extraction LLM extracts durable memory items.
 */

import { invokeLlm } from './llm.js';
import { normalizeEntries } from './normalize.js';
import { renderVestigeBullet } from './render.js';

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

function takeBoundedLines(lines, maxChars) {
  const bounded = [];
  let total = 0;
  for (const line of lines) {
    const next = String(line || '').trim();
    if (!next) continue;
    const size = next.length + 1;
    if (bounded.length > 0 && total + size > maxChars) {
      break;
    }
    bounded.push(next);
    total += size;
  }
  return bounded;
}

export function buildExistingMemorySynopsisSection(existingMemories = [], config = {}) {
  if (!config?.ingest?.includeExistingMemorySynopsis || !Array.isArray(existingMemories) || existingMemories.length === 0) {
    return '';
  }

  const maxItems = Number.isInteger(config?.ingest?.existingMemoryMaxItems) ? config.ingest.existingMemoryMaxItems : 3;
  const maxChars = Number.isInteger(config?.ingest?.existingMemoryMaxChars) ? config.ingest.existingMemoryMaxChars : 700;

  const normalized = normalizeEntries(existingMemories, {
    defaultSource: 'vestige',
    defaultLayer: 'recent',
  }).slice(0, Math.max(1, maxItems));

  const lines = takeBoundedLines(
    normalized.map((entry) => renderVestigeBullet(entry, { enabled: false })),
    Math.max(100, maxChars),
  );

  if (lines.length === 0) {
    return '';
  }

  return ['Existing Related Memory Synopsis:', ...lines].join('\n');
}

export function buildEvaluationContext({ messages = [], summaries = [], existingMemories = [], trigger = {}, config = {} }) {
  const tailLimit = config?.ingest?.maxTailMessages || 12;
  const summaryLimit = config?.ingest?.maxSummaryItems || 8;
  const rawSection = renderRecentRawSection(messages, tailLimit);
  const summarySection = renderRecentSummarySection(summaries, summaryLimit);
  const existingMemorySection = buildExistingMemorySynopsisSection(existingMemories, config);

  if (!rawSection && !summarySection && !existingMemorySection) {
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

  if (existingMemorySection) {
    sections.push('');
    sections.push(existingMemorySection);
  }

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

export async function buildAgentEndPayloadAsync({ messages = [], summaries = [], existingMemories = [], trigger = {}, config = {}, ctx, logger, runtime }) {
  const gateModel = config?.ingest?.gateModel || '';
  const extractModel = config?.ingest?.extractModel || '';
  const maxItems = Number.isInteger(config?.ingest?.maxItems) ? config.ingest.maxItems : 5;
  const agentId = ctx?.agentId || '';

  const evaluationContext = buildEvaluationContext({ messages, summaries, existingMemories, trigger, config });
  if (!evaluationContext) {
    return null;
  }

  logger?.info('[vestige-bridge/ingest] Evaluating LCM-aware memory context', {
    triggerKind: trigger?.kind || 'unknown',
    rawMessages: Array.isArray(messages) ? messages.length : 0,
    summaries: Array.isArray(summaries) ? summaries.length : 0,
    existingMemories: Array.isArray(existingMemories) ? existingMemories.length : 0,
  });

  const gateSystemPrompt = `You are a memory gate for Vestige, a cognitive memory system for an assistant.
Your job is to decide whether the provided context contains memories worth storing in Vestige.

Open the gate for information that is likely to be useful in future sessions, even if it may later evolve, be superseded, or naturally decay, as long as it provides reusable cognitive value for the near-to-medium term.

Memories worth storing in Vestige include:
- Explicit remember requests
- Stable user preferences or dislikes
- Hard rules, constraints, and non-negotiables
- Important persistent project facts or long-lived project direction
- Verified root causes or reusable fix patterns
- Stable life/work/environment facts
- Explicit corrections to previous remembered behavior
- Durable architectural decisions or rejected fallback paths that will matter again later
- Current project structure facts that are likely to remain useful for ongoing work
- Current responsibility mappings, such as which file/module/plugin currently owns a function
- Operational location facts, such as where a class of files, notes, configs, or artifacts is currently stored
- Mid-term working facts that may evolve later but are still likely to help future understanding, navigation, debugging, or decision-making until superseded

Use a usefulness-and-reusability rubric, not a hard blacklist.
Implementation details may justify opening the gate when they support a reusable rule, correction, constraint, project-level takeaway, or a stable-for-now working fact that will likely matter again.
Vestige is broader than a permanent library: it may store medium-horizon working memories, not only permanent truths.

Usually keep the gate CLOSED for:
- Ephemeral debugging chatter with no likely future reuse
- Transient intermediate hypotheses that are not yet verified
- One-off task steps with no reuse value
- Repetition of already-obvious short-lived context
- Pure changelog-style implementation updates with no reusable takeaway
- Test additions, test assertions, or file-by-file edit summaries that do not change future understanding
- Temporary current-state / next-step planning notes that will likely expire immediately
- Raw file paths, command output, stack traces, and code snippets that do not imply a reusable rule or useful working fact

If the context mostly contains implementation churn, testing details, file paths, code snippets, command output, or temporary progress updates, keep the gate CLOSED unless they clearly imply a reusable long-term rule or a medium-horizon working fact that is likely to matter again.
Store process-level facts only when they are likely to help future understanding, navigation, debugging, or decision-making beyond the current moment. Do not store mere transient execution traces or one-off progress chatter.
When uncertain, prefer FALSE.

The input may contain both recent raw conversation and recent LCM summaries.
It may also contain a short synopsis of already-known related memories.
Use that synopsis to avoid opening the gate for mere restatements of what is already remembered.

Reply ONLY with "TRUE" if there is at least one memory worth extracting into Vestige, or "FALSE" otherwise.`;

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
- A short synopsis of already-known related memories

Use the summaries for cross-turn context and the raw conversation for newer unsummarized facts.
Prefer stable, verified takeaways over intermediate chatter.
If raw conversation and summaries conflict, prefer the more recent explicit correction in the raw conversation; otherwise prefer the more stable summarized fact.
Do not duplicate the same idea in multiple phrasings.

Your goal is to produce memory statements that remain useful when read alone in a future session.
Rewrite implementation-specific observations into higher-level durable takeaways when possible.
If a candidate memory cannot be rewritten into a standalone long-lived takeaway, omit it.
Summarize into no more than ${maxItems} memory items total.
If there are more than ${maxItems} plausible candidates, keep only the highest-value, most reusable, and most important ones, and omit the lower-priority items.
Prefer fewer, stronger memories over a comprehensive list.

Durability rubric:
- Prefer stable preferences, constraints, verified root causes, reusable fixes, durable project direction, and explicit user corrections.
- Usually skip temporary task state, step-by-step progress, implementation churn, command chatter, stack traces, test details, file-by-file edit notes, and raw code/config/path details.
- Exception: if low-level details clearly support a reusable long-term rule, abstract that rule and store the abstraction instead of the raw detail.

Existing-memory handling:
- If the provided synopsis already covers the same idea, prefer to OMIT a duplicate restatement.
- If the new context sharpens or corrects an existing memory, emit only the refined/corrected durable takeaway.
- Prefer refine / correct / skip over parallel near-duplicate notes.

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
- Prefer mechanism-level abstractions over implementation surface details.
- Remove file paths, test names, command lines, stack traces, code snippets, and changelog-style wording unless they are strictly necessary to preserve a durable rule.
- Do NOT include temporary task steps, current progress notes, next-step plans, transient debugging noise, or one-off execution results.
- Do NOT emit wrapper text, explanations, bullet numbering, or duplicate phrasings.
- When uncertain, omit the item rather than storing a low-value memory.

Good output style:
- [constraint] Recent suppress must rely only on crystallizer success state.
- [project] Durable materialization belongs to memory-crystallizer rather than vestige-bridge.

Bad output style:
- Updated src/provider.js to ...
- Added test xyz to verify ...
- Current active task is ...`;

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
