function buildUrl(baseUrl, endpoint) {
  const safeEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${baseUrl}${safeEndpoint}`;
}

function buildHeaders() {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class VestigeSidecarClient {
  constructor({ baseUrl, timeoutMs = 5000, logger, failSoft = true }) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.failSoft = failSoft;
  }

  async health(payload = {}) {
    return this.request('/vestige/health', payload);
  }

  async stats(payload = {}) {
    return this.request('/vestige/stats', payload);
  }

  async search(payload) {
    return this.request('/vestige/search', payload);
  }

  async smartIngest(payload) {
    return this.request('/vestige/smart-ingest', payload);
  }

  async promoteMemory(payload) {
    return this.request('/vestige/promote-memory', payload);
  }

  async demoteMemory(payload) {
    return this.request('/vestige/demote-memory', payload);
  }

  async intention(payload) {
    return this.request('/vestige/intention', payload);
  }

  async exportStable(payload = {}) {
    return this.request('/vestige/export-stable', payload);
  }

  async consolidate(payload = {}) {
    return this.request('/vestige/consolidate', payload);
  }

  async markMaterialized(payload) {
    return this.request('/vestige/mark-materialized', payload);
  }

  async request(endpoint, payload = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(buildUrl(this.baseUrl, endpoint), {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });

      const data = await safeJson(response);
      if (!response.ok) {
        const error = new Error(`Vestige sidecar request failed: ${response.status} ${response.statusText}`);
        error.response = data;
        throw error;
      }
      return data;
    } catch (error) {
      if (this.failSoft) {
        this.logger?.warn?.(`sidecar ${endpoint} failed: ${String(error?.message ?? error)}`);
        return {
          ok: false,
          error: String(error?.message ?? error),
          endpoint,
          failSoft: true,
        };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
