/**
 * src/ingest.js
 * Implements the two-step LLM-based memory ingestion logic.
 * Step 1: Gate LLM decides if memory extraction is needed.
 * Step 2: Extraction LLM extracts the memory content.
 */

import { invokeLlm } from './llm.js';

function compactWhitespace(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip orchestrator-injected recall blocks from message text before feeding to LLMs.
 * These blocks contain previously recalled memories and checkpoint wrappers that,
 * if left in, cause the extract LLM to re-ingest old memories (positive feedback loop).
 */
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

/**
 * Format recent messages into a text transcript.
 */
function formatRecentTranscript(messages = [], tailLimit = 6) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return '';
    }
    
    const tailMessages = messages.slice(-Math.abs(tailLimit));
    const lines = [];
    
    for (const msg of tailMessages) {
        const role = messageRole(msg);
        const text = compactWhitespace(stripInjectedBlocks(asMessageText(msg)));

        // Skip empty or system messages
        if (!text || role === 'system') continue;
        
        // Normalise roles for the LLM
        const displayRole = role === 'user' ? 'User' : 'Assistant';
        lines.push(`${displayRole}: ${text}`);
    }
    
    return lines.join('\n\n');
}

/**
 * Two-step memory extraction process.
 */
export async function buildAgentEndPayloadAsync({ messages = [], config = {}, ctx, logger, runtime }) {
    if (!messages || messages.length === 0) {
        return null;
    }

    const tailLimit = config?.ingest?.maxTailMessages || 6;
    const gateModel = config?.ingest?.gateModel || '';
    const extractModel = config?.ingest?.extractModel || '';
    const agentId = ctx?.agentId || '';

    const transcript = formatRecentTranscript(messages, tailLimit);
    if (!transcript) {
        return null;
    }

    logger?.debug(`[vestige-bridge/ingest] Evaluating transcript for extraction (${tailLimit} msgs)`);

    // --- Step 1: Gate (Boolean Decision) ---
    const gateSystemPrompt = `You are a memory triage system.
Your job is to read the conversation and decide if it contains new memories.
Memories include:
- User ask explicitly to remember
- Explicit user preferences or dislikes
- Reusable rules, constraints, or decisions
- Important contextual facts about the user's life, work, or environment
- Corrections to your previous behavior

Ignore:
- Casual chatter
- Temporary context (e.g., "let's look at this file now")

Reply ONLY with "TRUE" if there is durable memory to extract, or "FALSE" if there is nothing worth remembering.`;

    let gateResult = '';
    try {
        gateResult = await invokeLlm({
            model: gateModel,
            system: gateSystemPrompt,
            messages: [{ role: 'user', content: transcript }],
            temperature: 0.1,
            maxTokens: 10,
            agentId,
            runtime,
            logger
        });
    } catch (error) {
        logger?.warn(`[vestige-bridge/ingest] Gate LLM failed: ${error.message}`);
        return null; // Fail soft: skip memory ingest on gate failure
    }

    const shouldExtract = gateResult.trim().toUpperCase() === 'TRUE';
    if (!shouldExtract) {
        logger?.debug(`[vestige-bridge/ingest] Gate closed (FALSE), skipping extraction.`);
        return null;
    }

    logger?.debug(`[vestige-bridge/ingest] Gate open (TRUE), proceeding to extraction.`);

    // --- Step 2: Extraction ---
    const extractSystemPrompt = `You are a cognitive memory extractor.
Analyze the following conversation and extract durable, reusable memories.

Output format: one fact per line. Prefix each line with a category tag:
  [project]    - active project context or work-specific momentum
  [constraint] - hard rules, must-do/never-do constraints, non-negotiables
  [preference] - user likes, dislikes, or style preferences
  [life]       - personal facts, routines, relationships, life events
  (no prefix)  - other durable facts that don't fit the above

Examples:
  [constraint] Never mock the database in integration tests
  [preference] User prefers concise responses without trailing summaries
  [project] Working on vestige-bridge memory bucketing system
  [life] User is based in UTC+8 timezone
  User has ten years of Go experience

Rules:
- Be concise, direct, and factual.
- Write from the perspective of the assistant remembering facts (e.g., "User prefers X", "Rule: Always do Y").
- Do NOT include conversational wrappers like "Here is what I extracted" or "I should remember that".
- Do NOT include temporary task context or code snippets unless they encode a universal rule.`;

    let extractResult = '';
    try {
        extractResult = await invokeLlm({
            model: extractModel,
            system: extractSystemPrompt,
            messages: [{ role: 'user', content: transcript }],
            temperature: 0.2,
            maxTokens: 500,
            agentId,
            runtime,
            logger
        });
    } catch (error) {
        logger?.warn(`[vestige-bridge/ingest] Extract LLM failed: ${error.message}`);
        return null; // Fail soft
    }

    const finalContent = extractResult.trim();
    if (!finalContent) {
        logger?.debug(`[vestige-bridge/ingest] Extractor returned empty content.`);
        return null;
    }

    const items = parseExtractedLines(finalContent);
    if (items.length === 0) {
        logger?.debug(`[vestige-bridge/ingest] Extractor produced no parseable items.`);
        return null;
    }

    logger?.debug(`[vestige-bridge/ingest] Extraction successful: ${items.length} item(s).`);

    return { items };
}

const CATEGORY_PREFIX_RE = /^\[([a-z]+)\]\s+/i;

/**
 * Parse extractor output lines into { content, category } items.
 * Lines with a [category] prefix have that prefix stripped from the content.
 */
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
