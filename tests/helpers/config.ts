import { loadConfig, type Config } from '../../src/config/env.js';

export const BASE_TEST_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  HOST: '127.0.0.1',
  PORT: '3000',
  CHESSCOM_USERNAME: 'TestPlayer',
  CHESSCOM_USER_AGENT: 'ChessIntelligenceMCP/test (contact: test@example.com)',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/unused',
} as const;

export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({ ...BASE_TEST_ENV, ...overrides });
}
