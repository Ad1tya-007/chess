import * as z from 'zod/v4';

import { createLogger } from '../utils/logger.js';
import { createDatabase, runMigrations } from './client.js';

// Migrations only need a database connection, so validate just that instead of the full app config.
const env = z
  .object({
    DATABASE_URL: z.string({ error: 'DATABASE_URL is required to run migrations.' }).min(1),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .safeParse(process.env);

if (!env.success) {
  process.stderr.write(`${env.error.issues.map((issue) => issue.message).join('\n')}\n`);
  process.exit(1);
}

const logger = createLogger({ LOG_LEVEL: env.data.LOG_LEVEL, NODE_ENV: 'development' });
const database = createDatabase(env.data.DATABASE_URL, logger);

try {
  logger.info('Applying database migrations');
  await runMigrations(database.db);
  logger.info('Database migrations applied');
} catch (error) {
  logger.error({ err: { message: (error as Error).message } }, 'Database migration failed');
  process.exitCode = 1;
} finally {
  await database.close();
}
