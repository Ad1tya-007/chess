import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';

import { APP_NAME, APP_VERSION } from '../config/app-info.js';
import type { Config } from '../config/env.js';
import type { Services } from '../services/create-services.js';
import type { Logger } from '../utils/logger.js';
import { createAccessControl } from './access.js';
import { createServer } from './create-server.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/health';
const MAX_JSON_BODY = '64kb';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface HttpAppDependencies {
  config: Config;
  logger: Logger;
  services: Services;
  checkDatabase: () => Promise<boolean>;
}

export interface HttpApp {
  app: Express;
  /** Aborts in-flight MCP exchanges. Call during graceful shutdown. */
  close(): Promise<void>;
}

function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', id);
  return id;
}

export function createHttpApp({
  config,
  logger,
  services,
  checkDatabase,
}: HttpAppDependencies): HttpApp {
  const app = express();
  app.disable('x-powered-by');
  // Number of reverse-proxy hops to trust for X-Forwarded-For; 0 uses the socket address.
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: requestId,
      // Log only what is needed to trace a request; never headers or bodies.
      serializers: {
        req: (req: IncomingMessage & { id?: unknown }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === HEALTH_PATH },
    }),
  );

  // Mounted outside the MCP sub-app so platform health checkers are not subject to Host validation.
  app.get(HEALTH_PATH, (async (_req, res) => {
    const databaseOk = await checkDatabase();
    res.status(databaseOk ? 200 : 503).json({
      status: databaseOk ? 'ok' : 'degraded',
      service: APP_NAME,
      version: APP_VERSION,
      checks: { database: databaseOk ? 'ok' : 'unreachable' },
      time: new Date().toISOString(),
    });
  }) as RequestHandler);

  const mcpApp = createMcpExpressApp({
    host: config.HOST,
    ...(config.MCP_ALLOWED_HOSTS.length > 0 ? { allowedHosts: config.MCP_ALLOWED_HOSTS } : {}),
    jsonLimit: MAX_JSON_BODY,
  });

  const handler = createMcpHandler(() => createServer({ config, logger, services }));
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => {
      logger.error({ err: { message: error.message } }, 'MCP handler error');
    },
  });

  const mcpRoute: RequestHandler = (req, res) => void nodeHandler(req, res, req.body);
  mcpApp.all(MCP_PATH, mcpRoute);

  // Rate limiting and access control run on the outer app, which owns the trust-proxy setting
  // that req.ip depends on, and before the MCP sub-app parses the body.
  if (config.MCP_RATE_LIMIT_PER_MINUTE > 0) {
    app.use(
      MCP_PATH,
      rateLimit({
        windowMs: 60_000,
        limit: config.MCP_RATE_LIMIT_PER_MINUTE,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res) => {
          req.log.warn({ ip: req.ip }, 'Rate limit exceeded on /mcp');
          res.status(429).json({ error: 'rate_limited' });
        },
      }),
    );
  }
  app.use(MCP_PATH, createAccessControl(config, logger));
  app.use(mcpApp);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    const type = (error as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
      return;
    }
    req.log.error({ err: { message: (error as Error)?.message } }, 'Unhandled HTTP error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error' });
    }
  };
  app.use(errorHandler);

  return { app, close: () => handler.close() };
}
