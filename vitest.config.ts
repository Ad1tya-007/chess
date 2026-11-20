import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { defineConfig } from 'vitest/config';

// Only TEST_DATABASE_URL is taken from .env; tests build their own app config explicitly.
const dotenv = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? dotenv.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: testDatabaseUrl ? { TEST_DATABASE_URL: testDatabaseUrl } : {},
    // Database integration tests share one database; run files sequentially.
    fileParallelism: false,
  },
});
