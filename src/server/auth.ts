import { createHash, timingSafeEqual } from 'node:crypto';

import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

const STATIC_TOKEN_CLIENT_ID = 'static-bearer-token';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Verifies a single pre-shared bearer token (MCP_AUTH_TOKEN). Comparing SHA-256 digests keeps the
 * comparison constant-time regardless of the presented token's length.
 */
export function createStaticTokenVerifier(expectedToken: string): OAuthTokenVerifier {
  const expectedDigest = digest(expectedToken);

  return {
    verifyAccessToken(token) {
      if (!timingSafeEqual(digest(token), expectedDigest)) {
        return Promise.reject(new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid access token'));
      }
      // requireBearerAuth rejects tokens without an expiry; a static token is valid per request.
      return Promise.resolve({
        token,
        clientId: STATIC_TOKEN_CLIENT_ID,
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      });
    },
  };
}
