import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations, type Database } from '../../src/db/client.js';
import { createFreshTestDatabase, testDatabaseUrl } from '../helpers/db.js';

describe.skipIf(!testDatabaseUrl)('database migrations (requires TEST_DATABASE_URL)', () => {
  let database: Database;

  beforeAll(async () => {
    database = await createFreshTestDatabase();
  });

  afterAll(async () => {
    await database?.close();
  });

  it('applies cleanly to an empty database and is idempotent', async () => {
    await runMigrations(database.db);

    const tables = await database.db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'chesscom_archives',
      'games',
      'players',
      'sync_runs',
    ]);
  });

  it('creates the indexes required for game queries', async () => {
    const indexes = await database.db.execute<{ indexname: string }>(sql`
      select indexname from pg_indexes where schemaname = 'public' and tablename = 'games'`);
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'games_player_game_url_key',
        'games_player_played_at_idx',
        'games_player_time_class_played_at_idx',
        'games_player_color_idx',
        'games_player_eco_idx',
      ]),
    );
    expect(names).not.toContain('games_chesscom_game_url_key');
  });

  it('reports a healthy ping', async () => {
    expect(await database.ping()).toBe(true);
  });

  it('enforces lowercase normalized usernames', async () => {
    await expect(
      database.db.execute(sql`insert into players (chesscom_username) values ('MixedCase')`),
    ).rejects.toThrow();
    await database.db.execute(sql`insert into players (chesscom_username) values ('lowercase')`);
  });
});
