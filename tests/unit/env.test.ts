import { describe, expect, it } from 'vitest';

import { ConfigError, describeAccess, loadConfig } from '../../src/config/env.js';
import { BASE_TEST_ENV, testConfig } from '../helpers/config.js';

const TOKEN = 'a'.repeat(64);

function issuesFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig({
      CHESSCOM_USERNAME: 'player',
      CHESSCOM_USER_AGENT: BASE_TEST_ENV.CHESSCOM_USER_AGENT,
      DATABASE_URL: BASE_TEST_ENV.DATABASE_URL,
    });

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      LOG_LEVEL: 'info',
      REQUEST_TIMEOUT_MS: 10000,
      MAX_SYNC_MONTHS_PER_CALL: 12,
      DEFAULT_GAME_LIMIT: 20,
      MCP_ALLOWED_HOSTS: [],
    });
    expect(config.MCP_AUTH_TOKEN).toBeUndefined();
  });

  it('normalizes the Chess.com username to lowercase', () => {
    expect(testConfig({ CHESSCOM_USERNAME: '  Hikaru ' }).CHESSCOM_USERNAME).toBe('hikaru');
  });

  it('treats empty strings as unset', () => {
    const config = testConfig({ MCP_AUTH_TOKEN: '', PORT: '', MCP_ALLOWED_HOSTS: '' });
    expect(config.MCP_AUTH_TOKEN).toBeUndefined();
    expect(config.PORT).toBe(3000);
    expect(config.MCP_ALLOWED_HOSTS).toEqual([]);
  });

  it('reports every missing required variable with an actionable message', () => {
    const issues = issuesFor({});
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CHESSCOM_USERNAME'),
        expect.stringContaining('CHESSCOM_USER_AGENT'),
        expect.stringContaining('DATABASE_URL'),
      ]),
    );
  });

  it.each([
    ['CHESSCOM_USERNAME', 'bad name!'],
    ['CHESSCOM_USERNAME', '../etc'],
    ['DATABASE_URL', 'mysql://localhost/db'],
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['MAX_SYNC_MONTHS_PER_CALL', '0'],
    ['DEFAULT_GAME_LIMIT', '101'],
    ['MCP_AUTH_TOKEN', 'too-short'],
    ['NODE_ENV', 'staging'],
  ])('rejects invalid %s=%j', (key, value) => {
    expect(issuesFor({ ...BASE_TEST_ENV, [key]: value })).toEqual([expect.stringContaining(key)]);
  });

  it('requires a token and allowed hosts when binding beyond loopback', () => {
    const issues = issuesFor({ ...BASE_TEST_ENV, HOST: '0.0.0.0' });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('MCP_AUTH_TOKEN'),
        expect.stringContaining('MCP_ALLOWED_HOSTS'),
      ]),
    );
  });

  it('requires a token in production even on loopback', () => {
    expect(issuesFor({ ...BASE_TEST_ENV, NODE_ENV: 'production' })).toEqual([
      expect.stringContaining('MCP_AUTH_TOKEN'),
    ]);
  });

  it('accepts a public bind with a token and allowed hosts', () => {
    const config = testConfig({
      HOST: '0.0.0.0',
      NODE_ENV: 'production',
      MCP_AUTH_TOKEN: TOKEN,
      MCP_ALLOWED_HOSTS: 'Chess.Example.com, other.example.com ,',
    });
    expect(config.MCP_ALLOWED_HOSTS).toEqual(['chess.example.com', 'other.example.com']);
  });

  it('defaults the hardening settings', () => {
    expect(testConfig()).toMatchObject({
      MCP_ALLOWED_CLIENT_IPS: [],
      MCP_ALLOW_UNAUTHENTICATED: false,
      MCP_ALLOW_ANY_USERNAME: false,
      MCP_RATE_LIMIT_PER_MINUTE: 120,
      TRUST_PROXY: 0,
      SYNC_COOLDOWN_SECONDS: 30,
    });
  });

  it.each([
    ['MCP_ALLOWED_CLIENT_IPS', 'anthropic.com'],
    ['MCP_ALLOWED_CLIENT_IPS', '160.79.104.0/40'],
    ['MCP_ALLOW_UNAUTHENTICATED', 'maybe'],
    ['MCP_ALLOW_ANY_USERNAME', 'sure'],
    ['MCP_RATE_LIMIT_PER_MINUTE', '-1'],
    ['TRUST_PROXY', '11'],
    ['SYNC_COOLDOWN_SECONDS', '3601'],
  ])('rejects invalid %s=%j', (key, value) => {
    expect(issuesFor({ ...BASE_TEST_ENV, [key]: value })).toEqual([expect.stringContaining(key)]);
  });

  it('accepts a public bind restricted to Anthropic client IPs (Claude.ai, no sign-in)', () => {
    const config = testConfig({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      MCP_ALLOWED_HOSTS: 'chess.example.com',
      MCP_ALLOWED_CLIENT_IPS: '160.79.104.0/21, 153.61.208.0/20',
      TRUST_PROXY: '1',
    });
    expect(config.MCP_ALLOWED_CLIENT_IPS).toEqual(['160.79.104.0/21', '153.61.208.0/20']);
    expect(config.MCP_AUTH_TOKEN).toBeUndefined();
    expect(describeAccess(config)).toBe('client-ip-allowlist');
  });

  it('accepts a fully open public server only with an explicit opt-in', () => {
    const env = { ...BASE_TEST_ENV, HOST: '0.0.0.0', MCP_ALLOWED_HOSTS: 'chess.example.com' };
    expect(issuesFor(env)).toEqual([expect.stringContaining('MCP_ALLOW_UNAUTHENTICATED')]);
    const config = testConfig({ ...env, MCP_ALLOW_UNAUTHENTICATED: 'true' });
    expect(describeAccess(config)).toBe('open');
  });

  it('refuses MCP_ALLOW_ANY_USERNAME on an open public server', () => {
    const env = {
      ...BASE_TEST_ENV,
      HOST: '0.0.0.0',
      MCP_ALLOWED_HOSTS: 'chess.example.com',
      MCP_ALLOW_UNAUTHENTICATED: 'true',
      MCP_ALLOW_ANY_USERNAME: 'true',
    };
    expect(issuesFor(env)).toEqual([expect.stringContaining('MCP_ALLOW_ANY_USERNAME')]);
    expect(issuesFor({ ...env, MCP_AUTH_TOKEN: TOKEN })).toEqual([]);
    expect(issuesFor({ ...BASE_TEST_ENV, MCP_ALLOW_ANY_USERNAME: 'true' })).toEqual([]);
  });

  it('describes combined access modes', () => {
    const config = testConfig({ MCP_AUTH_TOKEN: TOKEN, MCP_ALLOWED_CLIENT_IPS: '10.0.0.0/8' });
    expect(describeAccess(config)).toBe('client-ip-allowlist+bearer-token');
    expect(describeAccess(testConfig())).toBe('open');
  });

  it('never includes secret values in error messages', () => {
    const secretUrl = 'mysql://user:supersecret@host/db';
    const issues = issuesFor({ ...BASE_TEST_ENV, DATABASE_URL: secretUrl, HOST: '0.0.0.0' });
    expect(issues.join('\n')).not.toContain('supersecret');
  });
});
