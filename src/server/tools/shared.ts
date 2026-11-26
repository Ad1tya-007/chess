import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Config } from '../../config/env.js';
import type { OpeningStat, ResultSummary } from '../../domain/analytics.types.js';
import { TIME_CLASSES } from '../../domain/game.types.js';
import type { LocalDataStatus } from '../../services/local-data.service.js';
import { CHESSCOM_USERNAME_PATTERN } from '../../utils/chesscom-username.js';
import { AppError, ChessComApiError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';

export const SOURCE_CHESSCOM = 'chesscom_pubapi';
export const SOURCE_LOCAL = 'local_database';

export const DEFINITIONS = {
  win_rate: 'wins / games * 100 (draws and losses are not wins), one decimal; null if no games',
  score_percentage: '(wins + 0.5 * draws) / games * 100, one decimal; null if no games',
};

// --- Inputs -----------------------------------------------------------------------------------

const usernameSchema = z
  .string()
  .regex(CHESSCOM_USERNAME_PATTERN, 'Chess.com usernames use letters, digits, "_" and "-".');

/** Which Chess.com usernames the tools serve (MCP_ALLOW_ANY_USERNAME). */
export interface UsernamePolicy {
  input: z.ZodOptional<z.ZodString>;
  /** Returns the username to use (undefined = configured default); throws if not allowed. */
  check(username: string | undefined): string | undefined;
}

export function createUsernamePolicy(
  config: Pick<Config, 'CHESSCOM_USERNAME' | 'MCP_ALLOW_ANY_USERNAME'>,
): UsernamePolicy {
  const configured = config.CHESSCOM_USERNAME;
  if (config.MCP_ALLOW_ANY_USERNAME) {
    return {
      input: usernameSchema
        .optional()
        .describe(`Chess.com username. Defaults to the configured player ("${configured}").`),
      check: (username) => username,
    };
  }
  return {
    input: usernameSchema
      .optional()
      .describe(`Optional. This server only serves the Chess.com player "${configured}".`),
    check(username) {
      if (username === undefined || username.trim().toLowerCase() === configured) return username;
      throw new AppError(
        'username_not_allowed',
        `This server only serves Chess.com data for "${configured}". Omit username to use it.`,
      );
    },
  };
}

export const timeClassInput = z
  .enum(TIME_CLASSES)
  .optional()
  .describe('Restrict to one time class: daily, rapid, blitz, or bullet.');

/** Omit to include rated, unrated, and null-rated games (default). */
export const ratedInput = z
  .boolean()
  .optional()
  .describe(
    'When true, only rated games; when false, only unrated. Omit to include both (default).',
  );

export const opponentInput = usernameSchema
  .optional()
  .describe('Exact opponent username match (case-insensitive).');

export const timeControlInput = z
  .string()
  .min(1)
  .max(50)
  .optional()
  .describe('Exact Chess.com time_control string, e.g. "600" or "180+2".');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const dateInput = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .describe('YYYY-MM-DD (UTC) or an ISO 8601 date-time with timezone.');

export const fromDateInput = dateInput
  .optional()
  .describe('Inclusive start: YYYY-MM-DD (UTC start of day) or ISO 8601 date-time.');
export const toDateInput = dateInput
  .optional()
  .describe('Inclusive end: YYYY-MM-DD (includes that whole UTC day) or ISO 8601 date-time.');

/** Inclusive lower bound. */
export function parseFromDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
}

/** Converts an inclusive end date into the exclusive upper bound used by queries. */
export function parseToDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  if (DATE_ONLY.test(value)) return new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000);
  return new Date(Date.parse(value) + 1);
}

// --- Output building blocks -------------------------------------------------------------------

export const isoDate = z.string().describe('ISO 8601 timestamp');
export const nullableIsoDate = isoDate.nullable();

export function iso(date: Date): string;
export function iso(date: Date | null): string | null;
export function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export const warningsOutput = z
  .array(z.string())
  .describe('Data-quality notes: empty, stale, partial, or truncated data.');

export const resultSummaryOutput = z.object({
  games: z.number().int(),
  wins: z.number().int(),
  losses: z.number().int(),
  draws: z.number().int(),
  win_rate: z.number().nullable(),
  score_percentage: z.number().nullable(),
});

export function resultSummaryWire(summary: ResultSummary): z.infer<typeof resultSummaryOutput> {
  return {
    games: summary.games,
    wins: summary.wins,
    losses: summary.losses,
    draws: summary.draws,
    win_rate: summary.winRate,
    score_percentage: summary.scorePercentage,
  };
}

export const openingOutput = resultSummaryOutput.extend({
  eco: z.string().nullable(),
  opening_name: z.string().nullable(),
  low_sample: z.boolean(),
  first_played_at: isoDate,
  last_played_at: isoDate,
});

export function openingWire(opening: OpeningStat): z.infer<typeof openingOutput> {
  return {
    eco: opening.eco,
    opening_name: opening.openingName,
    ...resultSummaryWire(opening),
    low_sample: opening.lowSample,
    first_played_at: iso(opening.firstPlayedAt),
    last_played_at: iso(opening.lastPlayedAt),
  };
}

export const dataCoverageOutput = z
  .object({
    games_stored: z.number().int(),
    first_game_at: nullableIsoDate,
    last_game_at: nullableIsoDate,
    synced_months: z.number().int(),
    earliest_synced_month: z.string().nullable(),
    latest_synced_month: z.string().nullable(),
    last_successful_sync_at: nullableIsoDate,
    last_sync: z
      .object({
        status: z.enum(['running', 'success', 'failed']),
        partial: z.boolean(),
        started_at: isoDate,
        finished_at: nullableIsoDate,
      })
      .nullable(),
  })
  .describe('What is synchronized in the local database for this player.');

export function dataCoverageWire(local: LocalDataStatus): z.infer<typeof dataCoverageOutput> {
  return {
    games_stored: local.gamesStored,
    first_game_at: iso(local.firstGameAt),
    last_game_at: iso(local.lastGameAt),
    synced_months: local.syncedMonths,
    earliest_synced_month: local.earliestSyncedMonth,
    latest_synced_month: local.latestSyncedMonth,
    last_successful_sync_at: iso(local.lastSuccessfulSyncAt),
    last_sync: local.lastSync
      ? {
          status: local.lastSync.status,
          partial: local.lastSync.partial,
          started_at: iso(local.lastSync.startedAt),
          finished_at: iso(local.lastSync.finishedAt),
        }
      : null,
  };
}

// --- Execution --------------------------------------------------------------------------------

export interface ToolOutput {
  /** One or two sentences for humans; the structured data carries the details. */
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Runs a tool body and shapes the MCP result: a short summary, the JSON (for clients that ignore
 * structuredContent), and structuredContent. Errors become `isError` results; only AppError
 * messages (written to be client-safe) are shown, everything else is replaced by a generic text.
 */
export async function runTool(
  logger: Logger,
  tool: string,
  body: () => Promise<ToolOutput>,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  try {
    const { summary, data } = await body();
    logger.info({ tool, durationMs: Math.round(performance.now() - startedAt) }, 'Tool completed');
    return {
      content: [
        { type: 'text', text: summary },
        { type: 'text', text: JSON.stringify(data) },
      ],
      structuredContent: data,
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    if (error instanceof AppError) {
      logger.warn({ tool, durationMs, code: error.code }, 'Tool returned an error');
      return toolError(error.code, describeAppError(error));
    }
    logger.error(
      { tool, durationMs, err: { message: (error as Error)?.message } },
      'Tool failed unexpectedly',
    );
    return toolError('internal_error', `Internal error while running ${tool}. Try again later.`);
  }
}

function describeAppError(error: AppError): string {
  if (error instanceof ChessComApiError && error.retryable) {
    const wait = error.details.retryAfterSeconds;
    return `${error.message} This is usually temporary; try again${wait ? ` in about ${wait} seconds` : ' later'}.`;
  }
  return error.message;
}

function toolError(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error (${code}): ${message}` }],
    isError: true,
  };
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value}%`;
}
