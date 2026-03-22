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
        const text = compactWhitespace(asMessageText(msg));
        
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
export async function buildAgentEndPayloadAsync({ messages = [], config = {}, ctx, logger }) {
    if (!messages || messages.length === 0) {
        return null;
    }

    const tailLimit = config?.ingest?.maxTailMessages || 6;
    const provider = config?.ingest?.provider || '';
    const gateModel = config?.ingest?.gateModel || 'gpt-4o-mini';
    const extractModel = config?.ingest?.extractModel || 'gpt-5.2';

    const transcript = formatRecentTranscript(messages, tailLimit);
    if (!transcript) {
        return null;
    }

    logger?.debug(`[vestige-bridge/ingest] Evaluating transcript for extraction (${tailLimit} msgs)`);

    // --- Step 1: Gate (Boolean Decision) ---
    const gateSystemPrompt = `You are a memory triage system.
Your job is to read the conversation and decide if it contains new durable memories.
Durable memories include:
- Explicit user preferences or dislikes
- Reusable rules, constraints, or decisions
- Important contextual facts about the user's life, work, or environment
- Corrections to your previous behavior

Ignore:
- Casual chatter
- Temporary context (e.g., "let's look at this file now")
- Tasks that are completed and have no future relevance

Reply ONLY with "TRUE" if there is durable memory to extract, or "FALSE" if there is nothing worth remembering.`;

    let gateResult = '';
    try {
        gateResult = await invokeLlm({
            provider,
            model: gateModel,
            system: gateSystemPrompt,
            messages: [{ role: 'user', content: transcript }],
            temperature: 0.0,
            maxTokens: 10,
            ctx,
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
Focus on:
1. User preferences and personal facts
2. Stable decisions, constraints, or working rules
3. Reusable technical lessons or corrections

Rules for extraction:
- Be concise, direct, and factual.
- Write from the perspective of the assistant remembering facts (e.g., "User prefers X", "Rule: Always do Y").
- Do NOT include conversational wrappers like "Here is what I extracted" or "I should remember that".
- Do NOT include temporary task context or code snippets unless they are a universal rule.
- If multiple separate facts are present, output them on separate lines.

If upon closer inspection there is actually no durable memory, return an empty string.`;

    let extractResult = '';
    try {
        extractResult = await invokeLlm({
            provider,
            model: extractModel,
            system: extractSystemPrompt,
            messages: [{ role: 'user', content: transcript }],
            temperature: 0.1,
            maxTokens: 500,
            ctx,
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

    logger?.debug(`[vestige-bridge/ingest] Extraction successful: ${finalContent.substring(0, 50)}...`);

    return {
        content: finalContent
    };
}
