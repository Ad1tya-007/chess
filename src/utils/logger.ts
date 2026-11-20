import { pino, type Logger } from 'pino';

import type { Config } from '../config/env.js';

export type { Logger };

export function createLogger(
  config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>,
  destination: pino.DestinationStream = pino.destination(1),
): Logger {
  return pino(
    {
      level: config.LOG_LEVEL,
      base: { service: 'chess-intelligence-mcp' },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Defense in depth: request logging never serializes headers, but redact anyway.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          'authorization',
          'token',
          '*.token',
          'pgn',
          '*.pgn',
        ],
        censor: '[redacted]',
      },
    },
    destination,
  );
}
