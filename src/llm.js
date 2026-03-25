/**
 * src/llm.js
 * Encapsulates LLM invocation by using OpenClaw's plugin runtime task queue when available,
 * or falling back to a direct pi-ai import.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

function resolveOpenClawHome() {
  return process.env.OPENCLAW_HOME || join(homedir(), '.openclaw');
}

async function resolveCustomModel(agentId, provider, modelId) {
  const openclawHome = resolveOpenClawHome();
  const candidates = [
    join(openclawHome, 'agents', String(agentId || 'main'), 'agent', 'models.json'),
    join(openclawHome, 'agents', 'main', 'agent', 'models.json'),
  ];

  for (const filePath of candidates) {
    let catalog;
    try {
      catalog = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      continue;
    }

    const providerConfig = catalog?.providers?.[provider];
    if (!providerConfig) continue;

    const modelEntry = (providerConfig.models || []).find(m => m.id === modelId);
    if (!modelEntry) continue;

    return {
      descriptor: {
        id: modelEntry.id,
        name: modelEntry.name || modelEntry.id,
        provider,
        api: modelEntry.api || providerConfig.api || 'openai-completions',
        baseUrl: providerConfig.baseUrl || '',
        reasoning: modelEntry.reasoning ?? false,
        input: modelEntry.input ?? ['text'],
        cost: modelEntry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: modelEntry.contextWindow,
        maxTokens: modelEntry.maxTokens,
      },
      apiKey: providerConfig.apiKey || '',
    };
  }

  return null;
}

async function resolveOpenAICodexOAuthToken(agentId) {
  const openclawHome = resolveOpenClawHome();
  const candidates = [
    join(openclawHome, 'agents', String(agentId || 'main'), 'agent', 'auth-profiles.json'),
    join(openclawHome, 'agents', 'main', 'agent', 'auth-profiles.json'),
  ];

  for (const filePath of candidates) {
    let store;
    try {
      store = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      continue;
    }
    const profiles = store?.profiles;
    if (!profiles || typeof profiles !== 'object') continue;

    const preferredId = typeof store?.lastGood?.['openai-codex'] === 'string'
      ? store.lastGood['openai-codex'] : null;

    const resolve = (profile) => {
      if (!profile) return null;
      if ((profile.type === 'oauth' || profile.type === 'token') && typeof profile.access === 'string' && profile.access.trim()) {
        return profile.access.trim();
      }
      if (profile.type === 'token' && typeof profile.token === 'string' && profile.token.trim()) {
        return profile.token.trim();
      }
      return null;
    };

    if (preferredId && profiles[preferredId]) {
      const token = resolve(profiles[preferredId]);
      if (token) return token;
    }

    const entries = Object.values(profiles)
      .map(resolve)
      .filter(Boolean);
    if (entries.length > 0) return entries[0];
  }

  return null;
}

export async function invokeLlm({
  provider = '',
  model = '',
  system = '',
  messages = [],
  temperature = 0.1,
  maxTokens = 500,
  agentId = '',
  runtime,
  logger,
}) {
  try {
    let resolvedProvider = provider;
    let resolvedModel = model;
    
    // If provider is empty and model contains '/', split it
    if (!resolvedProvider && resolvedModel.includes('/')) {
        const parts = resolvedModel.split('/');
        resolvedProvider = parts[0];
        resolvedModel = parts.slice(1).join('/');
    }

    const fullModelRef = resolvedProvider ? `${resolvedProvider}/${resolvedModel}` : resolvedModel;
    logger?.debug(`[vestige-bridge/llm] Requesting LLM for ${fullModelRef}...`);

    // Build the full message list
    const fullMessages = messages.map(m => ({
        ...m,
        timestamp: m.timestamp || Date.now()
    }));

    // Attempt to dynamically load pi-ai locally
    let piAi;
    try {
        piAi = await import('@mariozechner/pi-ai');
    } catch (e) {
        try {
            piAi = await import('/home/dongkai-claw/.npm-global/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js');
        } catch (innerErr) {
            // Ignore, we will rely on another fallback if needed, but in standard
            // openclaw installations, it should be available.
            throw new Error(`Failed to load pi-ai dependency: ${innerErr.message}`);
        }
    }

    if (!piAi || !piAi.getModel || !piAi.completeSimple) {
        throw new Error('Failed to load @mariozechner/pi-ai functions');
    }

    // 1. Try pi-ai built-in registry first
    let targetModel = piAi.getModel(resolvedProvider, resolvedModel);
    let customApiKey = '';

    // 2. Fallback: load from openclaw's models.json (custom providers)
    if (!targetModel) {
      const custom = await resolveCustomModel(agentId, resolvedProvider, resolvedModel);
      if (!custom) {
        throw new Error(`Model ${fullModelRef} not found in registry`);
      }
      targetModel = custom.descriptor;
      customApiKey = custom.apiKey;
    }

    // Get API Key: custom models.json key → runtime modelAuth → env var → OAuth (openai-codex)
    let apiKey = customApiKey;

    if (!apiKey && runtime?.modelAuth?.getApiKeyForModel) {
        const auth = await runtime.modelAuth.getApiKeyForModel({ model: targetModel });
        apiKey = auth?.apiKey ?? '';
    }

    if (!apiKey && piAi.getEnvApiKey) {
        apiKey = piAi.getEnvApiKey(resolvedProvider) ?? '';
    }

    if (!apiKey && resolvedProvider === 'openai-codex') {
        apiKey = await resolveOpenAICodexOAuthToken(agentId) ?? '';
    }

    if (!apiKey) {
      throw new Error(`No API key found for ${fullModelRef}`);
    }

    // Call completeSimple directly
    // Pass system prompt via systemPrompt in context (used as `instructions` for openai-codex-responses API)
    const response = await piAi.completeSimple(
      targetModel,
      { messages: fullMessages, ...(system ? { systemPrompt: system } : {}) },
      {
        apiKey,
        // Reasoning models (e.g. openai-codex-responses) reject temperature parameter
        ...(targetModel.reasoning ? {} : { temperature }),
        maxTokens,
      }
    );

    // Extract raw text
    let textOutput = '';
    if (Array.isArray(response.content)) {
      textOutput = response.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    } else if (typeof response.content === 'string') {
      textOutput = response.content;
    }

    return textOutput;
  } catch (error) {
    logger?.error(`[vestige-bridge/llm] LLM invocation failed: ${error.message}`);
    throw error;
  }
}
