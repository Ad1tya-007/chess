import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { archiveGamesSchema } from '../../src/clients/chesscom.schemas.js';
import type { Database } from '../../src/db/client.js';
import { normalizeArchiveGame, normalizeArchiveGames } from '../../src/domain/game-normalizer.js';
import type { NormalizedGame } from '../../src/domain/game.types.js';
import { ArchiveRepository } from '../../src/repositories/archive.repository.js';
import { GameRepository } from '../../src/repositories/game.repository.js';
import { PlayerRepository } from '../../src/repositories/player.repository.js';
import { fixture } from '../helpers/fake-fetch.js';
import { createFreshTestDatabase, testDatabaseUrl, truncateAll } from '../helpers/db.js';
import { archiveGame, fixtures, PLAYER } from '../fixtures/games.js';

function normalized(game = fixtures.whiteWin(), username = PLAYER): NormalizedGame {
  const outcome = normalizeArchiveGame(game, username);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.game;
}

describe.skipIf(!testDatabaseUrl)('repositories (requires TEST_DATABASE_URL)', () => {
  let database: Database;
  let players: PlayerRepository;
  let games: GameRepository;
  let archives: ArchiveRepository;

  beforeAll(async () => {
    database = await createFreshTestDatabase();
    players = new PlayerRepository(database.db);
    games = new GameRepository(database.db);
    archives = new ArchiveRepository(database.db);
  });

  beforeEach(async () => {
    await truncateAll(database);
  });

  afterAll(async () => {
    await database?.close();
  });

  describe('PlayerRepository', () => {
    it('creates a player once, normalizing the username', async () => {
      const first = await players.getOrCreate('TestPlayer');
      const second = await players.getOrCreate(' testplayer ');

      expect(first.chesscomUsername).toBe('testplayer');
      expect(second.id).toBe(first.id);
    });

    it('handles concurrent creation of the same player', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => players.getOrCreate('racer')),
      );
      expect(new Set(results.map((player) => player.id)).size).toBe(1);
    });

    it('rejects invalid usernames', async () => {
      await expect(players.getOrCreate('bad name')).rejects.toMatchObject({
        code: 'invalid_input',
      });
    });

    it('updates profile fields and the profile sync time', async () => {
      const player = await players.getOrCreate('testplayer');
      const syncedAt = new Date('2026-11-18T12:00:00Z');
      const updated = await players.updateProfile(
        player.id,
        {
          profileUrl: 'https://www.chess.com/member/TestPlayer',
          country: 'US',
          title: null,
          name: 'Test Player',
          joinedAt: new Date('2010-01-01T00:00:00Z'),
        },
        syncedAt,
      );
      expect(updated).toMatchObject({
        country: 'US',
        name: 'Test Player',
        lastProfileSyncAt: syncedAt,
      });
    });
  });

  describe('GameRepository.upsertMany', () => {
    it('inserts new games and round-trips every field', async () => {
      const player = await players.getOrCreate(PLAYER);
      const input = [normalized(fixtures.whiteWin()), normalized(fixtures.missingRatings())];

      expect(await games.upsertMany(player.id, input)).toEqual({
        inserted: 2,
        updated: 0,
        unchanged: 0,
      });

      const stored = await games.findByUrl(player.id, input[0]!.chesscomGameUrl);
      expect(stored).toMatchObject({ ...input[0], playerId: player.id });
      const missing = await games.findByUrl(player.id, input[1]!.chesscomGameUrl);
      expect(missing).toMatchObject({
        whiteRating: null,
        blackRating: null,
        rated: null,
        eco: null,
      });
    });

    it('is idempotent: syncing the same games again changes nothing', async () => {
      const player = await players.getOrCreate(PLAYER);
      const input = [
        normalized(fixtures.whiteWin()),
        normalized(fixtures.blackWin()),
        normalized(fixtures.draw()),
      ];
      await games.upsertMany(player.id, input);
      const before = await database.db.execute<{ updated_at: Date }>(
        sql`select updated_at from games order by chesscom_game_url`,
      );

      const second = await games.upsertMany(player.id, input);

      expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 3 });
      expect(await games.countForPlayer(player.id)).toBe(3);
      const after = await database.db.execute<{ updated_at: Date }>(
        sql`select updated_at from games order by chesscom_game_url`,
      );
      expect(after.rows).toEqual(before.rows);
    });

    it('updates a game whose content changed upstream', async () => {
      const player = await players.getOrCreate(PLAYER);
      const original = normalized();
      await games.upsertMany(player.id, [original]);

      const corrected = { ...original, opponentRating: 1700, blackRating: 1700 };
      expect(await games.upsertMany(player.id, [corrected])).toEqual({
        inserted: 0,
        updated: 1,
        unchanged: 0,
      });
      expect((await games.findByUrl(player.id, original.chesscomGameUrl))?.opponentRating).toBe(
        1700,
      );
    });

    it('de-duplicates repeated games within one batch', async () => {
      const player = await players.getOrCreate(PLAYER);
      const game = normalized();
      expect(await games.upsertMany(player.id, [game, { ...game }])).toEqual({
        inserted: 1,
        updated: 0,
        unchanged: 0,
      });
    });

    it('stores the same game separately for each synced player, each from their perspective', async () => {
      const raw = fixtures.whiteWin();
      const me = await players.getOrCreate(PLAYER);
      const opponent = await players.getOrCreate('opponent');

      await games.upsertMany(me.id, [normalized(raw, PLAYER)]);
      await games.upsertMany(opponent.id, [normalized(raw, 'opponent')]);

      expect(await games.findByUrl(me.id, raw.url)).toMatchObject({
        result: 'win',
        playerColor: 'white',
      });
      expect(await games.findByUrl(opponent.id, raw.url)).toMatchObject({
        result: 'loss',
        playerColor: 'black',
      });
    });

    it('handles batches larger than one insert chunk', async () => {
      const player = await players.getOrCreate(PLAYER);
      const input = Array.from({ length: 1_201 }, () => normalized(archiveGame()));

      expect(await games.upsertMany(player.id, input)).toEqual({
        inserted: 1_201,
        updated: 0,
        unchanged: 0,
      });
      expect(await games.upsertMany(player.id, input)).toEqual({
        inserted: 0,
        updated: 0,
        unchanged: 1_201,
      });
    });

    it('rolls back the whole batch when any row fails', async () => {
      const player = await players.getOrCreate(PLAYER);
      const good = normalized();
      const bad = { ...normalized(), result: 'forfeit' as NormalizedGame['result'] };

      await expect(games.upsertMany(player.id, [good, bad])).rejects.toThrow();
      expect(await games.countForPlayer(player.id)).toBe(0);
    });

    it('persists a mocked Chess.com archive end to end (parse, normalize, upsert)', async () => {
      const player = await players.getOrCreate('testplayer');
      const archive = archiveGamesSchema.parse(fixture('archive-games.json'));
      const { games: normalizedGames } = normalizeArchiveGames(archive.games, 'testplayer');

      const first = await games.upsertMany(player.id, normalizedGames);
      const again = await games.upsertMany(player.id, normalizedGames);

      expect(first.inserted).toBe(3);
      expect(again).toEqual({ inserted: 0, updated: 0, unchanged: 3 });
    });
  });

  describe('ArchiveRepository.recordCheck', () => {
    it('records a downloaded archive and keeps validators across 304 checks', async () => {
      const player = await players.getOrCreate(PLAYER);
      const month = { year: 2026, month: 11 };
      const downloadedAt = new Date('2026-11-18T10:00:00Z');
      const checkedAt = new Date('2026-11-18T11:00:00Z');

      await archives.recordCheck(player.id, month, {
        changed: true,
        etag: 'W/"v1"',
        lastModified: 'Tue, 17 Nov 2026 01:43:42 GMT',
        checkedAt: downloadedAt,
        gamesCount: 344,
      });
      const afterNotModified = await archives.recordCheck(player.id, month, {
        changed: false,
        etag: null,
        lastModified: null,
        checkedAt,
      });

      expect(afterNotModified).toMatchObject({
        etag: 'W/"v1"',
        lastModified: 'Tue, 17 Nov 2026 01:43:42 GMT',
        lastCheckedAt: checkedAt,
        lastChangedAt: downloadedAt,
        gamesCount: 344,
      });
      expect(await archives.listForPlayer(player.id)).toHaveLength(1);
    });

    it('replaces validators and counts when the archive changed', async () => {
      const player = await players.getOrCreate(PLAYER);
      const month = { year: 2026, month: 10 };
      await archives.recordCheck(player.id, month, {
        changed: true,
        etag: 'W/"v1"',
        lastModified: null,
        checkedAt: new Date('2026-11-01T00:00:00Z'),
        gamesCount: 10,
      });
      const changedAt = new Date('2026-11-02T00:00:00Z');
      const row = await archives.recordCheck(player.id, month, {
        changed: true,
        etag: 'W/"v2"',
        lastModified: null,
        checkedAt: changedAt,
        gamesCount: 12,
      });

      expect(row).toMatchObject({ etag: 'W/"v2"', gamesCount: 12, lastChangedAt: changedAt });
      expect(await archives.find(player.id, month)).toMatchObject({ etag: 'W/"v2"' });
    });

    it('rejects out-of-range months at the database level', async () => {
      const player = await players.getOrCreate(PLAYER);
      await expect(
        archives.recordCheck(
          player.id,
          { year: 2026, month: 13 },
          {
            changed: false,
            etag: null,
            lastModified: null,
            checkedAt: new Date(),
          },
        ),
      ).rejects.toThrow();
    });
  });
});
