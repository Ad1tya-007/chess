import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';

import { ChessComClient } from '../../src/clients/chesscom.client.js';
import type { Database } from '../../src/db/client.js';
import type {
  openingMoveTreeOutput,
  openingStatsOutput,
  opponentStatsOutput,
  performanceOutput,
} from '../../src/server/tools/analytics.tools.js';
import type { gameDetailsOutput, recentGamesOutput } from '../../src/server/tools/games.tools.js';
import type { profileOutput, statsOutput } from '../../src/server/tools/player.tools.js';
import type { syncOutput } from '../../src/server/tools/sync.tools.js';
import { createHttpApp, type HttpApp } from '../../src/server/transport.js';
import { createServices, type Services } from '../../src/services/create-services.js';
import { createLogger } from '../../src/utils/logger.js';
import { fixtures } from '../fixtures/games.js';
import { testConfig } from '../helpers/config.js';
import { createFreshTestDatabase, testDatabaseUrl } from '../helpers/db.js';
import { FakeChessCom } from '../helpers/fake-chesscom.js';
import { status } from '../helpers/fake-fetch.js';

const NOW = new Date('2026-11-25T12:00:00Z');
const at = (iso: string) => new Date(iso);

/**
 * Stored games from TestPlayer's perspective (the chess960 game is skipped by sync):
 *   2026-11-24 win  white rapid      2026-11-20 win  black blitz    2026-11-10 draw white bullet
 *   2026-11-05 win  white rapid (unparseable moves)                 2026-10-15 win  white daily
 *   2026-10-02 loss black rapid      2026-10-01 win  white rapid
 */
const GAMES = {
  recentWin: fixtures.whiteWin(),
  blackWin: fixtures.blackWin(),
  draw: fixtures.draw(),
  malformed: fixtures.malformedPgn(),
  variant: fixtures.chess960(),
  unrated: fixtures.missingRatings(),
  loss: fixtures.missingEcoAndOpening(),
  oldWin: fixtures.whiteWin(),
};
GAMES.loss.rated = false;
const DATES: Record<keyof typeof GAMES, string> = {
  recentWin: '2026-11-24T10:00:00Z',
  blackWin: '2026-11-20T10:00:00Z',
  draw: '2026-11-10T10:00:00Z',
  malformed: '2026-11-05T10:00:00Z',
  variant: '2026-11-03T10:00:00Z',
  unrated: '2026-10-15T10:00:00Z',
  loss: '2026-10-02T10:00:00Z',
  oldWin: '2026-10-01T10:00:00Z',
};
for (const key of Object.keys(GAMES) as (keyof typeof GAMES)[]) GAMES[key].endTime = at(DATES[key]);

interface Outputs {
  get_player_profile: z.infer<typeof profileOutput>;
  get_player_stats: z.infer<typeof statsOutput>;
  sync_chesscom_games: z.infer<typeof syncOutput>;
  get_recent_games: z.infer<typeof recentGamesOutput>;
  get_game_details: z.infer<typeof gameDetailsOutput>;
  get_opening_statistics: z.infer<typeof openingStatsOutput>;
  get_opening_move_tree: z.infer<typeof openingMoveTreeOutput>;
  get_opponent_statistics: z.infer<typeof opponentStatsOutput>;
  get_performance_summary: z.infer<typeof performanceOutput>;
}

describe.skipIf(!testDatabaseUrl)('MCP tools (requires TEST_DATABASE_URL)', () => {
  let database: Database;
  let api: FakeChessCom;
  let services: Services;
  let httpApp: HttpApp;
  let server: Server;
  let client: Client;
  let clock = NOW;

  async function call<N extends keyof Outputs>(name: N, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[]).map((part) => part.text);
    return { result, text, data: result.structuredContent as Outputs[N] };
  }

  async function connect(mode: 'legacy' | 'auto') {
    const { port } = server.address() as AddressInfo;
    const instance = new Client(
      { name: 'tools-test', version: '1.0.0' },
      { versionNegotiation: { mode } },
    );
    await instance.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    return instance;
  }

  beforeAll(async () => {
    database = await createFreshTestDatabase();
    api = new FakeChessCom().addPlayer('TestPlayer');
    api.setArchive('TestPlayer', 2026, 10, [GAMES.oldWin, GAMES.loss, GAMES.unrated]);
    api.setArchive('TestPlayer', 2026, 11, [
      GAMES.malformed,
      GAMES.variant,
      GAMES.draw,
      GAMES.blackWin,
      GAMES.recentWin,
    ]);

    const config = testConfig({
      MAX_SYNC_MONTHS_PER_CALL: '6',
      DEFAULT_GAME_LIMIT: '20',
      MCP_ALLOW_ANY_USERNAME: 'true',
      SYNC_COOLDOWN_SECONDS: '0',
    });
    const logger = createLogger(config);
    const chessCom = new ChessComClient({
      userAgent: config.CHESSCOM_USER_AGENT,
      timeoutMs: 1_000,
      logger,
      maxRetries: 0,
      fetch: api.fetch,
      sleep: () => Promise.resolve(),
    });
    services = createServices(config, database, logger, { chessCom, now: () => clock });
    httpApp = createHttpApp({
      config,
      logger,
      services,
      checkDatabase: () => Promise.resolve(true),
    });
    server = await new Promise((resolve) => {
      const s = httpApp.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    client = await connect('legacy');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clock = NOW;
  });

  afterAll(async () => {
    await client?.close();
    await httpApp?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await database?.close();
  });

  it('lists the tools with input/output schemas and annotations', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_game_details',
      'get_opening_move_tree',
      'get_opening_statistics',
      'get_opponent_statistics',
      'get_performance_summary',
      'get_player_profile',
      'get_player_stats',
      'get_recent_games',
      'sync_chesscom_games',
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.annotations?.readOnlyHint).toBe(tool.name !== 'sync_chesscom_games');
    }
    const sync = tools.find((tool) => tool.name === 'sync_chesscom_games')!;
    expect(sync.inputSchema.properties?.months).toMatchObject({ minimum: 1, maximum: 6 });
    const opening = tools.find((tool) => tool.name === 'get_opening_statistics')!;
    expect(opening.inputSchema.required).toEqual(['color']);
    const opponents = tools.find((tool) => tool.name === 'get_opponent_statistics')!;
    expect(opponents.annotations?.idempotentHint).toBe(true);
    expect(opponents.annotations?.openWorldHint).toBe(false);
    const moveTree = tools.find((tool) => tool.name === 'get_opening_move_tree')!;
    expect(moveTree.inputSchema.required).toEqual(['color']);
    expect(moveTree.inputSchema.properties?.max_ply).toMatchObject({ minimum: 1, maximum: 12 });
  });

  it('lists coverage, last-sync, and profile resources for the configured player', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      'chess://player/testplayer/coverage',
      'chess://player/testplayer/last-sync',
      'chess://player/testplayer/profile',
    ]);
    for (const resource of resources) {
      expect(resource.mimeType).toBe('application/json');
      expect(resource.description?.length).toBeGreaterThan(20);
    }

    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      'chess://player/{username}/coverage',
      'chess://player/{username}/last-sync',
      'chess://player/{username}/profile',
    ]);
  });

  it('lists the three workflow prompt templates', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'import-history',
      'opening-repertoire-review',
      'weekly-performance-review',
    ]);
    expect(prompts.length).toBeGreaterThan(0);
    const importHistory = prompts.find((prompt) => prompt.name === 'import-history')!;
    expect(importHistory.arguments?.some((arg) => arg.name === 'months')).toBe(true);

    const got = await client.getPrompt({ name: 'import-history', arguments: { months: '2' } });
    expect(got.messages[0]?.role).toBe('user');
    const text = got.messages[0]?.content;
    expect(text && text.type === 'text' ? text.text : '').toMatch(/mode "initial"/);
  });

  describe('before any sync', () => {
    it('get_recent_games says nothing is synchronized', async () => {
      const { result, text, data } = await call('get_recent_games');
      expect(result.isError).toBeFalsy();
      expect(text[0]).toMatch(/No games are synchronized for testplayer/);
      expect(data).toMatchObject({
        username: 'testplayer',
        source: 'local_database',
        total_matching: 0,
        games: [],
        data_coverage: { games_stored: 0, last_sync: null },
      });
      expect(data.warnings[0]).toMatch(/sync_chesscom_games/);
    });

    it('analytics return nulls, not zeros, for rates', async () => {
      const { data } = await call('get_performance_summary', { period: 'all' });
      expect(data.results).toEqual({
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        win_rate: null,
        score_percentage: null,
      });
      expect(data.average_opponent_rating).toEqual({ value: null, games_with_rating: 0 });
      expect(data.warnings[0]).toMatch(/No games have been synchronized/);
    });
  });

  describe('live Chess.com tools', () => {
    it('get_player_profile returns the profile with source and timestamps', async () => {
      const { text, data } = await call('get_player_profile');
      expect(text[0]).toMatch(/^Chess.com profile for testplayer \(FM Test Player\), joined 2007/);
      expect(data).toMatchObject({
        username: 'testplayer',
        source: 'chesscom_pubapi',
        cache: 'network',
        profile: {
          title: 'FM',
          country_code: 'US',
          profile_url: 'https://www.chess.com/member/TestPlayer',
          joined_at: '2007-05-07T16:50:00.000Z',
        },
      });
      expect(Date.parse(data.fetched_at)).not.toBeNaN();
    });

    it('get_player_stats distinguishes current ratings from records', async () => {
      const { data } = await call('get_player_stats');
      const rapid = data.ratings.find((rating) => rating.category === 'chess_rapid');
      expect(rapid).toMatchObject({
        time_class: 'rapid',
        current_rating: 1642,
        best_rating: 1710,
        record: { games: 322, wins: 177, losses: 124, draws: 21, win_rate: 55 },
      });
      expect(data.note).toMatch(/Neither is computed from synchronized games/);
      expect(data.ratings.some((rating) => rating.rules === 'chess960')).toBe(true);
    });

    it('reports unknown players and transient failures as tool errors', async () => {
      const unknown = await call('get_player_profile', { username: 'nobody-here' });
      expect(unknown.result.isError).toBe(true);
      expect(unknown.text[0]).toMatch(/^Error \(chesscom_not_found\)/);

      api.fail('/player/testplayer/stats', status(503));
      try {
        const transient = await call('get_player_stats');
        expect(transient.result.isError).toBe(true);
        expect(transient.text[0]).toMatch(/chesscom_upstream_error.*try again later/);
      } finally {
        api.clearFailures();
      }
    });
  });

  describe('sync_chesscom_games', () => {
    it('imports games and reports counters', async () => {
      const { text, data } = await call('sync_chesscom_games', { mode: 'initial', months: 2 });
      expect(text[0]).toMatch(/^Sync success for testplayer \(initial\)/);
      expect(data).toMatchObject({
        username: 'testplayer',
        source: 'chesscom_pubapi',
        status: 'success',
        mode: 'initial',
        archives_checked: 2,
        games_fetched: 8,
        games_inserted: 7,
        games_skipped: 1,
        coverage: { from: '2026-10', to: '2026-11' },
        archives_remaining: 0,
      });
    });

    it('is idempotent on repeat', async () => {
      const { data } = await call('sync_chesscom_games');
      expect(data).toMatchObject({
        mode: 'incremental',
        games_inserted: 0,
        archives_not_modified: 2,
      });
    });

    it('rejects months above the configured maximum', async () => {
      const { result, text } = await call('sync_chesscom_games', { months: 7 });
      expect(result.isError).toBe(true);
      expect(text[0]).toMatch(/Input validation error/);
    });
  });

  describe('get_recent_games', () => {
    it('lists games newest first from the player perspective', async () => {
      const { text, data } = await call('get_recent_games');
      expect(text[0]).toBe('Showing 7 of 7 matching games for testplayer, newest first.');
      expect(data.games.map((game) => game.played_at.slice(0, 10))).toEqual([
        '2026-11-24',
        '2026-11-20',
        '2026-11-10',
        '2026-11-05',
        '2026-10-15',
        '2026-10-02',
        '2026-10-01',
      ]);
      expect(data.games[1]).toMatchObject({
        result: 'win',
        color: 'black',
        opponent: 'opponent',
        player_rating: 1510,
        opponent_rating: 1500,
        time_class: 'blitz',
        eco: 'A00',
      });
      expect(data.games[0]).not.toHaveProperty('pgn');
      expect(data.data_coverage).toMatchObject({
        games_stored: 7,
        synced_months: 2,
        earliest_synced_month: '2026-10',
      });
      expect(data.warnings).toEqual([]);
    });

    it('applies filters', async () => {
      const ids = async (args: Record<string, unknown>) =>
        (await call('get_recent_games', args)).data.games.map((game) =>
          game.played_at.slice(0, 10),
        );
      expect(await ids({ result: 'loss' })).toEqual(['2026-10-02']);
      expect(await ids({ color: 'black' })).toEqual(['2026-11-20', '2026-10-02']);
      expect(await ids({ time_class: 'bullet' })).toEqual(['2026-11-10']);
      expect(await ids({ from_date: '2026-11-05', to_date: '2026-11-10' })).toEqual([
        '2026-11-10',
        '2026-11-05',
      ]);
      expect(await ids({ rated: true })).toEqual([
        '2026-11-24',
        '2026-11-20',
        '2026-11-10',
        '2026-11-05',
        '2026-10-01',
      ]);
      expect(await ids({ rated: false })).toEqual(['2026-10-02']);
      expect(await ids({ opponent: 'Opponent' })).toEqual([
        '2026-11-24',
        '2026-11-20',
        '2026-11-05',
        '2026-10-01',
      ]);
      expect(await ids({ time_control: '180+2' })).toEqual(['2026-11-20']);
      const echoed = await call('get_recent_games', {
        rated: true,
        opponent: 'Opponent',
        time_control: '600',
      });
      expect(echoed.data.filters).toMatchObject({
        rated: true,
        opponent: 'opponent',
        time_control: '600',
      });
      expect(echoed.data.games.map((game) => game.played_at.slice(0, 10))).toEqual([
        '2026-11-24',
        '2026-11-05',
        '2026-10-01',
      ]);
    });

    it('pages with limit and offset', async () => {
      const { data } = await call('get_recent_games', { limit: 2, offset: 2 });
      expect(data).toMatchObject({ returned: 2, total_matching: 7, has_more: true, offset: 2 });
      expect(data.games[0]?.played_at.slice(0, 10)).toBe('2026-11-10');
    });

    it('warns when the range predates synchronized months', async () => {
      const { data } = await call('get_recent_games', { from_date: '2026-01-01' });
      expect(data.warnings[0]).toMatch(/only synchronized from 2026-10/);
    });

    it('warns when local data is stale', async () => {
      clock = new Date(NOW.getTime() + 3 * 86_400_000);
      const { data } = await call('get_recent_games', { limit: 1 });
      expect(data.warnings[0]).toMatch(/last synchronized 3 days ago/);
    });

    it.each([
      [{ limit: 0 }, /Input validation error/],
      [{ limit: 101 }, /Input validation error/],
      [{ username: 'bad name!' }, /Input validation error/],
      [{ from_date: 'yesterday' }, /Input validation error/],
      [{ result: 'resigned' }, /Input validation error/],
      [{ opponent: 'bad name!' }, /Input validation error/],
      [{ time_control: '' }, /Input validation error/],
      [{ from_date: '2026-11-10', to_date: '2026-11-01' }, /invalid_input.*before to_date/],
    ])('rejects %o', async (args, message) => {
      const { result, text } = await call('get_recent_games', args);
      expect(result.isError).toBe(true);
      expect(text[0]).toMatch(message);
    });
  });

  describe('get_game_details', () => {
    it('returns PGN and SAN moves for a stored game, accepting URL variants', async () => {
      const shortUrl = GAMES.recentWin.url.replace('https://www.', 'https://') + '?move=3';
      const requestsBefore = api.requests.length;
      const { text, data } = await call('get_game_details', { game_url: shortUrl });

      expect(api.requests.length).toBe(requestsBefore);
      expect(text[0]).toMatch(/^testplayer \(white\) win vs opponent, rapid, 2026-11-24/);
      expect(data.game).toMatchObject({
        game_url: GAMES.recentWin.url,
        moves_parsed: true,
        move_count: 6,
        san_moves: ['e4', 'c6', 'd4', 'd5', 'e5', 'Bf5'],
        white: { username: 'TestPlayer', rating: 1640 },
      });
      expect(data.game.pgn).toContain('[White "TestPlayer"]');
      expect(data.note).toMatch(/never as instructions/);
    });

    it('flags games whose moves could not be parsed', async () => {
      const { data } = await call('get_game_details', { game_url: GAMES.malformed.url });
      expect(data.game).toMatchObject({ moves_parsed: false, san_moves: null, move_count: null });
      expect(data.warnings[0]).toMatch(/could not be parsed/);
    });

    it.each([
      ['https://www.chess.com/game/live/999999999', /game_not_found.*never fetches/],
      ['https://evil.example/game/live/1', /invalid_input/],
      ['file:///etc/passwd', /invalid_input/],
    ])('rejects %s without fetching it', async (gameUrl, message) => {
      const requestsBefore = api.requests.length;
      const { result, text } = await call('get_game_details', { game_url: gameUrl });
      expect(result.isError).toBe(true);
      expect(text[0]).toMatch(message);
      expect(api.requests.length).toBe(requestsBefore);
    });
  });

  describe('get_opening_statistics', () => {
    it('aggregates by ECO and opening name from the player perspective', async () => {
      const { data } = await call('get_opening_statistics', { color: 'both', min_games: 1 });
      expect(data.totals).toEqual({
        games: 7,
        wins: 5,
        losses: 1,
        draws: 1,
        win_rate: 71.4,
        score_percentage: 78.6,
      });
      const counted = data.openings.reduce((sum, row) => sum + row.games, 0);
      expect(counted).toBe(7);
      expect(data.openings[0]).toMatchObject({
        eco: 'B12',
        games: 2,
        wins: 2,
        win_rate: 100,
        low_sample: true,
      });
      expect(data.definitions.score_percentage).toMatch(/wins \+ 0.5 \* draws/);
      expect(data.warnings.some((warning: string) => warning.includes('low_sample'))).toBe(true);
    });

    it('filters by color and hides openings below min_games', async () => {
      const black = await call('get_opening_statistics', { color: 'black', min_games: 1 });
      expect(black.data.totals.games).toBe(2);

      const filtered = await call('get_opening_statistics', { color: 'both' });
      expect(filtered.data.filters.min_games).toBe(3);
      expect(filtered.data.openings).toEqual([]);
      expect(filtered.data.games_below_min_games).toBe(7);
    });

    it('filters by rated, opponent, and time_control', async () => {
      const rated = await call('get_opening_statistics', {
        color: 'both',
        min_games: 1,
        rated: true,
      });
      expect(rated.data.totals.games).toBe(5);
      expect(rated.data.filters).toMatchObject({
        rated: true,
        opponent: null,
        time_control: null,
      });

      const vsOpp = await call('get_opening_statistics', {
        color: 'both',
        min_games: 1,
        opponent: 'OPP',
      });
      expect(vsOpp.data.totals.games).toBe(1);
      expect(vsOpp.data.filters.opponent).toBe('opp');

      const control = await call('get_opening_statistics', {
        color: 'both',
        min_games: 1,
        time_control: '180+2',
      });
      expect(control.data.totals.games).toBe(1);
      expect(control.data.filters.time_control).toBe('180+2');
    });

    it('requires color', async () => {
      const { result } = await call('get_opening_statistics', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_opponent_statistics', () => {
    it('ranks opponents by games played with low_sample flags', async () => {
      const { text, data } = await call('get_opponent_statistics', { min_games: 1 });
      expect(text[0]).toMatch(/Most played: opponent \(4 games/);
      expect(data.totals.games).toBe(7);
      expect(data.opponents.map((row) => [row.opponent, row.games, row.score_percentage])).toEqual([
        ['opponent', 4, 100],
        ['unrated', 1, 100],
        ['drawer', 1, 50],
        ['opp', 1, 0],
      ]);
      expect(data.opponents[0]).toMatchObject({
        opponent: 'opponent',
        wins: 4,
        losses: 0,
        draws: 0,
        win_rate: 100,
        score_percentage: 100,
        low_sample: true,
        by_color: {
          white: { games: 3, wins: 3 },
          black: { games: 1, wins: 1 },
        },
      });
      expect(data.definitions.grouping).toMatch(/case-insensitive/);
      expect(data.warnings.some((warning: string) => warning.includes('low_sample'))).toBe(true);
    });

    it('returns a head-to-head when opponent is set and defaults min_games to 1', async () => {
      const { text, data } = await call('get_opponent_statistics', { opponent: 'OPPONENT' });
      expect(text[0]).toBe(
        'Head-to-head vs opponent: 4 games, 4W/0L/0D, win rate 100%, score 100%.',
      );
      expect(data.filters).toMatchObject({ opponent: 'opponent', min_games: 1 });
      expect(data.opponents).toHaveLength(1);
      expect(data.opponents[0]).toMatchObject({ opponent: 'opponent', games: 4, wins: 4 });
    });

    it('filters by color and hides opponents below min_games', async () => {
      const black = await call('get_opponent_statistics', { color: 'black', min_games: 1 });
      expect(black.data.totals.games).toBe(2);
      expect(black.data.opponents.map((row) => row.opponent).sort()).toEqual(['opp', 'opponent']);

      const filtered = await call('get_opponent_statistics');
      expect(filtered.data.filters.min_games).toBe(3);
      expect(filtered.data.opponents).toEqual([
        expect.objectContaining({ opponent: 'opponent', games: 4 }),
      ]);
      expect(filtered.data.games_below_min_games).toBe(3);
    });

    it('reports when a specific opponent has no matching games', async () => {
      const { text, data } = await call('get_opponent_statistics', { opponent: 'nobody' });
      expect(text[0]).toMatch(/No synchronized games against "nobody"/);
      expect(data.opponents).toEqual([]);
      expect(data.warnings.some((warning: string) => warning.includes('nobody'))).toBe(true);
    });
  });

  describe('get_opening_move_tree', () => {
    it('builds a SAN prefix tree and skips unparsed games', async () => {
      const { text, data } = await call('get_opening_move_tree', {
        color: 'both',
        min_games: 1,
        max_ply: 2,
      });
      expect(text[0]).toMatch(/Move tree for testplayer \(both\).*parsed games/);
      expect(data.totals.games).toBe(7);
      expect(data.games_with_moves).toBe(6);
      expect(data.games_missing_moves).toBe(1);
      expect(data.filters).toMatchObject({
        color: 'both',
        max_ply: 2,
        min_games: 1,
        max_children: 8,
      });
      expect(data.root).toMatchObject({
        san: null,
        prefix: [],
        ply: 0,
        games: 6,
        children_omitted: 0,
      });
      // Ties on games: higher score first (f3 win before d4 draw).
      expect(data.root.children.map((child) => [child.san, child.games])).toEqual([
        ['e4', 4],
        ['f3', 1],
        ['d4', 1],
      ]);
      const e4 = data.root.children[0]!;
      expect(e4.children.map((child) => [child.san, child.prefix, child.games])).toEqual([
        ['c6', ['e4', 'c6'], 2],
        ['e5', ['e4', 'e5'], 2],
      ]);
      expect(data.warnings.some((warning: string) => warning.includes('san_moves'))).toBe(true);
      expect(data.definitions.grouping).toMatch(/SAN move prefix/);
    });

    it('filters by color and time_class and honors min_games', async () => {
      const white = await call('get_opening_move_tree', {
        color: 'white',
        time_class: 'rapid',
        min_games: 1,
        max_ply: 1,
      });
      // recentWin + oldWin (Caro) + loss is black; rapid white with moves: recentWin, oldWin
      // malformed is rapid white but null san_moves
      expect(white.data.totals.games).toBe(3);
      expect(white.data.games_with_moves).toBe(2);
      expect(white.data.games_missing_moves).toBe(1);
      expect(white.data.root.children).toEqual([
        expect.objectContaining({ san: 'e4', games: 2, prefix: ['e4'] }),
      ]);

      const rare = await call('get_opening_move_tree', {
        color: 'both',
        min_games: 3,
        max_ply: 1,
      });
      expect(rare.data.root.children.map((child) => child.san)).toEqual(['e4']);
      expect(rare.data.root.children_omitted).toBe(2);
    });

    it('requires color', async () => {
      const { result } = await call('get_opening_move_tree', {});
      expect(result.isError).toBe(true);
    });
  });

  describe('get_performance_summary', () => {
    it.each([
      ['7d', 2],
      ['30d', 4],
      ['90d', 7],
      ['all', 7],
    ])('counts games in period %s', async (period, games) => {
      const { data } = await call('get_performance_summary', { period });
      expect(data.results.games).toBe(games);
      expect(data.period).toBe(period);
    });

    it('defaults to 30 days and reports colors, ratings, streaks, and coverage', async () => {
      const { text, data } = await call('get_performance_summary');
      expect(text[0]).toBe('testplayer, 30d: 4 games, 3W/0L/1D, win rate 75%, score 87.5%.');
      expect(data).toMatchObject({
        period: '30d',
        period_start: '2026-10-26T12:00:00.000Z',
        period_end: NOW.toISOString(),
        by_color: { white: { games: 3, wins: 2, draws: 1 }, black: { games: 1, wins: 1 } },
        // (1620 + 1500 + 1410 + 1620) / 4 = 1537.5
        average_opponent_rating: { value: 1538, games_with_rating: 4 },
        streaks: {
          longest_win_streak: { length: 2 },
          longest_loss_streak: null,
          current: { type: 'win', length: 2 },
        },
        date_range: {
          first_game_at: '2026-11-05T10:00:00.000Z',
          last_game_at: '2026-11-24T10:00:00.000Z',
        },
      });
      expect(data.definitions.streak).toMatch(/draw ends/i);
      expect(data.definitions.rating_trend).toMatch(/not an official rating history/);
      expect(data.warnings.some((warning: string) => warning.includes('mixes time classes'))).toBe(
        true,
      );
    });

    it('reports rating trends from recorded game ratings per time class', async () => {
      const { data } = await call('get_performance_summary', {
        period: 'all',
        time_class: 'rapid',
      });
      expect(data.results.games).toBe(4);
      expect(data.rating_trends).toEqual([
        expect.objectContaining({
          time_class: 'rapid',
          games_with_rating: 4,
          first_rating: 1640,
          last_rating: 1640,
          change: 0,
        }),
      ]);
      expect(data.warnings).toEqual([]);
    });

    it('filters by rated, opponent, and time_control', async () => {
      const rated = await call('get_performance_summary', { period: 'all', rated: false });
      expect(rated.data.results.games).toBe(1);
      expect(rated.data).toMatchObject({
        rated: false,
        opponent: null,
        time_control: null,
      });

      const vs = await call('get_performance_summary', { period: 'all', opponent: 'drawer' });
      expect(vs.data.results).toMatchObject({ games: 1, draws: 1 });
      expect(vs.data.opponent).toBe('drawer');

      const control = await call('get_performance_summary', {
        period: 'all',
        time_control: '60',
      });
      expect(control.data.results.games).toBe(1);
      expect(control.data.time_control).toBe('60');
    });
  });

  it('never leaks internal error details', async () => {
    vi.spyOn(services.games, 'getRecentGames').mockRejectedValueOnce(
      new Error('relation "secret_table" does not exist at postgres://user:pw@db'),
    );
    const { result, text } = await call('get_recent_games');
    expect(result.isError).toBe(true);
    expect(text).toEqual([
      'Error (internal_error): Internal error while running get_recent_games. Try again later.',
    ]);
  });

  it('returns the JSON payload as text too, and works on the modern protocol era', async () => {
    const legacy = await call('get_recent_games', { limit: 1 });
    expect(JSON.parse(legacy.text[1]!)).toEqual(legacy.data);

    const modern = await connect('auto');
    try {
      const result = await modern.callTool({
        name: 'get_recent_games',
        arguments: { limit: 1 },
      });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as Outputs['get_recent_games']).returned).toBe(1);
    } finally {
      await modern.close();
    }
  });
});
