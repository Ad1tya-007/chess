import type { Server } from 'node:http';

import {
  ConfigError,
  describeAccess,
  isLoopbackHost,
  loadConfig,
  type Config,
} from './config/env.js';
import { createDatabase } from './db/client.js';
import { HEALTH_PATH, MCP_PATH, createHttpApp } from './server/transport.js';
import { createServices } from './services/create-services.js';
import { createLogger } from './utils/logger.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\nSee .env.example for every supported variable.\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = loadConfigOrExit();
const logger = createLogger(config);
const database = createDatabase(config.DATABASE_URL, logger);
const services = createServices(config, database, logger);
const httpApp = createHttpApp({
  config,
  logger,
  services,
  checkDatabase: () => database.ping(),
});

const server: Server = httpApp.app.listen(config.PORT, config.HOST, () => {
  logger.info(
    {
      host: config.HOST,
      port: config.PORT,
      mcpPath: MCP_PATH,
      healthPath: HEALTH_PATH,
      access: describeAccess(config),
      allowedClientIps: config.MCP_ALLOWED_CLIENT_IPS,
      usernames: config.MCP_ALLOW_ANY_USERNAME ? 'any' : config.CHESSCOM_USERNAME,
      rateLimitPerMinute: config.MCP_RATE_LIMIT_PER_MINUTE,
      trustProxy: config.TRUST_PROXY,
    },
    'Chess Intelligence MCP server listening',
  );
  if (describeAccess(config) === 'open') {
    logger.warn(
      isLoopbackHost(config.HOST)
        ? 'The /mcp endpoint is open. Do not expose this server beyond localhost.'
        : 'The /mcp endpoint is open to anyone who knows its URL (MCP_ALLOW_UNAUTHENTICATED=true).',
    );
  }
});

server.on('error', (error) => {
  logger.fatal({ err: { message: error.message } }, 'HTTP server failed');
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    await httpApp.close();
    server.closeIdleConnections();
    await serverClosed;
    await database.close();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: { message: (error as Error).message } }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', (signal) => void shutdown(signal));
process.on('SIGTERM', (signal) => void shutdown(signal));
