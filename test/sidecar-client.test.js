import test from 'node:test';
import assert from 'node:assert/strict';

import { createSidecarClient } from '../src/sidecar-client.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

test('health initializes MCP session, lists tools, and pings', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    seen.push({ url, options, body });

    if (body?.method === 'initialize') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'vestige', version: '2.0.3' },
        },
      }, {
        headers: { 'mcp-session-id': '11111111-1111-4111-8111-111111111111' },
      });
    }

    if (body?.method === 'notifications/initialized') {
      return new Response(null, {
        status: 202,
        headers: { 'mcp-session-id': '11111111-1111-4111-8111-111111111111' },
      });
    }

    if (body?.method === 'tools/list') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            { name: 'search' },
            { name: 'smart_ingest' },
            { name: 'consolidate' },
          ],
        },
      });
    }

    if (body?.method === 'ping') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {},
      });
    }

    throw new Error(`Unexpected method: ${body?.method}`);
  };

  const client = createSidecarClient({
    baseUrl: 'http://127.0.0.1:3928',
    authToken: 'test-token-abcdefghijklmnopqrstuvwxyz',
    fetchImpl,
  });

  const result = await client.health();

  assert.equal(result.ok, true);
  assert.equal(result.data.initialized, true);
  assert.deepEqual(result.data.tools, ['search', 'smart_ingest', 'consolidate']);
  assert.equal(result.data.ping, true);
  assert.equal(seen[0].body.method, 'initialize');
  assert.equal(seen[1].body.method, 'notifications/initialized');
  assert.equal(seen[2].body.method, 'tools/list');
  assert.equal(seen[3].body.method, 'ping');
  assert.equal(seen[2].options.headers['mcp-session-id'], '11111111-1111-4111-8111-111111111111');
});

test('search maps recall-style payload into MCP search tool call and parses result JSON', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    seen.push({ url, options, body });

    if (body?.method === 'initialize') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2024-11-05' },
      }, {
        headers: { 'mcp-session-id': '22222222-2222-4222-8222-222222222222' },
      });
    }

    if (body?.method === 'notifications/initialized') {
      return new Response(null, {
        status: 202,
        headers: { 'mcp-session-id': '22222222-2222-4222-8222-222222222222' },
      });
    }

    if (body?.method === 'tools/call') {
      assert.equal(body.params.name, 'search');
      assert.equal(body.params.arguments.query, 'recent durable preference');
      assert.equal(body.params.arguments.limit, 4);
      assert.equal(body.params.arguments.detail_level, 'summary');
      assert.equal(body.params.arguments.token_budget, 1120);

      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                query: 'recent durable preference',
                results: [
                  {
                    id: 'memory-1',
                    content: 'User prefers concise technical replies.',
                    combinedScore: 0.88,
                    retentionStrength: 0.92,
                    tags: ['preference'],
                  },
                ],
              }),
            },
          ],
          isError: false,
        },
      });
    }

    throw new Error(`Unexpected method: ${body?.method}`);
  };

  const client = createSidecarClient({
    baseUrl: 'http://127.0.0.1:3928',
    authToken: 'test-token-abcdefghijklmnopqrstuvwxyz',
    fetchImpl,
  });

  const result = await client.search({
    query: 'recent durable preference',
    maxResults: 4,
    maxTokens: 280,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.query, 'recent durable preference');
  assert.equal(result.data.results.length, 1);
  assert.equal(result.data.results[0].content, 'User prefers concise technical replies.');
});

test('exportStable returns unsupported when vestige-mcp does not expose export_stable tools', async () => {
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;

    if (body?.method === 'initialize') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2024-11-05' },
      }, {
        headers: { 'mcp-session-id': '33333333-3333-4333-8333-333333333333' },
      });
    }

    if (body?.method === 'notifications/initialized') {
      return new Response(null, {
        status: 202,
        headers: { 'mcp-session-id': '33333333-3333-4333-8333-333333333333' },
      });
    }

    if (body?.method === 'tools/call') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown tool: ${body.params.name}` }),
            },
          ],
          isError: true,
        },
      });
    }

    throw new Error(`Unexpected method: ${body?.method}`);
  };

  const client = createSidecarClient({
    baseUrl: 'http://127.0.0.1:3928',
    authToken: 'test-token-abcdefghijklmnopqrstuvwxyz',
    fetchImpl,
  });

  const result = await client.exportStable({ reason: 'explicit_export' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 501);
  assert.match(result.error, /not supported/i);
});
