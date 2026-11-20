/**
 * Checks a deployed server end to end: /health, the MCP handshake, tools/list and one read-only
 * tool call. Usage: npm run check:remote -- https://chess.example.com
 * Set REMOTE_MCP_TOKEN to send `Authorization: Bearer <token>` (it is never printed).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const write = (line = '') => process.stdout.write(`${line}\n`);
const fail = (message: string): never => {
  process.stderr.write(`FAIL ${message}\n`);
  process.exit(1);
};

const target = process.argv[2];
if (!target) fail('Usage: npm run check:remote -- https://<your-domain>');

let base: URL;
try {
  base = new URL(target!);
} catch {
  fail(`Not a URL: ${target}`);
}
base = new URL('/', base!);
if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
  write('WARN Claude only connects to https:// URLs on port 443.');
}
const token = process.env.REMOTE_MCP_TOKEN?.trim() || undefined;

const health = await fetch(new URL('/health', base)).catch((error: Error) =>
  fail(`GET /health: ${error.message}`),
);
const healthBody = (await health.json().catch(() => null)) as { status?: string } | null;
if (!health.ok) fail(`GET /health returned ${health.status} ${JSON.stringify(healthBody)}`);
write(`OK   GET /health -> ${health.status} ${healthBody?.status ?? ''}`);

const mcpUrl = new URL('/mcp', base);
const probe = await fetch(mcpUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
});
if (probe.status === 403) {
  fail(
    'POST /mcp -> 403. Your IP is outside MCP_ALLOWED_CLIENT_IPS (expected when only Claude is ' +
      'allowlisted) or the Host is not in MCP_ALLOWED_HOSTS. To check from here, set ' +
      'MCP_AUTH_TOKEN on the server and REMOTE_MCP_TOKEN locally.',
  );
}
if (probe.status === 401) {
  fail(`POST /mcp -> 401. ${token ? 'REMOTE_MCP_TOKEN is wrong.' : 'Set REMOTE_MCP_TOKEN.'}`);
}
if (probe.status === 429) fail('POST /mcp -> 429. Rate limited; wait a minute.');

const client = new Client(
  { name: 'chess-intelligence-remote-check', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
const transport = new StreamableHTTPClientTransport(mcpUrl, {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
});
try {
  await client.connect(transport);
  write(
    `OK   initialize -> ${client.getServerVersion()?.name ?? '?'} ` +
      `(protocol era: ${client.getProtocolEra()})`,
  );
  const { tools } = await client.listTools();
  write(`OK   tools/list -> ${tools.map((tool) => tool.name).join(', ')}`);
  const result = await client.callTool({ name: 'get_player_profile', arguments: {} });
  const first = Array.isArray(result.content) ? (result.content[0] as { text?: string }) : null;
  if (result.isError) fail(`get_player_profile -> ${first?.text ?? 'error'}`);
  write(`OK   get_player_profile -> ${first?.text ?? '(no text)'}`);
} catch (error) {
  fail(`MCP: ${(error as Error).message}`);
} finally {
  await client.close().catch(() => undefined);
}
