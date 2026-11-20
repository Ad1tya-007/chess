import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { Config } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/client.js';
import { createHttpApp, type HttpApp } from '../../src/server/transport.js';
import { createServices } from '../../src/services/create-services.js';
import { createLogger } from '../../src/utils/logger.js';
import { testConfig } from '../helpers/config.js';

const TOKEN = 'test-token-'.padEnd(48, 'x');

interface Running {
  baseUrl: string;
  stop(): Promise<void>;
}

const running: Running[] = [];
const clients: Client[] = [];

async function start(
  config: Config,
  checkDatabase: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<Running> {
  const logger = createLogger(config);
  // The pool connects lazily; these tests never call a tool that touches the database.
  const database = createDatabase(config.DATABASE_URL, logger);
  const services = createServices(config, database, logger);
  const httpApp: HttpApp = createHttpApp({ config, logger, services, checkDatabase });
  const server: Server = await new Promise((resolve) => {
    const s = httpApp.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const instance: Running = {
    baseUrl: `http://127.0.0.1:${port}`,
    async stop() {
      await httpApp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
    },
  };
  running.push(instance);
  return instance;
}

async function connectClient(
  baseUrl: string,
  options: { token?: string; headers?: Record<string, string>; mode?: 'legacy' | 'auto' } = {},
): Promise<Client> {
  const headers = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
    requestInit: { headers },
  });
  const client = new Client(
    { name: 'test-harness', version: '1.0.0' },
    { versionNegotiation: { mode: options.mode ?? 'legacy' } },
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

function postToolsList(baseUrl: string, headers: Record<string, string> = {}) {
  return fetch(new URL('/mcp', baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((instance) => instance.stop()));
});

describe('GET /health', () => {
  it('reports ok when the database is reachable', async () => {
    const { baseUrl } = await start(testConfig());
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(await response.json()).toMatchObject({
      status: 'ok',
      service: 'chess-intelligence-mcp',
      checks: { database: 'ok' },
    });
  });

  it('reports 503 when the database is unreachable', async () => {
    const { baseUrl } = await start(testConfig(), () => Promise.resolve(false));
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'degraded',
      checks: { database: 'unreachable' },
    });
  });

  it('does not expose configuration or secrets', async () => {
    const config = testConfig({ MCP_AUTH_TOKEN: TOKEN });
    const { baseUrl } = await start(config);
    const body = await (await fetch(`${baseUrl}/health`)).text();

    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain('postgres');
    expect(body).not.toContain(config.CHESSCOM_USERNAME);
  });

  it('is reachable without a token when auth is enabled', async () => {
    const { baseUrl } = await start(testConfig({ MCP_AUTH_TOKEN: TOKEN }));
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });
});

describe('MCP endpoint without authentication (local development)', () => {
  it('accepts a 2025-era initialize handshake from the official client', async () => {
    const { baseUrl } = await start(testConfig());
    const client = await connectClient(baseUrl);

    expect(client.getProtocolEra()).toBe('legacy');
    expect(client.getServerVersion()).toMatchObject({ name: 'chess-intelligence-mcp' });
    expect(client.getInstructions()).toContain('Read-only');
  });

  it('negotiates the 2026-07-28 protocol in auto mode', async () => {
    const { baseUrl } = await start(testConfig());
    const client = await connectClient(baseUrl, { mode: 'auto' });

    expect(client.getProtocolEra()).toBe('modern');
  });

  it('rejects requests whose Host header is not localhost (DNS rebinding protection)', async () => {
    const { baseUrl } = await start(testConfig());
    // fetch() cannot override Host, so use node:http directly.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        new URL('/mcp', baseUrl),
        {
          method: 'POST',
          headers: {
            host: 'evil.example.com',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    });

    expect(status).toBe(403);
  });

  it('rejects oversized request bodies', async () => {
    const { baseUrl } = await start(testConfig());
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { pad: 'x'.repeat(100_000) },
      }),
    });

    expect(response.status).toBe(413);
  });

  it('answers malformed JSON with a JSON-RPC parse error and no stack trace', async () => {
    const { baseUrl } = await start(testConfig());
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{not json',
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ error: { code: -32700 } });
    expect(body).not.toMatch(/at .+\.(js|ts):\d+/);
  });

  it('returns 404 for unknown paths', async () => {
    const { baseUrl } = await start(testConfig());
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
  });
});

describe('MCP endpoint with bearer authentication', () => {
  it('rejects requests without a token before reaching the MCP handler', async () => {
    const { baseUrl } = await start(testConfig({ MCP_AUTH_TOKEN: TOKEN }));
    const response = await postToolsList(baseUrl);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('rejects an incorrect token', async () => {
    const { baseUrl } = await start(testConfig({ MCP_AUTH_TOKEN: TOKEN }));
    const response = await postToolsList(baseUrl, { authorization: `Bearer ${TOKEN}-wrong` });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(TOKEN);
  });

  it('rejects a non-bearer authorization scheme', async () => {
    const { baseUrl } = await start(testConfig({ MCP_AUTH_TOKEN: TOKEN }));
    const response = await postToolsList(baseUrl, { authorization: `Basic ${TOKEN}` });

    expect(response.status).toBe(401);
  });

  it('accepts the configured token', async () => {
    const { baseUrl } = await start(testConfig({ MCP_AUTH_TOKEN: TOKEN }));
    const client = await connectClient(baseUrl, { token: TOKEN });

    expect(client.getServerVersion()).toMatchObject({ name: 'chess-intelligence-mcp' });
  });
});

describe('MCP endpoint with a client IP allowlist', () => {
  const ANTHROPIC = '160.79.104.0/21,153.61.208.0/20';
  const ANTHROPIC_IP = '160.79.105.7';

  it('admits a client whose socket address is allowlisted, without a token', async () => {
    const { baseUrl } = await start(testConfig({ MCP_ALLOWED_CLIENT_IPS: '127.0.0.0/8' }));
    const client = await connectClient(baseUrl);

    expect(client.getServerVersion()).toMatchObject({ name: 'chess-intelligence-mcp' });
  });

  it('rejects other clients with 403 before reaching the MCP handler', async () => {
    const { baseUrl } = await start(testConfig({ MCP_ALLOWED_CLIENT_IPS: ANTHROPIC }));
    const response = await postToolsList(baseUrl);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });

  it('uses X-Forwarded-For only for the configured number of proxy hops', async () => {
    const behindProxy = await start(
      testConfig({ MCP_ALLOWED_CLIENT_IPS: ANTHROPIC, TRUST_PROXY: '1' }),
    );
    const client = await connectClient(behindProxy.baseUrl, {
      headers: { 'x-forwarded-for': `203.0.113.9, ${ANTHROPIC_IP}` },
    });
    expect(client.getServerVersion()).toMatchObject({ name: 'chess-intelligence-mcp' });

    // Only the right-most hop is trusted, so a spoofed left-most entry is ignored.
    const spoofed = await postToolsList(behindProxy.baseUrl, {
      'x-forwarded-for': `${ANTHROPIC_IP}, 203.0.113.9`,
    });
    expect(spoofed.status).toBe(403);
  });

  it('ignores X-Forwarded-For when TRUST_PROXY is 0', async () => {
    const { baseUrl } = await start(testConfig({ MCP_ALLOWED_CLIENT_IPS: ANTHROPIC }));
    const response = await postToolsList(baseUrl, { 'x-forwarded-for': ANTHROPIC_IP });

    expect(response.status).toBe(403);
  });

  it('falls back to the bearer token for clients outside the allowlist', async () => {
    const config = testConfig({ MCP_ALLOWED_CLIENT_IPS: ANTHROPIC, MCP_AUTH_TOKEN: TOKEN });
    const { baseUrl } = await start(config);

    const anonymous = await postToolsList(baseUrl);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Bearer/);

    const client = await connectClient(baseUrl, { token: TOKEN });
    expect(client.getServerVersion()).toMatchObject({ name: 'chess-intelligence-mcp' });
  });
});

describe('MCP rate limiting', () => {
  it('answers 429 once a client exceeds MCP_RATE_LIMIT_PER_MINUTE', async () => {
    const { baseUrl } = await start(testConfig({ MCP_RATE_LIMIT_PER_MINUTE: '2' }));

    expect((await postToolsList(baseUrl)).status).not.toBe(429);
    expect((await postToolsList(baseUrl)).status).not.toBe(429);
    const limited = await postToolsList(baseUrl);

    expect(limited.status).toBe(429);
    expect(limited.headers.get('ratelimit-policy')).toBeTruthy();
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('counts rejected requests too, so guessing tokens is throttled', async () => {
    const { baseUrl } = await start(
      testConfig({ MCP_AUTH_TOKEN: TOKEN, MCP_RATE_LIMIT_PER_MINUTE: '1' }),
    );

    expect((await postToolsList(baseUrl, { authorization: 'Bearer guess-1' })).status).toBe(401);
    expect((await postToolsList(baseUrl, { authorization: 'Bearer guess-2' })).status).toBe(429);
  });
});

describe('username lock', () => {
  it('refuses other Chess.com usernames unless MCP_ALLOW_ANY_USERNAME is set', async () => {
    const { baseUrl } = await start(testConfig());
    const client = await connectClient(baseUrl);

    const result = await client.callTool({
      name: 'get_player_profile',
      arguments: { username: 'someone-else' },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Error (username_not_allowed): This server only serves Chess.com data for "testplayer". Omit username to use it.',
      },
    ]);

    const { tools } = await client.listTools();
    const profile = tools.find((tool) => tool.name === 'get_player_profile')!;
    const usernameProperty = profile.inputSchema.properties?.username as { description?: string };
    expect(usernameProperty.description).toContain('only serves the Chess.com player "testplayer"');
  });
});
