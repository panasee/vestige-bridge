const DEFAULT_HEADERS = Object.freeze({
  accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
  'content-type': 'application/json',
});

export const ENDPOINT_CANDIDATES = Object.freeze({
  health: [
    { method: 'GET', path: '/vestige/health' },
    { method: 'GET', path: '/health' },
  ],
  search: [
    { method: 'POST', path: '/vestige/search' },
    { method: 'POST', path: '/search' },
  ],
  smartIngest: [
    { method: 'POST', path: '/vestige/smart-ingest' },
    { method: 'POST', path: '/vestige/smart_ingest' },
    { method: 'POST', path: '/smart-ingest' },
    { method: 'POST', path: '/smart_ingest' },
  ],
  promoteMemory: [
    { method: 'POST', path: '/vestige/promote-memory' },
    { method: 'POST', path: '/vestige/promote_memory' },
    { method: 'POST', path: '/promote-memory' },
    { method: 'POST', path: '/promote_memory' },
  ],
  demoteMemory: [
    { method: 'POST', path: '/vestige/demote-memory' },
    { method: 'POST', path: '/vestige/demote_memory' },
    { method: 'POST', path: '/demote-memory' },
    { method: 'POST', path: '/demote_memory' },
  ],
  intention: [
    { method: 'POST', path: '/vestige/intention' },
    { method: 'POST', path: '/intention' },
  ],
  exportStable: [
    { method: 'POST', path: '/vestige/export-stable' },
    { method: 'POST', path: '/vestige/export_stable' },
    { method: 'POST', path: '/export-stable' },
    { method: 'POST', path: '/export_stable' },
  ],
  consolidate: [
    { method: 'POST', path: '/vestige/consolidate' },
    { method: 'POST', path: '/consolidate' },
  ],
  markMaterialized: [
    { method: 'POST', path: '/vestige/mark-materialized' },
    { method: 'POST', path: '/vestige/mark_materialized' },
    { method: 'POST', path: '/mark-materialized' },
    { method: 'POST', path: '/mark_materialized' },
  ],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePayload(operation, payload) {
  if (payload === undefined || payload === null) {
    return undefined;
  }
  if (typeof payload === 'string') {
    if (operation === 'search') {
      return { query: payload };
    }
    return { text: payload };
  }
  if (isPlainObject(payload)) {
    return payload;
  }
  return { value: payload };
}

function isRetriableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function shouldTryNextCandidate(status, index, candidatesLength) {
  return (status === 404 || status === 405) && index < candidatesLength - 1;
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

function normalizeFailureEnvelope({ operation, endpoint, status, error, data }) {
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
    retriable: isRetriableStatus(status ?? 0),
    data: data ?? null,
  };
}

export function createSidecarClient(options = {}) {
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl.trim().length > 0
    ? options.baseUrl.replace(/\/$/, '')
    : 'http://127.0.0.1:8765';
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, Math.trunc(options.timeoutMs)) : 5000;
  const logger = options.logger;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Vestige Bridge requires a fetch implementation.');
  }

  async function request(operation, payload, requestOptions = {}) {
    const candidates = ENDPOINT_CANDIDATES[operation];
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return normalizeFailureEnvelope({ operation, endpoint: '', error: `Unknown sidecar operation: ${operation}` });
    }

    const normalizedPayload = normalizePayload(operation, payload);

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const endpoint = new URL(candidate.path, `${baseUrl}/`).toString();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const method = requestOptions.method ?? candidate.method;
        const headers = {
          ...DEFAULT_HEADERS,
          ...(requestOptions.headers && isPlainObject(requestOptions.headers) ? requestOptions.headers : {}),
        };
        const canHaveBody = method !== 'GET' && method !== 'HEAD';
        const response = await fetchImpl(endpoint, {
          method,
          headers,
          body: canHaveBody && normalizedPayload !== undefined ? JSON.stringify(normalizedPayload) : undefined,
          signal: controller.signal,
        });
        const data = await readResponseBody(response);

        if (response.ok) {
          logger?.debug?.('sidecar request succeeded', { operation, endpoint, status: response.status });
          return { ok: true, operation, endpoint, status: response.status, data };
        }

        if (shouldTryNextCandidate(response.status, index, candidates.length)) {
          logger?.debug?.('sidecar endpoint candidate failed, trying fallback', { operation, endpoint, status: response.status });
          continue;
        }

        logger?.warn?.('sidecar request failed', { operation, endpoint, status: response.status });
        return normalizeFailureEnvelope({ operation, endpoint, status: response.status, data });
      } catch (error) {
        if (shouldTryNextCandidate(404, index, candidates.length)) {
          logger?.debug?.('sidecar request error on candidate, trying fallback', {
            operation,
            endpoint,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        const isAbort = error instanceof Error && error.name === 'AbortError';
        logger?.warn?.('sidecar request errored', {
          operation,
          endpoint,
          timeoutMs,
          error: error instanceof Error ? error.message : String(error),
        });

        return normalizeFailureEnvelope({
          operation,
          endpoint,
          error: isAbort ? `Request timed out after ${timeoutMs}ms` : error,
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    return normalizeFailureEnvelope({
      operation,
      endpoint: new URL(candidates[0].path, `${baseUrl}/`).toString(),
      error: 'No sidecar endpoint candidate succeeded.',
    });
  }

  return {
    baseUrl,
    timeoutMs,
    request,
    health(payload, requestOptions) {
      return request('health', payload, requestOptions);
    },
    search(payload, requestOptions) {
      return request('search', payload, requestOptions);
    },
    smartIngest(payload, requestOptions) {
      return request('smartIngest', payload, requestOptions);
    },
    promoteMemory(payload, requestOptions) {
      return request('promoteMemory', payload, requestOptions);
    },
    demoteMemory(payload, requestOptions) {
      return request('demoteMemory', payload, requestOptions);
    },
    intention(payload, requestOptions) {
      return request('intention', payload, requestOptions);
    },
    exportStable(payload, requestOptions) {
      return request('exportStable', payload, requestOptions);
    },
    consolidate(payload, requestOptions) {
      return request('consolidate', payload, requestOptions);
    },
    markMaterialized(payload, requestOptions) {
      return request('markMaterialized', payload, requestOptions);
    },
  };
}

export class VestigeSidecarClient {
  constructor(options = {}) {
    this.client = createSidecarClient(options);
    this.baseUrl = this.client.baseUrl;
    this.timeoutMs = this.client.timeoutMs;
  }

  request(...args) {
    return this.client.request(...args);
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
}
