import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { Config } from '../config/env.js';
import { TIME_CLASSES } from '../domain/game.types.js';

function userMessage(text: string) {
  return {
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text },
      },
    ],
  };
}

/** Registers short workflow prompt templates that steer Claude through existing tools. */
export function registerWorkflowPrompts(server: McpServer, config: Config): void {
  const maxMonths = config.MAX_SYNC_MONTHS_PER_CALL;
  const defaultPlayer = config.CHESSCOM_USERNAME;

  server.registerPrompt(
    'weekly-performance-review',
    {
      title: 'Weekly performance review',
      description:
        'Review the last 7 days of results, then optionally dig into recent games. ' +
        'Uses sync → get_performance_summary → get_recent_games.',
      argsSchema: z.object({
        time_class: z
          .enum(TIME_CLASSES)
          .optional()
          .describe('Optional time class filter: daily, rapid, blitz, or bullet.'),
      }),
    },
    ({ time_class }) => {
      const filter = time_class ? ` Restrict analysis to ${time_class}.` : '';
      return userMessage(
        `Review my Chess.com performance for the last 7 days (configured player: ${defaultPlayer}).` +
          `${filter}\n\n` +
          '1. If local data may be stale or empty, call sync_chesscom_games with mode "incremental" ' +
          'and a small months value (for example 1–3).\n' +
          '2. Call get_performance_summary with period "7d"' +
          (time_class ? ` and time_class "${time_class}"` : '') +
          '.\n' +
          '3. If something looks notable (streaks, rating swing, low score), call get_recent_games ' +
          'with matching filters and a small limit to show concrete games.\n' +
          '4. Summarize results with game counts; do not invent engine analysis or coaching advice.',
      );
    },
  );

  server.registerPrompt(
    'opening-repertoire-review',
    {
      title: 'Opening repertoire review',
      description:
        'Review opening statistics by color (and optional time class). ' +
        'Uses sync → get_opening_statistics → optional get_game_details.',
      argsSchema: z.object({
        color: z
          .enum(['white', 'black', 'both'])
          .default('both')
          .describe('Which side to analyze: white, black, or both.'),
        time_class: z
          .enum(TIME_CLASSES)
          .optional()
          .describe('Optional time class filter: daily, rapid, blitz, or bullet.'),
      }),
    },
    ({ color, time_class }) => {
      const timeNote = time_class ? ` in ${time_class}` : '';
      return userMessage(
        `Review my opening repertoire as ${color}${timeNote} (configured player: ${defaultPlayer}).\n\n` +
          '1. If no games are synchronized or coverage warnings say data is stale, call ' +
          'sync_chesscom_games first (mode "incremental" for recent games, or "initial" to import ' +
          'older months).\n' +
          `2. Call get_opening_statistics with color "${color}"` +
          (time_class ? `, time_class "${time_class}"` : '') +
          ', and a sensible min_games (default 3).\n' +
          '3. Highlight best and worst openings by score percentage, noting low_sample flags.\n' +
          '4. Optionally call get_game_details for one representative game URL from get_recent_games.\n' +
          '5. Do not merge distinct ECO codes, and do not invent engine evaluations.',
      );
    },
  );

  server.registerPrompt(
    'import-history',
    {
      title: 'Import game history',
      description:
        'Import older Chess.com months with sync_chesscom_games mode "initial". ' +
        'Use when coverage is incomplete and analytics need more history.',
      argsSchema: z.object({
        // Prompt arguments arrive as strings on the wire; coerce to int.
        months: z.coerce
          .number()
          .int()
          .min(1)
          .max(maxMonths)
          .describe(
            `How many never-downloaded months to import (1–${maxMonths}). ` +
              'Call again later to continue further back.',
          ),
      }),
    },
    ({ months }) =>
      userMessage(
        `Import ${months} month(s) of older Chess.com game history for ${defaultPlayer}.\n\n` +
          `1. Call sync_chesscom_games with mode "initial" and months=${months}.\n` +
          '2. Read the report: archives_remaining says how much history is still unimported; ' +
          'status "partial" means some months failed and should be retried later.\n' +
          '3. If archives_remaining > 0 and the user wants more history, call again with mode ' +
          '"initial" (do not use "incremental" for backfill).\n' +
          '4. After import, prefer get_performance_summary or get_opening_statistics over guessing. ' +
          'Never modify the Chess.com account.',
      ),
  );
}
