import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../../src/server/create-server.js';
import type { Services } from '../../src/services/create-services.js';
import type { LocalDataStatus } from '../../src/services/local-data.service.js';
import { createLogger } from '../../src/utils/logger.js';
import { testConfig } from '../helpers/config.js';

const emptyLocal = (username: string): LocalDataStatus => ({
  username,
  player: null,
  gamesStored: 0,
  firstGameAt: null,
  lastGameAt: null,
  syncedMonths: 0,
  earliestSyncedMonth: null,
  latestSyncedMonth: null,
  lastSuccessfulSyncAt: null,
  lastSync: null,
  warnings: [`No games have been synchronized for "${username}".`],
});

function mockServices(): Services {
  return {
    chessCom: {} as Services['chessCom'],
    repositories: {
      players: {} as Services['repositories']['players'],
      games: {} as Services['repositories']['games'],
      archives: {} as Services['repositories']['archives'],
      syncRuns: {
        latestForPlayer: vi.fn().mockResolvedValue(null),
      } as unknown as Services['repositories']['syncRuns'],
    },
    localData: {
      describe: vi.fn((username: string) => Promise.resolve(emptyLocal(username))),
      rangeWarnings: vi.fn(() => []),
    } as unknown as Services['localData'],
    player: {
      getProfile: vi.fn((username?: string) => {
        const resolved = (username ?? 'testplayer').toLowerCase();
        return Promise.resolve({
          username: resolved,
          data: {
            username: resolved,
            name: 'Test Player',
            title: null,
            status: 'basic',
            countryCode: 'US',
            location: null,
            profileUrl: `https://www.chess.com/member/${resolved}`,
            joinedAt: new Date('2020-01-01T00:00:00Z'),
            lastOnlineAt: null,
            followers: 0,
            fideRating: null,
            isStreamer: false,
            league: null,
          },
          fetchedAt: new Date('2026-11-25T12:00:00Z'),
          cache: 'network' as const,
          local: emptyLocal(resolved),
        });
      }),
      getStats: vi.fn(),
    } as unknown as Services['player'],
    sync: {} as Services['sync'],
    games: {} as Services['games'],
    analytics: {} as Services['analytics'],
  };
}

describe('MCP resources and prompts', () => {
  let client: Client | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    server = undefined;
  });

  async function connectClient() {
    const config = testConfig({ MCP_ALLOW_ANY_USERNAME: 'true' });
    const logger = createLogger(config);
    server = createServer({ config, logger, services: mockServices() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'resources-prompts-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('lists non-empty resources and resource templates', async () => {
    const mcp = await connectClient();
    const { resources } = await mcp.listResources();
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      'chess://player/testplayer/coverage',
      'chess://player/testplayer/last-sync',
      'chess://player/testplayer/profile',
    ]);

    const { resourceTemplates } = await mcp.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      'chess://player/{username}/coverage',
      'chess://player/{username}/last-sync',
      'chess://player/{username}/profile',
    ]);
  });

  it('lists non-empty prompt templates including import-history', async () => {
    const mcp = await connectClient();
    const { prompts } = await mcp.listPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'import-history',
      'opening-repertoire-review',
      'weekly-performance-review',
    ]);
  });

  it('reads the coverage resource as JSON', async () => {
    const mcp = await connectClient();
    const result = await mcp.readResource({ uri: 'chess://player/testplayer/coverage' });
    const text = result.contents[0] && 'text' in result.contents[0] ? result.contents[0].text : '';
    const body = JSON.parse(text) as { username: string; data_coverage: { games_stored: number } };
    expect(body.username).toBe('testplayer');
    expect(body.data_coverage.games_stored).toBe(0);
  });
});
