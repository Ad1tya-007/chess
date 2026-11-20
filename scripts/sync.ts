/**
 * Local CLI sync for development. Usage:
 *   npm run sync -- [--mode initial|incremental] [--months N] [--username NAME]
 */
import { parseArgs } from 'node:util';

import { pino } from 'pino';

import { ConfigError, loadConfig } from '../src/config/env.js';
import { createDatabase } from '../src/db/client.js';
import { createServices } from '../src/services/create-services.js';
import { AppError } from '../src/utils/errors.js';
import { createLogger } from '../src/utils/logger.js';

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'incremental' },
    months: { type: 'string' },
    username: { type: 'string' },
  },
});

if (values.mode !== 'initial' && values.mode !== 'incremental') {
  process.stderr.write('--mode must be "initial" or "incremental".\n');
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

// Logs go to stderr so stdout carries only the JSON report.
const logger = createLogger({ LOG_LEVEL: 'warn', NODE_ENV: config.NODE_ENV }, pino.destination(2));
const database = createDatabase(config.DATABASE_URL, logger);
const services = createServices(config, database, logger);

try {
  const report = await services.sync.sync({
    mode: values.mode,
    ...(values.months !== undefined ? { months: Number(values.months) } : {}),
    ...(values.username !== undefined ? { username: values.username } : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `Sync failed: ${error instanceof AppError ? error.message : (error as Error).message}\n`,
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
