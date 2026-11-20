import { sql } from 'drizzle-orm';

import { createDatabase, runMigrations, type Database } from '../../src/db/client.js';
import { createLogger } from '../../src/utils/logger.js';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Connects to TEST_DATABASE_URL, drops everything, and applies all migrations from scratch.
 * Refuses to run against anything but a dedicated *_test database.
 */
export async function createFreshTestDatabase(): Promise<Database> {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set.');
  const databaseName = new URL(testDatabaseUrl).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must point at a *_test database, got "${databaseName}".`);
  }

  const database = createDatabase(
    testDatabaseUrl,
    createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }),
  );
  await database.db.execute(sql`drop schema if exists drizzle cascade`);
  await database.db.execute(sql`drop schema if exists public cascade`);
  await database.db.execute(sql`create schema public`);
  await runMigrations(database.db);
  return database;
}

export async function truncateAll(database: Database): Promise<void> {
  await database.db.execute(
    sql`truncate table games, sync_runs, chesscom_archives, players restart identity cascade`,
  );
}
