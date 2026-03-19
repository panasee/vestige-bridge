import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_HEADERS = Object.freeze({
  accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  'content-type': 'application/json',
});

const JSONRPC_VERSION = '2.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_MCP_PATH = '/mcp';
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.local', 'share', 'core', 'auth_token');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRetriableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function normalizeFailureEnvelope({ operation, endpoint, status, error, data, retriable, rpcError }) {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : status
          ? `Request failed with status ${status}`
          : 'Request failed';

  return {
    ok: false,
    operation,
    endpoint,
    status: status ?? 0,
    error: message,
    retriable: typeof retriable === 'boolean' ? retriable : isRetriableStatus(status ?? 0),
    data: data ?? null,
    rpcError: rpcError ?? null,
  };
}

function compactWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function tryJsonParse(value) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function readResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  try {
    const text = await response.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function readAuthToken({ authToken, authTokenPath }) {
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }

  if (typeof process.env.VESTIGE_AUTH_TOKEN === 'string' && process.env.VESTIGE_AUTH_TOKEN.trim()) {
    return process.env.VESTIGE_AUTH_TOKEN.trim();
  }

  const resolvedPath = typeof authTokenPath === 'string' && authTokenPath.trim()
    ? authTokenPath.trim()
    : DEFAULT_TOKEN_PATH;

  try {
    const fileToken = await fs.readFile(resolvedPath, 'utf8');
    const trimmed = fileToken.trim();
    if (trimmed) {
      return trimmed;
    }
  } catch {
    return null;
  }

  return null;
}

function buildAuthHeaders(token) {
  if (!token) {
    return {};
  }
  return {
    authorization: `Bearer ${token}`,
  };
}

function normalizeSearchPayload(payload) {
  if (typeof payload === 'string') {
    return { query: payload };
  }

  const input = isPlainObject(payload) ? payload : {};
  const query = compactWhitespace(input.query || input.text || input.prompt || '');

  return {
    query,
    limit: input.limit ?? input.maxResults ?? 4,
    detail_level: input.detail_level || input.detailLevel || 'summary',
    token_budget: input.token_budget ?? input.tokenBudget ?? (typeof input.maxTokens === 'number' ? input.maxTokens * 4 : undefined),
    min_similarity: input.min_similarity ?? input.minSimilarity,
    min_retention: input.min_retention ?? input.minRetention,
    context_topics: Array.isArray(input.context_topics)
      ? input.context_topics
      : Array.isArray(input.contextTopics)
        ? input.contextTopics
        : undefined,
  };
}

function normalizeSmartIngestPayload(payload) {
  if (typeof payload === 'string') {
    return { content: payload };
  }

  const input = isPlainObject(payload) ? { ...payload } : {};

  if (Array.isArray(input.items)) {
    return {
      items: input.items,
      forceCreate: input.forceCreate ?? input.force_create,
    };
  }

  return {
    content: input.content || input.text || '',
    node_type: input.node_type || input.nodeType || 'note',
    tags: Array.isArray(input.tags) ? input.tags : undefined,
    source: input.source,
    forceCreate: input.forceCreate ?? input.force_create,
  };
}

function normalizeMemoryFeedbackPayload(payload, action) {
  const input = isPlainObject(payload) ? payload : {};
  return {
    action,
    id: input.id || input.memoryId || input.memory_id,
    reason: input.reason,
  };
}

function normalizeIntentionPayload(payload) {
  if (isPlainObject(payload)) {
    return payload;
  }
  if (typeof payload === 'string') {
    return { action: 'set', content: payload };
  }
  return {};
}

function normalizeConsolidatePayload() {
  return {};
}

function normalizeUnsupportedPayload(payload) {
  return isPlainObject(payload) ? payload : {};
}

function parseToolResult(result) {
  const callResult = result ?? {};
  const content = Array.isArray(callResult.content) ? callResult.content : [];
  const firstText = content.find((item) => typeof item?.text === 'string')?.text ?? '';
  const parsed = tryJsonParse(firstText);
  const isError = callResult.isError === true || callResult.is_error === true;

  if (isError) {
    const errorMessage =
      typeof parsed === 'string'
        ? parsed
        : parsed?.error || firstText || 'Tool call returned error';
    return {
      ok: false,
      data: parsed,
      error: errorMessage,
    };
  }

  return {
    ok: true,
    data: parsed,
    rawText: firstText,
  };
}

async function safeDeleteSession({ fetchImpl, endpoint, token, sessionId, logger }) {
  if (!sessionId) {
    return;
  }

  try {
    await fetchImpl(endpoint, {
      method: 'DELETE',
      headers: {
        ...DEFAULT_HEADERS,
        ...buildAuthHeaders(token),
        'mcp-session-id': sessionId,
      },
    });
    logger?.debug?.('vestige MCP session deleted', { sessionId });
  } catch {
    // best effort only
  }
}

export function createSidecarClient(options = {}) {
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl.trim().length > 0
    ? options.baseUrl.replace(/\/$/, '')
    : 'http://127.0.0.1:3928';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, Math.trunc(options.timeoutMs)) : 5000;
  const authToken = typeof options.authToken === 'string' ? options.authToken : null;
  const authTokenPath = typeof options.authTokenPath === 'string' ? options.authTokenPath : DEFAULT_TOKEN_PATH;
  const logger = options.logger;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Vestige Bridge requires a fetch implementation.');
  }

  const mcpEndpoint = new URL(DEFAULT_MCP_PATH, `${baseUrl}/`).toString();
  let nextId = 1;
  let sessionId = null;
  let resolvedAuthToken = null;
  let toolCache = null;
  let initialized = false;

  async function ensureAuthToken() {
    if (resolvedAuthToken) {
      return resolvedAuthToken;
    }

    resolvedAuthToken = await readAuthToken({ authToken, authTokenPath });
    return resolvedAuthToken;
  }

  async function sendJsonRpc(method, params, requestOptions = {}) {
    const token = await ensureAuthToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const notification = requestOptions.notification === true;
    const payload = {
      jsonrpc: JSONRPC_VERSION,
      id: notification ? undefined : nextId++,
      method,
      params,
    };

    try {
      const headers = {
        ...DEFAULT_HEADERS,
        ...buildAuthHeaders(token),
      };
      if (sessionId && method !== 'initialize') {
        headers['mcp-session-id'] = sessionId;
      }

      const response = await fetchImpl(mcpEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await readResponseBody(response);

      if (!response.ok) {
        return normalizeFailureEnvelope({
          operation: method,
          endpoint: mcpEndpoint,
          status: response.status,
          data,
        });
      }

      const headerSessionId = response.headers.get('mcp-session-id');
      if (headerSessionId) {
        sessionId = headerSessionId;
      }

      if (notification) {
        return {
          ok: true,
          operation: method,
          endpoint: mcpEndpoint,
          status: response.status,
          data,
        };
      }

      if (data?.error) {
        return normalizeFailureEnvelope({
          operation: method,
          endpoint: mcpEndpoint,
          status: response.status,
          error: data.error.message || 'JSON-RPC error',
          data,
          retriable: false,
          rpcError: data.error,
        });
      }

      return {
        ok: true,
        operation: method,
        endpoint: mcpEndpoint,
        status: response.status,
        data,
      };
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      return normalizeFailureEnvelope({
        operation: method,
        endpoint: mcpEndpoint,
        error: isAbort ? `Request timed out after ${timeoutMs}ms` : error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function initializeSession() {
    if (initialized && sessionId) {
      return { ok: true, sessionId };
    }

    const response = await sendJsonRpc('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'vestige-bridge',
        version: '0.1.0',
      },
    });

    if (!response.ok) {
      return response;
    }

    initialized = true;

    await sendJsonRpc('notifications/initialized', {}, { notification: true });

    return {
      ok: true,
      operation: 'initialize',
      endpoint: mcpEndpoint,
      status: response.status,
      sessionId,
      data: response.data?.result ?? response.data,
    };
  }

  async function listTools(force = false) {
    if (!force && Array.isArray(toolCache) && toolCache.length > 0) {
      return {
        ok: true,
        operation: 'tools/list',
        endpoint: mcpEndpoint,
        status: 200,
        data: { tools: toolCache },
      };
    }

    const init = await initializeSession();
    if (!init.ok) {
      return init;
    }

    const response = await sendJsonRpc('tools/list', {});
    if (!response.ok) {
      return response;
    }

    const tools = response.data?.result?.tools ?? [];
    toolCache = Array.isArray(tools) ? tools : [];

    return {
      ok: true,
      operation: 'tools/list',
      endpoint: mcpEndpoint,
      status: response.status,
      data: { tools: toolCache },
    };
  }

  async function callTool(toolName, argumentsPayload) {
    const init = await initializeSession();
    if (!init.ok) {
      return init;
    }

    const response = await sendJsonRpc('tools/call', {
      name: toolName,
      arguments: argumentsPayload ?? {},
    });

    if (!response.ok) {
      return response;
    }

    const parsed = parseToolResult(response.data?.result);
    if (!parsed.ok) {
      return normalizeFailureEnvelope({
        operation: `tools/call:${toolName}`,
        endpoint: mcpEndpoint,
        status: response.status,
        error: parsed.error,
        data: parsed.data,
        retriable: false,
      });
    }

    return {
      ok: true,
      operation: `tools/call:${toolName}`,
      endpoint: mcpEndpoint,
      status: response.status,
      data: parsed.data,
      rawText: parsed.rawText,
    };
  }

  async function callFirstSupported(operation, candidates, payload, normalizePayloadFn) {
    for (const candidate of candidates) {
      const response = await callTool(candidate, normalizePayloadFn(payload));
      if (response.ok) {
        return response;
      }

      const errorText = String(response.error || '');
      const unsupported = /unknown tool|method not found/i.test(errorText)
        || response.rpcError?.code === -32601
        || response.data?.error === 'Unknown tool';

      if (!unsupported) {
        return response;
      }
    }

    return normalizeFailureEnvelope({
      operation,
      endpoint: mcpEndpoint,
      status: 501,
      error: `${operation} is not supported by the current vestige-mcp server`,
      retriable: false,
    });
  }

  async function health() {
    const init = await initializeSession();
    if (!init.ok) {
      return init;
    }

    const tools = await listTools();
    if (!tools.ok) {
      return tools;
    }

    const ping = await sendJsonRpc('ping', {});
    return {
      ok: Boolean(ping.ok),
      operation: 'health',
      endpoint: mcpEndpoint,
      status: ping.status ?? 200,
      data: {
        sessionId,
        initialized: true,
        tools: tools.data.tools.map((tool) => tool.name),
        ping: ping.ok,
      },
      error: ping.ok ? null : ping.error,
      retriable: ping.ok ? false : ping.retriable,
    };
  }

  async function search(payload, requestOptions) {
    void requestOptions;
    return callFirstSupported('search', ['search'], payload, normalizeSearchPayload);
  }

  async function smartIngest(payload, requestOptions) {
    void requestOptions;
    return callFirstSupported('smartIngest', ['smart_ingest', 'ingest'], payload, normalizeSmartIngestPayload);
  }

  async function promoteMemory(payload, requestOptions) {
    void requestOptions;
    return callFirstSupported('promoteMemory', ['memory', 'promote_memory'], payload, (value) => normalizeMemoryFeedbackPayload(value, 'promote'));
  }

  async function demoteMemory(payload, requestOptions) {
    void requestOptions;
    return callFirstSupported('demoteMemory', ['memory', 'demote_memory'], payload, (value) => normalizeMemoryFeedbackPayload(value, 'demote'));
  }

  async function intention(payload, requestOptions) {
    void requestOptions;
    return callFirstSupported('intention', ['intention'], payload, normalizeIntentionPayload);
  }

  async function exportStable(payload, requestOptions) {
    void requestOptions;
    return callFirstSupported('exportStable', ['export_stable', 'exportStable'], payload, normalizeUnsupportedPayload);
  }

  async function consolidate(payload, requestOptions) {
    void requestOptions;
    return callFirstSupported('consolidate', ['consolidate'], payload, normalizeConsolidatePayload);
  }

  async function markMaterialized(payload, requestOptions) {
    void requestOptions;
    return callFirstSupported('markMaterialized', ['mark_materialized', 'markMaterialized'], payload, normalizeUnsupportedPayload);
  }

  async function close() {
    const token = await ensureAuthToken();
    await safeDeleteSession({
      fetchImpl,
      endpoint: mcpEndpoint,
      token,
      sessionId,
      logger,
    });
    sessionId = null;
    initialized = false;
    toolCache = null;
  }

  return {
    baseUrl,
    timeoutMs,
    authTokenPath,
    request(operation, payload) {
      switch (operation) {
        case 'health':
          return health(payload);
        case 'search':
          return search(payload);
        case 'smartIngest':
          return smartIngest(payload);
        case 'promoteMemory':
          return promoteMemory(payload);
        case 'demoteMemory':
          return demoteMemory(payload);
        case 'intention':
          return intention(payload);
        case 'exportStable':
          return exportStable(payload);
        case 'consolidate':
          return consolidate(payload);
        case 'markMaterialized':
          return markMaterialized(payload);
        default:
          return normalizeFailureEnvelope({
            operation,
            endpoint: mcpEndpoint,
            error: `Unknown sidecar operation: ${operation}`,
            retriable: false,
          });
      }
    },
    initializeSession,
    listTools,
    callTool,
    health,
    search,
    smartIngest,
    promoteMemory,
    demoteMemory,
    intention,
    exportStable,
    consolidate,
    markMaterialized,
    close,
  };
}

export class VestigeSidecarClient {
  constructor(options = {}) {
    this.client = createSidecarClient(options);
    this.baseUrl = this.client.baseUrl;
    this.timeoutMs = this.client.timeoutMs;
    this.authTokenPath = this.client.authTokenPath;
  }

  request(...args) {
    return this.client.request(...args);
  }

  initializeSession(...args) {
    return this.client.initializeSession(...args);
  }

  listTools(...args) {
    return this.client.listTools(...args);
  }

  callTool(...args) {
    return this.client.callTool(...args);
  }

  health(...args) {
    return this.client.health(...args);
  }

  search(...args) {
    return this.client.search(...args);
  }

  smartIngest(...args) {
    return this.client.smartIngest(...args);
  }

  promoteMemory(...args) {
    return this.client.promoteMemory(...args);
  }

  demoteMemory(...args) {
    return this.client.demoteMemory(...args);
  }

  intention(...args) {
    return this.client.intention(...args);
  }

  exportStable(...args) {
    return this.client.exportStable(...args);
  }

  consolidate(...args) {
    return this.client.consolidate(...args);
  }

  markMaterialized(...args) {
    return this.client.markMaterialized(...args);
  }

  close(...args) {
    return this.client.close(...args);
  }
}
