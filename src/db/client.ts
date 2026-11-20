import { fileURLToPath } from 'node:url';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import type { Logger } from '../utils/logger.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];
/** Either the pool-backed database or an open transaction. */
export type DbExecutor = Db | DbTransaction;

export interface Database {
  db: Db;
  /** Lightweight connectivity check for /health. Never throws. */
  ping(timeoutMs?: number): Promise<boolean>;
  /**
   * Runs `task` while holding a PostgreSQL session advisory lock on (namespace, key), or returns
   * `{ acquired: false }` immediately if another session holds it. The lock lives on a dedicated
   * connection, so it is released automatically if the process dies.
   */
  tryWithAdvisoryLock<T>(
    namespace: number,
    key: string,
    task: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }>;
  close(): Promise<void>;
}

// SQL migrations are not compiled by tsc, so both src/db and dist/db point back at src/db/migrations.
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../src/db/migrations', import.meta.url));

export function createDatabase(connectionString: string, logger: Logger): Database {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

  pool.on('error', (error) => {
    logger.error({ err: { message: error.message } }, 'Idle PostgreSQL client error');
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    async ping(timeoutMs = 2_000) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Database ping timed out')), timeoutMs);
        });
        await Promise.race([pool.query('select 1'), timeout]);
        return true;
      } catch (error) {
        logger.warn({ err: { message: (error as Error).message } }, 'Database ping failed');
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async tryWithAdvisoryLock(namespace, key, task) {
      const client = await pool.connect();
      let releaseError: Error | undefined;
      try {
        const { rows } = await client.query<{ locked: boolean }>(
          'select pg_try_advisory_lock($1, hashtext($2)) as locked',
          [namespace, key],
        );
        if (!rows[0]?.locked) return { acquired: false };
        try {
          return { acquired: true, value: await task() };
        } finally {
          await client
            .query('select pg_advisory_unlock($1, hashtext($2))', [namespace, key])
            .catch((error: Error) => {
              // Destroying the connection releases the lock server-side.
              releaseError = error;
            });
        }
      } finally {
        client.release(releaseError);
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
