import * as z from 'zod/v4';

import { CHESSCOM_USERNAME_PATTERN } from '../utils/chesscom-username.js';
import { parseCidr } from '../utils/ip-allowlist.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const intFromEnv = (min: number, max: number, fallback: number) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));

const csvList = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0)
        : [],
    ),
);

const booleanFlag = z.preprocess(
  (value) => {
    const normalized = emptyToUndefined(value);
    if (typeof normalized !== 'string') return normalized;
    const lower = normalized.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(lower)) return true;
    if (['false', '0', 'no'].includes(lower)) return false;
    return normalized;
  },
  z.boolean({ error: 'Use true or false.' }).default(false),
);

const cidrList = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        : [],
    )
    .refine((ranges) => ranges.every((range) => parseCidr(range) !== null), {
      error: 'Use comma-separated CIDR ranges, e.g. 160.79.104.0/21,153.61.208.0/20.',
    }),
);

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      z.enum(['development', 'test', 'production']).default('development'),
    ),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ),
    PORT: intFromEnv(1, 65535, 3000),
    HOST: z.preprocess(emptyToUndefined, z.string().min(1).default('127.0.0.1')),

    CHESSCOM_USERNAME: z
      .string({ error: 'CHESSCOM_USERNAME is required (your public Chess.com username).' })
      .trim()
      .regex(CHESSCOM_USERNAME_PATTERN, {
        error: 'CHESSCOM_USERNAME may contain only letters, digits, "_" and "-".',
      })
      .transform((value) => value.toLowerCase()),
    CHESSCOM_USER_AGENT: z
      .string({
        error:
          'CHESSCOM_USER_AGENT is required, e.g. "ChessIntelligenceMCP/1.0 (contact: you@example.com)".',
      })
      .trim()
      .min(10, { error: 'CHESSCOM_USER_AGENT should identify the app and a contact address.' })
      .max(200),

    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required, e.g. postgresql://user:pass@host:5432/db.' })
      .refine((value) => /^postgres(ql)?:\/\//.test(value), {
        error: 'DATABASE_URL must be a postgres:// or postgresql:// connection string.',
      }),

    MCP_AUTH_TOKEN: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .min(32, { error: 'MCP_AUTH_TOKEN must be at least 32 characters when set.' })
        .optional(),
    ),
    MCP_ALLOWED_HOSTS: csvList,
    MCP_ALLOWED_CLIENT_IPS: cidrList,
    MCP_ALLOW_UNAUTHENTICATED: booleanFlag,
    MCP_ALLOW_ANY_USERNAME: booleanFlag,
    MCP_RATE_LIMIT_PER_MINUTE: intFromEnv(0, 10_000, 120),
    TRUST_PROXY: intFromEnv(0, 10, 0),

    REQUEST_TIMEOUT_MS: intFromEnv(1000, 60000, 10000),
    MAX_SYNC_MONTHS_PER_CALL: intFromEnv(1, 60, 12),
    SYNC_COOLDOWN_SECONDS: intFromEnv(0, 3600, 30),
    DEFAULT_GAME_LIMIT: intFromEnv(1, 100, 20),
  })
  .superRefine((env, ctx) => {
    const isLoopback = LOOPBACK_HOSTS.has(env.HOST);
    const restricted = env.MCP_AUTH_TOKEN !== undefined || env.MCP_ALLOWED_CLIENT_IPS.length > 0;
    if (
      !restricted &&
      !env.MCP_ALLOW_UNAUTHENTICATED &&
      (!isLoopback || env.NODE_ENV === 'production')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_AUTH_TOKEN'],
        message:
          'When NODE_ENV=production or HOST is not a loopback address, restrict /mcp with ' +
          'MCP_AUTH_TOKEN (generate one with: openssl rand -hex 32) and/or MCP_ALLOWED_CLIENT_IPS, ' +
          'or set MCP_ALLOW_UNAUTHENTICATED=true to knowingly run an open server.',
      });
    }
    if (env.MCP_ALLOW_ANY_USERNAME && !restricted && !isLoopback) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_ALLOW_ANY_USERNAME'],
        message:
          'MCP_ALLOW_ANY_USERNAME=true on a public, unrestricted server would let anyone store ' +
          "any player's games. Set MCP_AUTH_TOKEN or MCP_ALLOWED_CLIENT_IPS first.",
      });
    }
    if (!isLoopback && env.MCP_ALLOWED_HOSTS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_ALLOWED_HOSTS'],
        message:
          'MCP_ALLOWED_HOSTS is required when HOST is not a loopback address ' +
          '(comma-separated public hostnames, e.g. chess-mcp.example.com).',
      });
    }
  });

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** How /mcp is protected, for startup logs and documentation. */
export function describeAccess(config: Config): string {
  const parts: string[] = [];
  if (config.MCP_ALLOWED_CLIENT_IPS.length > 0) parts.push('client-ip-allowlist');
  if (config.MCP_AUTH_TOKEN) parts.push('bearer-token');
  return parts.length > 0 ? parts.join('+') : 'open';
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const key = issue.path.join('.') || '(root)';
        return `${key}: ${issue.message}`;
      }),
    );
  }
  return parsed.data;
}
