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

test('exportMemories calls MCP export tool with normalized payload', async () => {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    seen.push(body);

    if (body?.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } }, {
        headers: { 'mcp-session-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      });
    }

    if (body?.method === 'notifications/initialized') {
      return new Response(null, {
        status: 202,
        headers: { 'mcp-session-id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      });
    }

    if (body?.method === 'tools/call') {
      assert.equal(body.params.name, 'export');
      assert.equal(body.params.arguments.format, 'json');
      assert.equal(body.params.arguments.path, 'export.json');
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ tool: 'export', path: '/tmp/export.json', format: 'json' }),
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

  const result = await client.exportMemories({ format: 'json', path: 'export.json' });

  assert.equal(result.ok, true);
  assert.equal(result.data.tool, 'export');
  assert.equal(result.data.path, '/tmp/export.json');
  assert.equal(seen.some((entry) => entry?.method === 'tools/call'), true);
});
