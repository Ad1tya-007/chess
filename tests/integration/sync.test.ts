import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChessComClient } from '../../src/clients/chesscom.client.js';
import type { Database } from '../../src/db/client.js';
import { games as gamesTable, syncRuns } from '../../src/db/schema.js';
import { createServices, type Services } from '../../src/services/create-services.js';
import { createLogger } from '../../src/utils/logger.js';
import { archiveGame, buildPgn, fixtures, PLAYER } from '../fixtures/games.js';
import { testConfig } from '../helpers/config.js';
import { createFreshTestDatabase, testDatabaseUrl, truncateAll } from '../helpers/db.js';
import { FakeChessCom } from '../helpers/fake-chesscom.js';
import { json, networkError, status } from '../helpers/fake-fetch.js';

const logger = createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' });
const MONTHS = [7, 8, 9, 10, 11] as const;

function monthGames(month: number, count: number) {
  return Array.from({ length: count }, (_, day) =>
    archiveGame({ endTime: new Date(Date.UTC(2026, month - 1, day + 1, 12)) }),
  );
}

describe.skipIf(!testDatabaseUrl)('SyncService (requires TEST_DATABASE_URL)', () => {
  let database: Database;
  let api: FakeChessCom;
  let services: Services;
  let gamesByMonth: Map<number, ReturnType<typeof monthGames>>;

  beforeAll(async () => {
    database = await createFreshTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll(database);
    api = new FakeChessCom().addPlayer(PLAYER);
    gamesByMonth = new Map(MONTHS.map((month) => [month, monthGames(month, 2)]));
    for (const [month, games] of gamesByMonth) api.setArchive(PLAYER, 2026, month, games);

    const client = new ChessComClient({
      userAgent: 'ChessIntelligenceMCP/test (contact: test@example.com)',
      timeoutMs: 1_000,
      logger,
      maxRetries: 0,
      fetch: api.fetch,
      sleep: () => Promise.resolve(),
    });
    services = createServices(
      testConfig({ MAX_SYNC_MONTHS_PER_CALL: '4', SYNC_COOLDOWN_SECONDS: '0' }),
      database,
      logger,
      {
        chessCom: client,
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await database?.close();
  });

  const countGames = async () => (await database.db.select().from(gamesTable)).length;

  describe('initial mode', () => {
    it('imports the newest unsynced months first and continues further back on later calls', async () => {
      const first = await services.sync.sync({ mode: 'initial', months: 2 });
      expect(first).toMatchObject({
        username: 'testplayer',
        mode: 'initial',
        status: 'success',
        monthsRequested: 2,
        archivesAvailable: 5,
        archivesChecked: 2,
        archivesDownloaded: 2,
        archivesNotModified: 0,
        gamesFetched: 4,
        gamesInserted: 4,
        gamesUpdated: 0,
        gamesSkipped: 0,
        coverage: { from: '2026-10', to: '2026-11' },
        archivesRemaining: 3,
        failures: [],
      });

      const second = await services.sync.sync({ mode: 'initial', months: 2 });
      expect(second.coverage).toEqual({ from: '2026-08', to: '2026-09' });
      expect(second.archivesRemaining).toBe(1);

      const third = await services.sync.sync({ mode: 'initial', months: 2 });
      expect(third.coverage).toEqual({ from: '2026-07', to: '2026-07' });
      expect(third.archivesRemaining).toBe(0);

      const done = await services.sync.sync({ mode: 'initial', months: 2 });
      expect(done).toMatchObject({ archivesChecked: 0, coverage: null, archivesRemaining: 0 });

      expect(await countGames()).toBe(10);
      // Each archive downloaded exactly once.
      for (const month of MONTHS)
        expect(api.countRequests(`/games/2026/${String(month).padStart(2, '0')}`)).toBe(1);
    });

    it('updates the player profile from Chess.com', async () => {
      await services.sync.sync({ mode: 'initial', months: 1 });
      const player = await services.repositories.players.findByUsername(PLAYER);
      expect(player).toMatchObject({
        title: 'FM',
        country: 'US',
        name: 'Test Player',
        profileUrl: 'https://www.chess.com/member/TestPlayer',
      });
      expect(player?.lastProfileSyncAt).toBeInstanceOf(Date);
    });
  });

  describe('incremental mode', () => {
    it('uses ETags so unchanged months are not re-downloaded or duplicated', async () => {
      await services.sync.sync({ mode: 'initial', months: 3 });
      const report = await services.sync.sync({ mode: 'incremental', months: 3 });

      expect(report).toMatchObject({
        status: 'success',
        archivesChecked: 3,
        archivesDownloaded: 0,
        archivesNotModified: 3,
        gamesFetched: 0,
        gamesInserted: 0,
        coverage: { from: '2026-09', to: '2026-11' },
      });
      expect(await countGames()).toBe(6);
    });

    it('inserts new games and updates changed ones without duplicating unchanged ones', async () => {
      await services.sync.sync({ mode: 'incremental', months: 1 });

      const [existing, unchanged] = gamesByMonth.get(11)!;
      const corrected = { ...existing!, white: { ...existing!.white, rating: 1700 } };
      const newGame = archiveGame({ endTime: new Date('2026-11-20T12:00:00Z') });
      api.setArchive(PLAYER, 2026, 11, [corrected, unchanged!, newGame]);

      const report = await services.sync.sync({ mode: 'incremental', months: 1 });
      expect(report).toMatchObject({
        archivesDownloaded: 1,
        gamesFetched: 3,
        gamesInserted: 1,
        gamesUpdated: 1,
        gamesUnchanged: 1,
      });
      expect(await countGames()).toBe(3);
    });

    it('never deletes local games that disappear from an archive', async () => {
      await services.sync.sync({ mode: 'incremental', months: 1 });
      api.setArchive(PLAYER, 2026, 11, []);

      const report = await services.sync.sync({ mode: 'incremental', months: 1 });
      expect(report.archivesDownloaded).toBe(1);
      expect(await countGames()).toBe(2);
    });

    it('defaults to incremental mode and three months', async () => {
      const report = await services.sync.sync();
      expect(report).toMatchObject({ mode: 'incremental', monthsRequested: 3, archivesChecked: 3 });
    });
  });

  describe('bad and skipped data', () => {
    it('stores valid games and reports skipped variants and malformed entries', async () => {
      api.setArchive(PLAYER, 2026, 11, [
        fixtures.whiteWin(),
        fixtures.chess960(),
        { url: 'not a game url', pgn: 'x' },
        archiveGame({
          pgn: buildPgn({ white: PLAYER, black: 'x', result: '1-0', moves: '1. e4 e5 2. Ke3' }),
        }),
      ]);

      const report = await services.sync.sync({ mode: 'incremental', months: 1 });
      expect(report).toMatchObject({
        status: 'success',
        gamesFetched: 3,
        gamesInserted: 2,
        gamesSkipped: 2,
      });
      expect(report.warnings.some((warning) => warning.includes('malformed'))).toBe(true);
      expect(report.warnings.some((warning) => warning.includes('variant'))).toBe(true);
    });
  });

  describe('partial failures', () => {
    it('continues past a failing archive and reports it', async () => {
      api.fail('/games/2026/10', status(500));

      const report = await services.sync.sync({ mode: 'initial', months: 3 });
      expect(report).toMatchObject({
        status: 'partial',
        archivesChecked: 2,
        archivesDownloaded: 2,
        archivesFailed: 1,
        archivesNotAttempted: 0,
        gamesInserted: 4,
        archivesRemaining: 3,
        coverage: { from: '2026-09', to: '2026-11' },
        failures: [{ archive: '2026-10', kind: 'upstream_error' }],
      });

      const run = await services.repositories.syncRuns.latestForPlayer(
        (await services.repositories.players.findByUsername(PLAYER))!.id,
      );
      expect(run).toMatchObject({ status: 'success', archivesChecked: 2, gamesInserted: 4 });
      expect(run?.errorMessage).toContain('2026-10');

      // The failed month is picked up by the next initial run.
      api.clearFailures();
      const retry = await services.sync.sync({ mode: 'initial', months: 1 });
      expect(retry.coverage).toEqual({ from: '2026-10', to: '2026-10' });
    });

    it.each([
      ['rate_limited', status(429, { 'retry-after': '1' })],
      ['network', networkError()],
    ] as const)('stops early when Chess.com is %s', async (kind, responder) => {
      api.fail('/games/2026/10', responder);

      const report = await services.sync.sync({ mode: 'incremental', months: 4 });
      expect(report).toMatchObject({
        status: 'partial',
        archivesChecked: 1,
        archivesFailed: 1,
        archivesNotAttempted: 2,
        failures: [{ archive: '2026-10', kind }],
      });
      expect(api.countRequests('/games/2026/09')).toBe(0);
    });

    it('keeps going when only the profile refresh fails', async () => {
      api.fail(`/player/${PLAYER.toLowerCase()}`, status(503));
      const report = await services.sync.sync({ mode: 'incremental', months: 1 });
      expect(report.status).toBe('success');
      expect(report.gamesInserted).toBe(2);
      expect(report.warnings[0]).toMatch(/^Profile not refreshed/);
    });
  });

  describe('fatal failures', () => {
    it('fails the run for an unknown player', async () => {
      await expect(services.sync.sync({ username: 'ghost-player' })).rejects.toMatchObject({
        code: 'chesscom_not_found',
      });
      const [run] = await database.db.select().from(syncRuns);
      expect(run).toMatchObject({ status: 'failed' });
      expect(run?.finishedAt).toBeInstanceOf(Date);
      expect(run?.errorMessage).toBeTruthy();
    });

    it('fails the run when the archive list is unavailable', async () => {
      api.fail('/games/archives', status(500));
      await expect(services.sync.sync()).rejects.toMatchObject({
        code: 'chesscom_upstream_error',
      });
      const [run] = await database.db.select().from(syncRuns);
      expect(run).toMatchObject({ status: 'failed', archivesChecked: 0 });
    });

    it('fails the run with a generic message on an internal error and leaves the month unsynced', async () => {
      vi.spyOn(services.repositories.games, 'upsertMany').mockRejectedValueOnce(
        new Error('duplicate key value violates constraint games_secret_idx'),
      );

      const error = await services.sync.sync({ months: 1 }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: 'internal_error',
        message: 'Sync failed due to an internal error.',
      });
      const [run] = await database.db.select().from(syncRuns);
      expect(run).toMatchObject({
        status: 'failed',
        errorMessage: 'Sync failed due to an internal error.',
      });

      const player = await services.repositories.players.findByUsername(PLAYER);
      expect(await services.repositories.archives.listForPlayer(player!.id)).toHaveLength(0);
      const retry = await services.sync.sync({ mode: 'initial', months: 1 });
      expect(retry.gamesInserted).toBe(2);
    });

    it('fails the run on an invalid archive list response', async () => {
      api.fail('/games/archives', json({ archives: 'nope' }));
      await expect(services.sync.sync()).rejects.toMatchObject({
        code: 'chesscom_invalid_response',
      });
    });
  });

  describe('input validation', () => {
    it.each([0, 5, 1.5, -1, Number.NaN])('rejects months=%s', async (months) => {
      await expect(services.sync.sync({ months })).rejects.toMatchObject({ code: 'invalid_input' });
      expect(api.requests).toHaveLength(0);
    });

    it('rejects invalid usernames before any request', async () => {
      await expect(services.sync.sync({ username: '../etc/passwd' })).rejects.toMatchObject({
        code: 'invalid_input',
      });
      expect(api.requests).toHaveLength(0);
    });
  });

  describe('overlap protection', () => {
    it('rejects a second sync for the same player while one is running', async () => {
      const gate = api.gate('/games/2026/11');
      const first = services.sync.sync({ mode: 'incremental', months: 1 });
      await gate.reached;

      await expect(services.sync.sync({ mode: 'incremental', months: 1 })).rejects.toMatchObject({
        code: 'sync_in_progress',
      });

      gate.release();
      await expect(first).resolves.toMatchObject({ status: 'success', gamesInserted: 2 });

      // The lock is released afterwards.
      await expect(services.sync.sync({ mode: 'incremental', months: 1 })).resolves.toMatchObject({
        status: 'success',
      });
      const runs = await database.db.select().from(syncRuns);
      expect(runs).toHaveLength(2);
    });

    it('enforces SYNC_COOLDOWN_SECONDS between finished syncs of the same player', async () => {
      let clock = new Date('2026-11-18T12:00:00Z');
      const cooled = createServices(testConfig({ SYNC_COOLDOWN_SECONDS: '30' }), database, logger, {
        chessCom: services.chessCom,
        now: () => clock,
      });

      await cooled.sync.sync({ months: 1 });
      clock = new Date('2026-11-18T12:00:10Z');
      await expect(cooled.sync.sync({ months: 1 })).rejects.toMatchObject({
        code: 'sync_cooldown',
        message:
          'A sync for "testplayer" finished moments ago. Wait 20 seconds before syncing again.',
      });
      // Other players are unaffected.
      api.addPlayer('other_player').setArchive('other_player', 2026, 11, [fixtures.draw()]);
      await expect(
        cooled.sync.sync({ username: 'other_player', months: 1 }),
      ).resolves.toMatchObject({ status: 'success' });

      clock = new Date('2026-11-18T12:00:31Z');
      await expect(cooled.sync.sync({ months: 1 })).resolves.toMatchObject({ status: 'success' });
      expect(await database.db.select().from(syncRuns)).toHaveLength(3);
    });

    it('allows concurrent syncs for different players', async () => {
      // HTTP requests are still serialized process-wide by the client; only the locks are separate.
      api.addPlayer('other_player').setArchive('other_player', 2026, 11, [fixtures.draw()]);
      const reports = await Promise.all([
        services.sync.sync({ months: 1 }),
        services.sync.sync({ username: 'other_player', months: 1 }),
      ]);
      expect(reports.map((report) => report.status)).toEqual(['success', 'success']);
    });

    it('marks runs left "running" by a crashed process as failed', async () => {
      const player = await services.repositories.players.getOrCreate(PLAYER);
      const [stale] = await database.db
        .insert(syncRuns)
        .values({ playerId: player.id, status: 'running' })
        .returning();

      await services.sync.sync({ months: 1 });

      const [row] = await database.db.select().from(syncRuns).where(eq(syncRuns.id, stale!.id));
      expect(row).toMatchObject({ status: 'failed' });
      expect(row?.errorMessage).toMatch(/Interrupted/);
      expect(row?.finishedAt).toBeInstanceOf(Date);
    });
  });

  it('persists sync-run counters that match the report', async () => {
    const report = await services.sync.sync({ mode: 'initial', months: 2 });
    const [run] = await database.db
      .select()
      .from(syncRuns)
      .where(eq(syncRuns.id, report.syncRunId));
    expect(run).toMatchObject({
      status: 'success',
      archivesChecked: report.archivesChecked,
      gamesSeen: report.gamesFetched,
      gamesInserted: report.gamesInserted,
      gamesUpdated: report.gamesUpdated,
      errorMessage: null,
    });
    expect(run?.finishedAt).toEqual(report.finishedAt);
  });
});
