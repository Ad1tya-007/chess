import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { DEFAULT_SYNC_MONTHS, type SyncService } from '../../services/sync.service.js';
import type { Logger } from '../../utils/logger.js';
import {
  formatCount,
  iso,
  isoDate,
  runTool,
  SOURCE_CHESSCOM,
  type UsernamePolicy,
  warningsOutput,
} from './shared.js';

export const syncOutput = z.object({
  username: z.string(),
  source: z.literal(SOURCE_CHESSCOM),
  generated_at: isoDate,
  sync_run_id: z.string(),
  mode: z.enum(['initial', 'incremental']),
  status: z
    .enum(['success', 'partial'])
    .describe('partial = finished, but some months failed or were not attempted.'),
  started_at: isoDate,
  finished_at: isoDate,
  months_requested: z.number().int(),
  archives_available: z.number().int().describe('Monthly archives Chess.com has for the player.'),
  archives_checked: z.number().int(),
  archives_downloaded: z.number().int(),
  archives_not_modified: z.number().int(),
  archives_failed: z.number().int(),
  archives_not_attempted: z.number().int(),
  archives_remaining: z
    .number()
    .int()
    .describe('Months never downloaded; call again with mode "initial" to import them.'),
  games_fetched: z.number().int(),
  games_inserted: z.number().int(),
  games_updated: z.number().int(),
  games_unchanged: z.number().int(),
  games_skipped: z.number().int().describe('Variants, malformed entries, or unknown results.'),
  coverage: z
    .object({ from: z.string(), to: z.string() })
    .nullable()
    .describe('Oldest and newest month (YYYY-MM) processed in this call.'),
  failures: z.array(z.object({ archive: z.string(), kind: z.string(), message: z.string() })),
  warnings: warningsOutput,
});

export function registerSyncTools(
  server: McpServer,
  sync: SyncService,
  maxMonths: number,
  users: UsernamePolicy,
  logger: Logger,
) {
  const defaultMonths = Math.min(DEFAULT_SYNC_MONTHS, maxMonths);

  server.registerTool(
    'sync_chesscom_games',
    {
      title: 'Sync Chess.com games',
      description:
        'Download monthly game archives from the public Chess.com API into the local database, ' +
        'which get_recent_games, get_game_details, get_opening_statistics, get_opening_move_tree, ' +
        'get_opponent_statistics, get_performance_summary, and get_result_breakdown read from. Use mode "incremental" ' +
        '(default) to refresh the newest months, and mode "initial" to import older history: ' +
        'each initial call imports the next batch of never-downloaded months, newest first; ' +
        'repeat while archives_remaining > 0 and more history is needed. Only writes to the ' +
        'local database; never modifies the Chess.com account. Can take tens of seconds.',
      inputSchema: z.object({
        username: users.input,
        months: z
          .number()
          .int()
          .min(1)
          .max(maxMonths)
          .optional()
          .describe(`Monthly archives to process (1-${maxMonths}, default ${defaultMonths}).`),
        mode: z
          .enum(['initial', 'incremental'])
          .optional()
          .describe('incremental (default): newest months; initial: older, unsynced months.'),
      }),
      outputSchema: syncOutput,
      annotations: {
        title: 'Sync Chess.com games',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ username, months, mode }) =>
      runTool(logger, 'sync_chesscom_games', async () => {
        const requested = users.check(username);
        const report = await sync.sync({
          ...(requested !== undefined ? { username: requested } : {}),
          ...(months !== undefined ? { months } : {}),
          ...(mode !== undefined ? { mode } : {}),
        });
        const data: z.infer<typeof syncOutput> = {
          username: report.username,
          source: SOURCE_CHESSCOM,
          generated_at: iso(new Date()),
          sync_run_id: report.syncRunId,
          mode: report.mode,
          status: report.status,
          started_at: iso(report.startedAt),
          finished_at: iso(report.finishedAt),
          months_requested: report.monthsRequested,
          archives_available: report.archivesAvailable,
          archives_checked: report.archivesChecked,
          archives_downloaded: report.archivesDownloaded,
          archives_not_modified: report.archivesNotModified,
          archives_failed: report.archivesFailed,
          archives_not_attempted: report.archivesNotAttempted,
          archives_remaining: report.archivesRemaining,
          games_fetched: report.gamesFetched,
          games_inserted: report.gamesInserted,
          games_updated: report.gamesUpdated,
          games_unchanged: report.gamesUnchanged,
          games_skipped: report.gamesSkipped,
          coverage: report.coverage,
          failures: report.failures,
          warnings: report.warnings,
        };
        const range = report.coverage ? ` (${report.coverage.from} to ${report.coverage.to})` : '';
        const failed =
          report.archivesFailed > 0 ? ` ${report.archivesFailed} month(s) failed.` : '';
        return {
          summary:
            `Sync ${report.status} for ${report.username} (${report.mode}): checked ` +
            `${report.archivesChecked} month(s)${range}, ${formatCount(report.gamesInserted)} new ` +
            `and ${formatCount(report.gamesUpdated)} updated games.${failed} ` +
            `${report.archivesRemaining} older month(s) not yet imported.`,
          data,
        };
      }),
  );
}
