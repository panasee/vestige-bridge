/**
 * src/llm.js
 * Encapsulates LLM invocation by dynamically importing OpenClaw core dependencies.
 */

export async function invokeLlm({
  provider = '',
  model = '',
  system = '',
  messages = [],
  temperature = 0.1,
  maxTokens = 500,
  ctx,
  logger,
}) {
  try {
    // Dynamically import OpenClaw core SDK
    const piAi = await import('@mariozechner/pi-ai');
    const getModel = piAi.getModel;
    const completeSimple = piAi.completeSimple;

    if (!getModel || !completeSimple) {
      throw new Error('Failed to load @mariozechner/pi-ai functions');
    }

    // provider can be empty string if model string contains provider prefix like "openai/gpt-4o-mini"
    // but pi-ai's getModel expects provider and model names as arguments
    
    // Resolve model string
    let resolvedProvider = provider;
    let resolvedModel = model;
    
    // If provider is empty and model contains '/', split it
    if (!resolvedProvider && resolvedModel.includes('/')) {
        const parts = resolvedModel.split('/');
        resolvedProvider = parts[0];
        resolvedModel = parts.slice(1).join('/');
    }
    
    // If still no provider, we can't reliably call getModel
    if (!resolvedProvider) {
        throw new Error(`Cannot resolve provider for model ${model}`);
    }

    const targetModel = getModel(resolvedProvider, resolvedModel);
    if (!targetModel) {
      throw new Error(`Model ${resolvedProvider}/${resolvedModel} not found in registry`);
    }

    // Get API Key from OpenClaw runtime context
    let apiKey = '';
    if (ctx?.runtime?.modelAuth) {
       // @ts-ignore - duck typing based on standard OpenClaw ctx
       apiKey = await ctx.runtime.modelAuth.getApiKey(resolvedProvider, resolvedModel);
    }
    
    // Fallback: Check environment variable if not found in ctx
    if (!apiKey) {
        // Simple fallback guessing based on provider name
        const envKeyName = `${resolvedProvider.toUpperCase()}_API_KEY`;
        apiKey = process.env[envKeyName] || process.env.OPENAI_API_KEY || ''; 
    }

    if (!apiKey) {
      throw new Error(`No API key found for ${resolvedProvider}/${resolvedModel}`);
    }

    // Build the full message list
    const fullMessages = [];
    if (system) {
        fullMessages.push({
            role: 'system',
            content: system,
            timestamp: Date.now()
        });
    }

    fullMessages.push(...messages.map(m => ({
        ...m,
        timestamp: m.timestamp || Date.now()
    })));

    logger?.debug(`[vestige-bridge/llm] Invoking ${resolvedProvider}/${resolvedModel}...`);

    // Call completeSimple
    const response = await completeSimple(
      targetModel,
      { messages: fullMessages },
      {
        apiKey,
        temperature,
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
