import { requireBearerAuth } from '@modelcontextprotocol/express';
import type { RequestHandler } from 'express';

import type { Config } from '../config/env.js';
import { createIpAllowlist } from '../utils/ip-allowlist.js';
import type { Logger } from '../utils/logger.js';
import { createStaticTokenVerifier } from './auth.js';

/**
 * Gate for /mcp, evaluated before the MCP handler runs:
 * 1. A client IP inside MCP_ALLOWED_CLIENT_IPS is admitted (e.g. Anthropic's connector egress).
 * 2. Otherwise a valid `Authorization: Bearer <MCP_AUTH_TOKEN>` is admitted.
 * 3. With neither configured the endpoint is open (config validation only permits that on
 *    loopback or with MCP_ALLOW_UNAUTHENTICATED=true).
 * Anything else is rejected: 401 with a Bearer challenge when a token is configured, else 403.
 */
export function createAccessControl(config: Config, logger: Logger): RequestHandler {
  const allowlist = createIpAllowlist(config.MCP_ALLOWED_CLIENT_IPS);
  const bearer = config.MCP_AUTH_TOKEN
    ? requireBearerAuth({ verifier: createStaticTokenVerifier(config.MCP_AUTH_TOKEN) })
    : null;

  if (allowlist.ranges.length === 0 && !bearer) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    if (allowlist.allows(req.ip)) {
      next();
      return;
    }
    if (bearer) {
      void bearer(req, res, next);
      return;
    }
    logger.warn({ ip: req.ip }, 'Rejected /mcp request from a client IP outside the allowlist');
    res.status(403).json({ error: 'forbidden' });
  };
}
